import AVFoundation
import SwiftUI

/// The camera, looking for one QR code.
///
/// In the app rather than through the Camera app on purpose. Scanning a
/// `soloops://` code outside the app means Camera hands it to Safari, Safari
/// decides whether a custom scheme may open an app, and that decision depends
/// on how the link was reached. Here there is nothing in between: the code is
/// read and handed straight to pairing.
struct QrScanner: UIViewControllerRepresentable {
    /// Called once, on the main actor, with the first code that parses.
    let onFound: (String) -> Void

    func makeUIViewController(context: Context) -> QrScannerController {
        let controller = QrScannerController()
        controller.onFound = onFound
        return controller
    }

    func updateUIViewController(_ controller: QrScannerController, context: Context) {
        controller.onFound = onFound
    }
}

final class QrScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onFound: ((String) -> Void)?

    /// `nonisolated(unsafe)` for the same reason as the formatters in Op.swift:
    /// the type is not Sendable and the safety comes from use, not the compiler.
    /// Every call on it happens on `queue` below — Apple's own rule for capture
    /// sessions, because configuring one blocks and must stay off the main
    /// thread. Nothing else ever touches it.
    nonisolated(unsafe) private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "com.soloops.app.scanner")

    private var preview: AVCaptureVideoPreviewLayer?
    /// A QR code is read many times a second. The first one wins and the rest
    /// are dropped, otherwise pairing fires again while it is already running.
    private var handled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview

        queue.async { [weak self] in self?.configure() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        queue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    private nonisolated func configure() {
        session.beginConfiguration()
        defer {
            session.commitConfiguration()
            if !session.isRunning { session.startRunning() }
        }

        guard
            let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
            let input = try? AVCaptureDeviceInput(device: camera),
            session.canAddInput(input)
        else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)

        // The delegate is called on the main queue, so the handler below runs
        // where SwiftUI expects it. Setting the types has to come after
        // addOutput — before it, the list of what the output supports is empty.
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
    }

    nonisolated func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput objects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        // Read the string out here, where the delegate call actually is. Only
        // that crosses to the main actor — the metadata objects themselves are
        // not Sendable and must not be handed anywhere.
        guard
            let object = objects.first as? AVMetadataMachineReadableCodeObject,
            let value = object.stringValue
        else { return }

        // The output was given `.main` as its queue, so this is already the
        // main thread and the assumption is checked rather than taken on faith.
        MainActor.assumeIsolated {
            guard !handled else { return }
            handled = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onFound?(value)
        }
    }
}
