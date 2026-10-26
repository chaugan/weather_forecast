import SwiftUI

/// Regular width (iPad, open iPhone Duo, big phones in landscape): the web's two columns as a `NavigationSplitView` —
/// places, the now card and the days in the sidebar, the hour views in the detail. The sidebar's bar keeps an inline
/// title (inside the tab view iPadOS 26 does not show it large), so `PlaceHeader` shows the place name as a heading.
struct RegularRootView: View {
    let model: AppModel
    @State private var visibility: NavigationSplitViewVisibility = .all
    /// Finished pulls to refresh (the haptic's trigger).
    @State private var refreshes = 0

    var body: some View {
        NavigationSplitView(columnVisibility: $visibility) {
            ScrollView {
                VStack(alignment: .leading, spacing: GlettMetrics.cardSpacing) {
                    SidebarPlaces(model: model)
                    if model.place == nil {
                        EmptyForecastView(model: model)
                    } else {
                        PlaceHeader(model: model, showsName: true)
                        ForecastStatusView(model: model)
                        WarningsBanner(model: model)
                        if let e = model.engine {
                            NowCard(model: model, engine: e)
                            DaysList(model: model, engine: e)
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
            .navigationTitle(Text(verbatim: model.place?.name ?? L10n.t("nav.forecast")))
            .navigationBarTitleDisplayMode(.inline)
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
