import SwiftUI

/// Regular width (iPad, open iPhone Duo, big phones in landscape): the web's two columns as a `NavigationSplitView` —
/// places, the now card and the days in the sidebar, the hour views in the detail. The sidebar's bar keeps an inline
/// title (inside the tab view iPadOS 26 does not show it large), so `PlaceHeader` shows the place name as a heading.
/// `MiniNow` (the web's header summary) shows in the sidebar's bar once the heading is scrolled away, and in the detail's
/// bar while the sidebar is folded away.
struct RegularRootView: View {
    let model: AppModel
    @State private var visibility: NavigationSplitViewVisibility = .all
    /// Finished pulls to refresh (the haptic's trigger).
    @State private var refreshes = 0
    /// The sidebar's place heading is on screen.
    @State private var headingVisible = true

    var body: some View {
        NavigationSplitView(columnVisibility: $visibility) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: GlettMetrics.cardSpacing) {
                        SidebarPlaces(model: model).id(CompactRootView.topAnchor)
                        if model.place == nil {
                            EmptyForecastView(model: model)
                        } else {
                            PlaceHeader(model: model, showsName: true)
                                .onScrollVisibilityChange(threshold: 0.3) { v in withAnimation(.easeOut(duration: 0.18)) { headingVisible = v } }
                            ForecastStatusView(model: model)
                            WarningsBanner(model: model)
                            if let e = model.engine {
                                NowCard(model: model, engine: e)
                                DaysList(model: model, engine: e).id(CompactRootView.daysAnchor)
                            }
                        }
                        DisclaimerFooter(model: model)
                    }
                    .glettPage()
                }
                .glettPageBackground()
                .refreshable { @MainActor in
                    await model.refresh()
                    refreshes += 1
                }
                .onChange(of: model.engine != nil) { _, _ in   // -GlettScreen days
                    if model.scrollToDays { proxy.scrollTo(CompactRootView.daysAnchor, anchor: .top); model.scrollToDays = false }
                }
                .navigationTitle(Text(verbatim: model.place?.name ?? L10n.t("nav.forecast")))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if !headingVisible, let p = model.place, let now = model.engine?.nowSummary() {
                        ToolbarItem(placement: .principal) {
                            MiniNow(place: p, now: now) { withAnimation { proxy.scrollTo(CompactRootView.topAnchor, anchor: .top) } }
                        }
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 340, ideal: 400, max: 460)
        } detail: {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: GlettMetrics.cardSpacing) {
                        if model.engine != nil {
                            HoursSection(model: model)
                            ModelsLink(model: model)
                        } else if model.place != nil {
                            ForecastStatusView(model: model)
                        }
                    }
                    .padding(GlettMetrics.pagePadding)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .glettPageBackground()
                .refreshable { @MainActor in
                    await model.refresh()
                    refreshes += 1
                }
                .navigationTitle(Text(verbatim: L10n.t("hrs.title")))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { AppToolbar(model: model) }
                .toolbar {
                    // the sidebar is folded away: the current weather stays in sight here; a tap brings the sidebar back
                    if visibility == .detailOnly, let p = model.place, let now = model.engine?.nowSummary() {
                        ToolbarItem(placement: .principal) {
                            MiniNow(place: p, now: now) { withAnimation { visibility = .all } }
                        }
                    }
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .glettHaptic(.refresh, trigger: refreshes)
    }
}

#Preview(traits: .landscapeLeft) {
    RegularRootView(model: .preview())
        .modelContainer(PlaceStore.previewContainer())
        .environment(LanguageSettings.shared)
}
