import SwiftUI

/// Compact width (iPhone, closed iPhone Duo): one column like the web on a phone — place, now card, the days, then
/// the hours and the rest — under a large title with the place's name.
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
                        PlaceChips(model: model).id(Self.topAnchor)
                        if model.place == nil {
                            EmptyForecastView(model: model)
                        } else {
                            PlaceHeader(model: model)
                                .onScrollVisibilityChange(threshold: 0.3) { v in withAnimation(.easeOut(duration: 0.18)) { headingVisible = v } }
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
            .navigationTitle(Text(verbatim: model.place?.name ?? L10n.t("nav.forecast")))
            // the large title on the same row as the gear, so no empty corner above it (owner, 2026-10-26)
            .toolbarTitleDisplayMode(.inlineLarge)
            .toolbar { AppToolbar(model: model) }
        }
        .glettHaptic(.refresh, trigger: refreshes)
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
