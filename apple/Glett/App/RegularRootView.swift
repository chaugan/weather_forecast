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
                        // the places are a menu on the place name (owner, 2026-10-26), not chips here
                        Color.clear.frame(height: 0).id(CompactRootView.topAnchor)
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
                    // half the margin at the edge shared with the detail, so the gap between the columns is one margin
                    .padding(.leading, GlettMetrics.pagePadding)
                    .padding(.trailing, GlettMetrics.pagePadding / 2)
                    .padding(.vertical, 8)
                }
                .glettPageBackground()
                .refreshable { @MainActor in
                    await model.refresh()
                    refreshes += 1
                }
                .onChange(of: model.engine != nil) { _, _ in   // -GlettScreen days
                    if model.scrollToDays { proxy.scrollTo(CompactRootView.daysAnchor, anchor: .top); model.scrollToDays = false }
                }
                // no small title over the big place heading; once it is scrolled away, MiniNow shows the place
                .navigationTitle(Text(verbatim: model.place == nil ? L10n.t("nav.forecast") : ""))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    // Glett's own sidebar button at the far left, left of the summary (owner, 2026-10-26)
                    ToolbarItem(placement: .topBarLeading) { sidebarButton }
                    if !headingVisible, let p = model.place, let now = model.engine?.nowSummary() {
                        ToolbarItem(placement: .principal) {
                            MiniNow(place: p, now: now) { withAnimation { proxy.scrollTo(CompactRootView.topAnchor, anchor: .top) } }
                        }
                    }
                }
                .toolbar(removing: .sidebarToggle)
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
                    .padding(.vertical, GlettMetrics.pagePadding)
                    .padding(.trailing, GlettMetrics.pagePadding)
                    .padding(.leading, visibility == .detailOnly ? GlettMetrics.pagePadding : GlettMetrics.pagePadding / 2)
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
                .toolbar(removing: .sidebarToggle)
                .toolbar {
                    // the sidebar is folded away: the current weather stays in sight here; a tap brings the sidebar back
                    if visibility == .detailOnly {
                        ToolbarItem(placement: .topBarLeading) { sidebarButton }
                        if let p = model.place, let now = model.engine?.nowSummary() {
                            ToolbarItem(placement: .principal) {
                                MiniNow(place: p, now: now) { withAnimation { visibility = .all } }
                            }
                        }
                    }
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .glettHaptic(.refresh, trigger: refreshes)
    }

    /// Shows or folds away the sidebar (in place of the system's button, which sits at the sidebar's far edge).
    private var sidebarButton: some View {
        let open = visibility != .detailOnly
        return Button {
            withAnimation { visibility = open ? .detailOnly : .all }
        } label: {
            Image(systemName: "sidebar.left")
        }
        .accessibilityLabel(Text(verbatim: AppText.t(open ? "app.sidebar.hide" : "app.sidebar.show")))
    }
}

#Preview(traits: .landscapeLeft) {
    RegularRootView(model: .preview())
        .modelContainer(PlaceStore.previewContainer())
        .environment(LanguageSettings.shared)
}
