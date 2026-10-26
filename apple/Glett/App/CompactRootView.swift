import SwiftUI

/// Compact width (iPhone, closed iPhone Duo): one column like the web on a phone — place, now card, the days, then
/// the hours and the rest — in a `NavigationStack`.
struct CompactRootView: View {
    @Bindable var model: AppModel

    /// The scroll anchor of the hour section.
    static let hoursAnchor = "hours"

    var body: some View {
        NavigationStack(path: $model.path) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        PlaceChips(model: model)
                        if model.place == nil {
                            EmptyForecastView(model: model)
                        } else {
                            PlaceHeader(model: model)
                            ForecastStatusView(model: model)
                            WarningsBanner(model: model)
                            if let e = model.engine {
                                NowCard(model: model, engine: e)
                                DaysList(model: model, engine: e)
                                HoursSection(model: model).id(Self.hoursAnchor)
                                ModelsLink(model: model)
                            }
                        }
                        DisclaimerFooter(model: model)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                }
                .refreshable { await model.refresh() }
                .onChange(of: model.scrollToHours) { _, go in scroll(go, proxy) }
                .onChange(of: model.engine != nil) { _, _ in scroll(model.scrollToHours, proxy) }
            }
            .background(.glett.bg)
            .navigationTitle(Text(verbatim: model.place?.name ?? L10n.t("nav.forecast")))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { AppToolbar(model: model) }
            .navigationDestination(for: AppRoute.self) { RouteDestination(route: $0, model: model) }
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
