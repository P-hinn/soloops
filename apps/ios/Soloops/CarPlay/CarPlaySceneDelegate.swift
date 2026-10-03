import CarPlay
import SoloopsKit
import UIKit

/// soloops as its own icon on the CarPlay home screen.
///
/// What makes the icon appear is not this file but an entitlement Apple grants
/// per app, declared in `Soloops.entitlements` and named in
/// `CarPlayConfiguration` below. Without it the scene below is never created —
/// not on a real head unit and not in Xcode's CarPlay simulator. There is no
/// way around that, so the app is built to be useful on the phone either way
/// and to light up in the car once the entitlement is in the provisioning
/// profile.
///
/// The category is `audio`, which shapes the interface rather than limiting
/// it: the day is read aloud and the templates are the browsing list in front
/// of that. For a driver that is the right way round anyway — a list you read
/// at 80 km/h is a list you should not have been reading.
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?
    private var interface: CarPlayInterface?

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController

        let interface = CarPlayInterface(
            controller: interfaceController,
            environment: AppEnvironment.shared,
            player: BriefingPlayer.shared
        )
        self.interface = interface
        interface.install()

        // Getting in is the moment a drive starts. The clock runs from here;
        // what it becomes is decided on disconnect — see CarPlayTravel.
        CarPlayTravel.shared.didConnect(at: Date())

        // Sync on connect, because the car is usually where the phone has
        // been out of reach of the Mac for a while, and an agenda from
        // yesterday evening is the one thing this must not show.
        Task { await AppEnvironment.shared.sync() }
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        BriefingPlayer.shared.stop()
        CarPlayTravel.shared.didDisconnect(at: Date())
        self.interface = nil
        self.interfaceController = nil
    }
}

/// The CarPlay entitlement this app is built against.
///
/// In one place so that switching category is a one-line change here plus the
/// matching key in `Soloops.entitlements`. The two have to agree: the scene
/// manifest in `Info.plist` names the delegate, the entitlement decides
/// whether the system ever asks for it.
enum CarPlayConfiguration {
    /// `audio` is the category with a realistic chance of being granted, and
    /// the one whose allowed templates — list, tab bar, now playing — match a
    /// spoken daily briefing.
    ///
    /// `com.apple.developer.carplay-driving-task` would describe an agenda
    /// more literally and is granted far more narrowly, mostly to vehicle
    /// makers. If it is ever granted, change the key in the entitlements file
    /// and `CarPlayInterface` keeps working: the templates used here are
    /// permitted in both categories.
    static let entitlement = "com.apple.developer.carplay-audio"

    /// Request form: https://developer.apple.com/contact/carplay/
    static let requestURL = URL(string: "https://developer.apple.com/contact/carplay/")!
}
