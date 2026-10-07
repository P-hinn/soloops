import SoloopsKit
import SwiftUI

/// The app, in two scenes.
///
/// The phone window and the CarPlay screen are separate scenes of one process.
/// The CarPlay one is not declared here but in `Info.plist`, because the
/// system creates it and only when the entitlement allows — see
/// `CarPlaySceneDelegate`.
@main
struct SoloopsApp: App {
    @State private var environment = AppEnvironment.shared
    /// Sync when the app comes forward. Not on a timer: a phone app that polls
    /// in the background is a phone app that gets killed for it.
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(environment)
                .onOpenURL { url in
                    // The pairing QR code opens the app with the invitation in
                    // it, so scanning with the camera is enough and nobody has
                    // to type an address.
                    guard let invitation = Pairing.Invitation(url: url) else { return }
                    Task { await environment.pair(with: invitation) }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await environment.sync() }
        }
    }
}

struct RootView: View {
    @Environment(AppEnvironment.self) private var environment

    var body: some View {
        switch environment.state {
        case .needsPairing:
            PairingView()
        case .broken(let message):
            ContentUnavailableView(
                "Etwas ist kaputt",
                systemImage: "exclamationmark.triangle",
                description: Text(message)
            )
        case .ready:
            MainView()
        }
    }
}
