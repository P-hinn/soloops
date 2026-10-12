// swift-tools-version: 6.0
import PackageDescription

/// The sync engine, as a library.
///
/// Separate from the app target for one reason: it can be tested on the Mac
/// with `swift test`, without a simulator and without a signed build. The
/// rules in here have to agree with the API's to the letter — a client that
/// orders stamps differently or resolves a conflict differently does not
/// fail, it diverges quietly — so they are the part that needs tests most.
///
/// No dependencies. SQLite comes from the system library, which keeps the
/// phone app free of a package graph it would otherwise have to carry.
let package = Package(
    name: "SoloopsKit",
    // 15.4/18.4 rather than 14/18 only because `Store` needs an `isolated
    // deinit` to close the SQLite handle inside its actor; the alternative is
    // `nonisolated(unsafe)` on the handle, which turns the check off for good.
    // Both floors are long past on any device that runs this.
    platforms: [.iOS("18.4"), .macOS("15.4")],
    products: [
        .library(name: "SoloopsKit", targets: ["SoloopsKit"])
    ],
    targets: [
        .target(name: "SoloopsKit", linkerSettings: [.linkedLibrary("sqlite3")]),
        .testTarget(
            name: "SoloopsKitTests",
            dependencies: ["SoloopsKit"],
            // The registry the API generates. Bundled so the parity test can
            // read it — see scripts/exportSyncRegistry.ts.
            resources: [.copy("Fixtures/registry.json")]
        ),
    ]
)
