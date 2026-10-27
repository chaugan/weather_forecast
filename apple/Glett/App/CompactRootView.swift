import GlettKit
import SwiftUI

/// Compact width (iPhone, closed iPhone Duo): one column like the web on a phone — place, now card, the days, then
/// the hours and the rest — under the place's name as a heading with the gear beside it. The heading is the page's own,
/// not the bar's large title, so a long name can take two lines, broken between words and cut at the end of the
/// second (owner, 2026-10-27); the bar shows once it has scrolled away, with `MiniNow`.
struct CompactRootView: View {
    let model: AppModel
    /// Finished pulls to refresh (the haptic's trigger).
    @State private var refreshes = 0
    /// The place heading is on screen; when it is not, the top bar shows `MiniNow` (the web's header summary).
    @State private var headingVisible = true

    /// The scroll anchor of the hour section.
    static let hoursAnchor = "hours"
    static let daysAnchor = "days"
    static let topAnchor = "top"

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: GlettMetrics.cardSpacing) {
                        if let p = model.place {
                            heading(p)
                                .id(Self.topAnchor)
                                .onScrollVisibilityChange(threshold: 0.3) { v in withAnimation(.easeOut(duration: 0.18)) { headingVisible = v } }
                        }
                        PlaceChips(model: model).id(model.place == nil ? Self.topAnchor : "chips")
                            .zIndex(1)   // the inline search's hits drop down over the cards
                        if model.place == nil {
                            EmptyForecastView(model: model)
                        } else {
                            PlaceHeader(model: model)
                            ForecastStatusView(model: model)
                            WarningsBanner(model: model)
                            if let e = model.engine {
                                NowCard(model: model, engine: e)
                                DaysList(model: model, engine: e).id(Self.daysAnchor)
                                HoursSection(model: model).id(Self.hoursAnchor)
                                ModelsLink(model: model)
                            }
                        }
                        DisclaimerFooter(model: model)
                    }
                    .glettPage()
                }
                .glettPageBackground()
                .softTopEdge()
                .scrollDismissesKeyboard(.immediately)
                .refreshable { @MainActor in
                    await model.refresh()
                    refreshes += 1
                }
                .toolbar {
                    if !headingVisible, let p = model.place, let now = model.engine?.nowSummary() {
                        ToolbarItem(placement: .principal) {
                            MiniNow(place: p, now: now) { withAnimation { proxy.scrollTo(Self.topAnchor, anchor: .top) } }
                        }
                    }
                }
                .onChange(of: model.scrollToHours) { _, go in scroll(go, proxy) }
                .onChange(of: model.engine != nil) { _, _ in
                    scroll(model.scrollToHours, proxy)
                    if model.scrollToDays { proxy.scrollTo(Self.daysAnchor, anchor: .top); model.scrollToDays = false }
                }
            }
            .navigationTitle(Text(verbatim: model.place == nil ? L10n.t("nav.forecast") : ""))
            .toolbarTitleDisplayMode(model.place == nil ? .inlineLarge : .inline)
            .toolbar { AppToolbar(model: model) }
            // the heading carries the name and the gear while it is on screen: no bar over it
            .toolbarVisibility(model.place != nil && headingVisible ? .hidden : .visible, for: .navigationBar)
        }
        .glettHaptic(.refresh, trigger: refreshes)
    }

    /// The place's name, up to two lines (SwiftUI breaks between words; a single word too long for a line is the only
    /// thing it splits), cut at the end of the second; the gear beside its first line, as in the bar.
    private func heading(_ p: Place) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(verbatim: p.name)
                .font(.largeTitle.bold())
                .foregroundStyle(.glett.text)
                .lineLimit(2)
                .truncationMode(.tail)
                .multilineTextAlignment(.leading)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            Button { model.present(.settings) } label: {
                Image(systemName: "gearshape")
                    .font(.title3)
                    .frame(width: 30, height: 30)
                    .accessibilityLabel(Text(verbatim: L10n.t("tb.settings")))
            }
            .glassButton()
            .buttonBorderShape(.circle)
            .tint(.glett.accent)
            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 8 }
        }
    }

    private func scroll(_ go: Bool, _ proxy: ScrollViewProxy) {
        guard go, model.engine != nil else { return }
        withAnimation { proxy.scrollTo(Self.hoursAnchor, anchor: .top) }
        model.scrollToHours = false
    }
}

#Preview {
    CompactRootView(model: .preview())
        .modelContainer(PlaceStore.previewContainer())
        .environment(LanguageSettings.shared)
}
