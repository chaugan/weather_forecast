// swift-tools-version: 6.2
// GlettKit: Glett's platform-agnostic core (networking, forecast engine, models). No UI.
import PackageDescription

let package = Package(
    name: "GlettKit",
    defaultLocalization: "nb",
    platforms: [.iOS(.v18), .watchOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "GlettKit", targets: ["GlettKit"]),
    ],
    targets: [
        .target(name: "GlettKit"),
        .testTarget(
            name: "GlettKitTests",
            dependencies: ["GlettKit"],
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
