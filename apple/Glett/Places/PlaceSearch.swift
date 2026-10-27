import GlettKit
import SwiftUI

/// What the search field on Været opens (owner's review, 2026-10-27): the places sheet as before, the field itself with
/// the hits under it as the web's, a sheet with the search alone, or the search alone over the whole screen.
enum PlaceSearchStyle: String {
    case places, inline, sheet, cover

    static var current: PlaceSearchStyle {
        #if DEBUG
        if let s = UserDefaults.standard.string(forKey: "GlettSearch"), let v = PlaceSearchStyle(rawValue: s) { return v }
        #endif
        return .places
    }
}

/// The place search as you type (Open-Meteo, as the forecast page's search): the query, its hits, and whether it is
/// still looking. The view that owns it runs `run(_:)` in `.task(id: query)`.
@MainActor @Observable
final class PlaceSearch {
    /// `SEARCH_DEBOUNCE` of the web's place search (GlettKit API.md: 350 ms, 2 characters).
    static let debounce: Duration = .milliseconds(350)
    static let minQuery = 2

    var query = ""
    private(set) var hits: [PlaceHit] = []
    private(set) var error: String?
    /// The query the hits answer (nil while the first answer is on its way).
    private(set) var answered: String?

    init() {
        #if DEBUG
        query = UserDefaults.standard.string(forKey: "GlettSearchQuery") ?? ""
        #endif
    }

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }
    /// Long enough to search: the hits are shown instead of what is there without a search.
    var active: Bool { trimmed.count >= Self.minQuery }
    var waiting: Bool { active && error == nil && answered != trimmed }

    func run(_ model: AppModel) async {
        let q = trimmed
        guard q.count >= Self.minQuery else { hits = []; error = nil; answered = nil; return }
        do { try await Task.sleep(for: Self.debounce) } catch { return }
        do {
            let r = try await model.service.search(q, lang: model.lang)
            guard !Task.isCancelled else { return }
            hits = r
            error = nil
            answered = q
        } catch let e as GlettError {
            guard !Task.isCancelled else { return }
            hits = []
            error = e.verbatim ?? L10n.t(e.l10nKey, e.l10nArgs)
        } catch {
            return
        }
    }
}

/// The hits as rows: in a list, or (`card`) padded with lines between them for a card of their own.
struct PlaceSearchRows: View {
    let search: PlaceSearch
    var card = false
    let pick: (Place) -> Void

    var body: some View {
        if search.hits.isEmpty {
            Group {
                if let e = search.error {
                    Text(verbatim: e).foregroundStyle(.glett.bad)
                } else if search.waiting {
                    HStack { ProgressView(); Spacer() }
                } else {
                    Text(verbatim: L10n.t("search.none")).foregroundStyle(.glett.muted)
                }
            }
            .padding(card ? 14 : 0)
        }
        ForEach(Array(search.hits.enumerated()), id: \.element.id) { i, hit in
            Button { pick(hit.place()) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: hit.placeName).foregroundStyle(.glett.text)
                    Text(verbatim: hit.sub ?? hit.name).font(.caption).foregroundStyle(.glett.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, card ? 14 : 0)
                .padding(.vertical, card ? 10 : 0)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .overlay(alignment: .top) { if card && i > 0 { Divider().padding(.leading, 14) } }
        }
    }
}

/// The field as the web's (`.pb-search`): the magnifier, the prompt, a clear button while there is text.
private struct PlaceSearchBox: View {
    @Bindable var search: PlaceSearch
    var focused: FocusState<Bool>.Binding
    let submit: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.glett.muted)
            TextField(text: $search.query, prompt: Text(verbatim: L10n.t("pb.search")).foregroundStyle(.glett.muted)) {
                Text(verbatim: L10n.t("pb.search"))
            }
            .focused(focused)
            .autocorrectionDisabled()
            .submitLabel(.search)
            .onSubmit(submit)
            if !search.query.isEmpty {
                Button { search.query = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain)
                    .foregroundStyle(.glett.muted)
                    .accessibilityLabel(Text(verbatim: L10n.t("h.close")))
            }
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: 40)
        .background(Color.glett.panel, in: .rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(focused.wrappedValue ? Color.glett.accent : Color.glett.line, lineWidth: focused.wrappedValue ? 2 : 1)
        }
    }
}

/// `PlaceSearchStyle.inline`: the field on Været takes the typing, and the hits drop down under it over the page, as
/// the web's `#pbResults`.
struct PlaceSearchField: View {
    let model: AppModel
    @State private var search = PlaceSearch()
    @FocusState private var focused: Bool

    var body: some View {
        PlaceSearchBox(search: search, focused: $focused) { if let h = search.hits.first { pick(h.place()) } }
            .overlay(alignment: .topLeading) {
                if focused && search.active {
                    VStack(alignment: .leading, spacing: 0) {
                        PlaceSearchRows(search: search, card: true) { pick($0) }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .background(Color.glett.panel, in: .rect(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.glett.line))
                    .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
                    .offset(y: 46)
                }
            }
            .task(id: search.query) { await search.run(model) }
            .onAppear { if model.navigation.searchFocused { focused = true } }
            .onChange(of: model.navigation.searchFocused) { _, on in if on { focused = true } }
            .onChange(of: focused) { _, on in if model.navigation.searchFocused != on { model.navigation.searchFocused = on } }
    }

    private func pick(_ p: Place) {
        model.select(p, recent: true)
        search.query = ""
        focused = false
    }
}

/// `PlaceSearchStyle.sheet`: a sheet with the search field alone, the hits under it as you type.
struct PlaceSearchSheet: View {
    let model: AppModel
    @State private var search = PlaceSearch()
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            List {
                if search.active { PlaceSearchRows(search: search) { pick($0) } }
            }
            .navigationTitle(Text(verbatim: ""))
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search.query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text(verbatim: L10n.t("pb.search")))
            .searchFocused($focused)
            .autocorrectionDisabled()
            .onSubmit(of: .search) { if let h = search.hits.first { pick(h.place()) } }
            .task(id: search.query) { await search.run(model) }
            .onAppear { focused = true }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { SheetCloseButton() } }
        }
        .glettSheet()
    }

    private func pick(_ p: Place) {
        model.select(p, recent: true)
        model.navigation.sheet = nil
    }
}

/// `PlaceSearchStyle.cover`: the search over the whole screen, the field at the top with "Avbryt" beside it.
struct PlaceSearchCover: View {
    let model: AppModel
    @State private var search = PlaceSearch()
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                PlaceSearchBox(search: search, focused: $focused) { if let h = search.hits.first { pick(h.place()) } }
                Button { dismiss() } label: { Text(verbatim: L10n.t("kv.dlg.cancel")) }
                    .tint(.glett.accent)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            ScrollView {
                if search.active {
                    VStack(alignment: .leading, spacing: 0) {
                        PlaceSearchRows(search: search, card: true) { pick($0) }
                    }
                    .background(Color.glett.panel, in: .rect(cornerRadius: GlettMetrics.cardRadius))
                    .padding(16)
                }
            }
            .scrollDismissesKeyboard(.immediately)
        }
        .background(Color.glett.bg.ignoresSafeArea())
        .task(id: search.query) { await search.run(model) }
        .onAppear { focused = true }
    }

    private func pick(_ p: Place) {
        model.select(p, recent: true)
        dismiss()
    }
}
