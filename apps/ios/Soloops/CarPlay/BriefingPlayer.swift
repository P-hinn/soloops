import AVFoundation
import MediaPlayer
import SoloopsKit

/// Reading the day out loud, as audio the car understands.
///
/// Speech rather than a screen, because this is the only form a driver can
/// safely take in. That it is speech and not music is also what makes the
/// `audio` CarPlay category honest: the app's content *is* audio, the lists
/// are how you pick which bit of it to hear.
///
/// Two things have to be right for CarPlay to treat it as a real player: the
/// audio session has to be configured for playback, and
/// `MPNowPlayingInfoCenter` has to describe what is playing — otherwise the
/// Now Playing template comes up blank and the steering-wheel controls do
/// nothing.
@MainActor
final class BriefingPlayer: NSObject {
    static let shared = BriefingPlayer()

    private let synthesiser = AVSpeechSynthesizer()
    private var currentTitle = ""
    private var currentSubtitle = ""
    /// Roughly how long the current text takes, for the progress bar.
    private var estimatedDuration: TimeInterval = 0
    private var startedAt: Date?

    override private init() {
        super.init()
        synthesiser.delegate = self
        configureRemoteCommands()
    }

    var isSpeaking: Bool { synthesiser.isSpeaking }

    // --- Playback ----------------------------------------------------------

    func speak(_ text: String, title: String, subtitle: String) {
        guard !text.isEmpty else { return }

        // Stop first: queuing a second briefing on top of the first is never
        // what was meant by tapping the row again.
        if synthesiser.isSpeaking {
            synthesiser.stopSpeaking(at: .immediate)
        }

        activateSession()

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.germanVoice()
        // A touch slower than the default. The default is tuned for reading a
        // notification, not for taking in six appointments at once.
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
        utterance.postUtteranceDelay = 0

        currentTitle = title
        currentSubtitle = subtitle
        // ~14 characters a second at this rate, which is close enough for a
        // progress bar nobody is timing.
        estimatedDuration = Double(text.count) / 14
        startedAt = Date()

        synthesiser.speak(utterance)
        updateNowPlaying(rate: 1)
    }

    func stop() {
        synthesiser.stopSpeaking(at: .immediate)
        startedAt = nil
        updateNowPlaying(rate: 0)
        deactivateSession()
    }

    // --- Audio session -----------------------------------------------------

    /// `.spokenAudio` with `.duckOthers`.
    ///
    /// Ducking rather than interrupting, so the radio comes back by itself
    /// afterwards; `.spokenAudio` tells the system this is speech, which is
    /// what makes it behave sensibly against navigation prompts.
    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true, options: [])
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(
            false, options: [.notifyOthersOnDeactivation])
    }

    // --- Now Playing -------------------------------------------------------

    private func updateNowPlaying(rate: Double) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: currentTitle,
            MPMediaItemPropertyArtist: currentSubtitle,
            MPMediaItemPropertyAlbumTitle: "soloops",
            MPNowPlayingInfoPropertyPlaybackRate: rate,
            MPMediaItemPropertyPlaybackDuration: estimatedDuration,
        ]
        if let startedAt {
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = min(
                Date().timeIntervalSince(startedAt), estimatedDuration)
        } else {
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = 0
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState = rate > 0 ? .playing : .paused
    }

    /// The wheel and dashboard buttons.
    ///
    /// Only the ones that mean something here. Leaving next/previous enabled
    /// but unhandled gives a driver a button that does nothing, which is worse
    /// than a button that is not there.
    private func configureRemoteCommands() {
        let centre = MPRemoteCommandCenter.shared()

        centre.playCommand.isEnabled = true
        centre.playCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            if synthesiser.isPaused {
                synthesiser.continueSpeaking()
                updateNowPlaying(rate: 1)
                return .success
            }
            return .noActionableNowPlayingItem
        }

        centre.pauseCommand.isEnabled = true
        centre.pauseCommand.addTarget { [weak self] _ in
            guard let self, synthesiser.isSpeaking else { return .commandFailed }
            synthesiser.pauseSpeaking(at: .word)
            updateNowPlaying(rate: 0)
            return .success
        }

        centre.stopCommand.isEnabled = true
        centre.stopCommand.addTarget { [weak self] _ in
            self?.stop()
            return .success
        }

        centre.nextTrackCommand.isEnabled = false
        centre.previousTrackCommand.isEnabled = false
    }

    /// A German voice if the phone has one.
    ///
    /// Falling back to the default is better than refusing: an English voice
    /// reading German appointment titles is poor, silence is useless.
    private static func germanVoice() -> AVSpeechSynthesisVoice? {
        let voices = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language.hasPrefix("de")
        }
        // Enhanced and premium voices are a noticeable difference over a car
        // speaker, so prefer them when the user has downloaded one.
        if let better = voices.first(where: { $0.quality != .default }) { return better }
        return voices.first ?? AVSpeechSynthesisVoice(language: "de-DE")
    }
}

extension BriefingPlayer: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in
            startedAt = nil
            updateNowPlaying(rate: 0)
            deactivateSession()
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in
            startedAt = nil
            updateNowPlaying(rate: 0)
        }
    }
}
