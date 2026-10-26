import Testing
@testable import GlettKit

@Test func siteURL() {
    #expect(GlettKit.siteURL.host == "glett.no")
}
