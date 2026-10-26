import SwiftUI

/// Regular width (iPad, open iPhone Duo, big phones in landscape): the web's two columns as a `NavigationSplitView` —
/// places, the now card and the days in the sidebar, the hour views (and the pushed screens) in the detail.
struct RegularRootView: View {
    @Bindable var model: AppModel
    @State private var visibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $visibility) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    SidebarPlaces(model: model)
                    if model.place == nil {
                        EmptyForecastView(model: model)
                    } else {
                        PlaceHeader(model: model)
                        ForecastStatusView(model: model)
                        WarningsBanner(model: model)
                        if let e = model.engine {
                            NowCard(model: model, engine: e)
                            DaysList(model: model, engine: e)
                        }
                    }
                    DisclaimerFooter(model: model)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .refreshable { await model.refresh() }
            .background(.glett.bg)
            .navigationTitle(Text(verbatim: model.place?.name ?? L10n.t("nav.forecast")))
            .navigationBarTitleDisplayMode(.inline)
            .navigationSplitViewColumnWidth(min: 340, ideal: 400, max: 460)
        } detail: {
            NavigationStack(path: $model.path) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if model.engine != nil {
                            HoursSection(model: model)
                            ModelsLink(model: model)
                        } else if model.place != nil {
                            ForecastStatusView(model: model)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .refreshable { await model.refresh() }
                .background(.glett.bg)
                .navigationTitle(Text(verbatim: L10n.t("hrs.title")))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { AppToolbar(model: model, showsPlaces: false) }
                .navigationDestination(for: AppRoute.self) { RouteDestination(route: $0, model: model) }
            }
        }
        .navigationSplitViewStyle(.balanced)
    }
}

#Preview(traits: .landscapeLeft) {
    RegularRootView(model: .preview())
        .modelContainer(PlaceStore.previewContainer())
        .environment(LanguageSettings.shared)
}
