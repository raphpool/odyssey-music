// swift-tools-version: 6.0

import PackageDescription

let package = Package(
	name: "Track1Core",
	// macOS is here so `swift test` runs the pure logic on the host without a simulator; 14 because the
	// Observation-based layers moved here later require it.
	platforms: [.iOS(.v17), .macOS(.v14)],
	products: [
		.library(name: "Track1Core", targets: ["Track1Core"])
	],
	targets: [
		.target(name: "Track1Core"),
		.testTarget(name: "Track1CoreTests", dependencies: ["Track1Core"]),
	]
)
