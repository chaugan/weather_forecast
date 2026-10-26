import CryptoKit
import Foundation
import Testing

/// Are the fixtures still the web's? `expected/sources.json` holds the sha256 of the JS they were made from. A changed
/// file does not mean the maths changed (app.js changes often), so a mismatch is a known issue, not a failure, unless
/// `GLETT_STRICT_FIXTURES=1`. Then run `node apple/scripts/fixtures.mjs` and see whether the golden tests still pass.
@Suite("Golden sources") struct GoldenSourcesTests {
    struct Sources: Decodable { var js: [String: String]; var pieces: [String: String] }

    /// The repository's `js/` folder, found from this file (apple/GlettKit/Tests/GlettKitTests/…).
    static let jsFolder: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("js", isDirectory: true)

    static let strict = ProcessInfo.processInfo.environment["GLETT_STRICT_FIXTURES"] == "1"

    @Test(.enabled(if: FileManager.default.fileExists(atPath: jsFolder.path), "the web's js/ is not next to the package"))
    func webJSUnchanged() throws {
        let s = try Golden.decode(Sources.self, "sources", "expected")
        #expect(Set(s.js.keys) == ["app.js", "data.js", "icons.js"])
        #expect(!s.pieces.isEmpty)
        for (name, want) in s.js.sorted(by: { $0.key < $1.key }) {
            let data = try Data(contentsOf: Self.jsFolder.appendingPathComponent(name))
            let got = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            if Self.strict {
                #expect(got == want, "js/\(name) changed since the fixtures were made: run node apple/scripts/fixtures.mjs")
            } else {
                withKnownIssue("js/\(name) changed since the fixtures were made: run node apple/scripts/fixtures.mjs", isIntermittent: true) {
                    #expect(got == want)
                }
            }
        }
    }
}
