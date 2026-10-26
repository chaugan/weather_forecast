import Foundation

/// The HTML texts of the about screen, cut into the pieces the screen shows as cards.
enum AboutContent {
    struct Section: Identifiable {
        let id: Int
        /// The `<h3>` heading; nil for the lead.
        let title: String?
        /// The section's HTML without its heading.
        let html: String
    }

    /// `about.html` (js/i18n.js:9) by its `<h3>` headings, without the `<h2>` (the screen's title says it). The
    /// Kjørevær section is left out while the app has no Kjørevær (brief §7.1, phase 3).
    static func aboutSections() -> [Section] {
        var html = L10n.t("about.html")
        if let r = html.range(of: #"<h2[^>]*>.*?</h2>"#, options: .regularExpression) { html.removeSubrange(r) }
        let parts = html.components(separatedBy: "<h3>")
        var out: [Section] = []
        for (i, part) in parts.enumerated() {
            if i == 0 {
                if !part.trimmingCharacters(in: .whitespaces).isEmpty { out.append(.init(id: 0, title: nil, html: part)) }
                continue
            }
            let head = part.components(separatedBy: "</h3>")
            let title = String(SimpleHTML.attributed(head[0]).characters)
            if title == L10n.t("kv.title") { continue }
            out.append(.init(id: i, title: title, html: head.dropFirst().joined(separator: "</h3>")))
        }
        return out
    }

    /// `footer.html` (js/i18n.js:31) split where the web breaks the line: the credits, then the terms (model agreement,
    /// not an official forecast; free, no ads; WeFo). The terms stop before the web's privacy link: the screen has its
    /// own privacy card, and what follows the link credits a figure in the web's shadow map, which the app does not have.
    static func footerParts() -> (credits: String, terms: String) {
        let parts = L10n.t("footer.html").components(separatedBy: "<br>")
        var terms = parts.dropFirst().joined(separator: "<br>")
        if let r = terms.range(of: #"<a href="privacy.html""#) { terms = String(terms[..<r.lowerBound]) }
        return (parts.first ?? "", terms.trimmingCharacters(in: .whitespaces))
    }

    /// glett.no's privacy page.
    static let privacyURL = URL(string: "https://glett.no/privacy.html")!
}
