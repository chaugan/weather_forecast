import GlettKit
import SwiftData
import SwiftUI

@main
struct GlettApp: App {
    @State private var model: AppModel
    private let container: ModelContainer

    init() {
        let launch = LaunchOptions.current
        // `-GlettLang nb|en` is applied like a choice in the settings (it is stored).
        if let l = launch.language { LanguageSettings.shared.choice = l == .nb ? .nb : .en }
        container = PlaceStore.makeContainer()
        _model = State(initialValue: AppModel(launch: launch))
    }

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .glettLanguage()
                .preferredColorScheme(model.theme.colorScheme)
                .onChange(of: LanguageSettings.shared.effective) { model.languageChanged() }
        }
        .modelContainer(container)
    }
}
