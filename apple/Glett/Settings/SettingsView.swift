import GlettKit
import SwiftUI

/// Settings (`#settings`, index.html:173-184, plus what the web keeps in its top bar): wind unit, weighting by
/// reliability, the hour view the app opens with, language (live), theme, moving places to and from glett.no, and the
/// way to the sources. Every value is stored under the web's key (`SettingsKey`) by `AppModel` / `LanguageSettings`.
struct SettingsView: View {
    let model: AppModel
    @Environment(LanguageSettings.self) private var language
    var reliability: ReliabilityStore = .shared

    init(model: AppModel, reliability: ReliabilityStore = .shared) {
        self.model = model
        self.reliability = reliability
    }

    var body: some View {
        @Bindable var model = model
        @Bindable var language = language
        ScrollViewReader { proxy in
            Form {
                Section {
                    Picker(selection: $model.windUnit) {
                        ForEach(WindUnit.allCases, id: \.self) { u in Text(verbatim: L10n.t(u.key)).tag(u) }
                    } label: {
                        Label { Text(verbatim: L10n.t("set.wind")) } icon: { Image(systemName: "wind") }
                    }
                    Picker(selection: $model.hourView) {
                        ForEach(HourView.allCases, id: \.self) { v in Text(verbatim: L10n.t(Self.hourViewKey(v))).tag(v) }
                    } label: {
                        Label { Text(app: "app.hourview") } icon: { Image(systemName: "tablecells") }
                    }
                } header: {
                    Text(verbatim: L10n.t("nav.forecast"))
                } footer: {
                    Text(app: "app.hourview.hint")
                }

                Section {
                    Toggle(isOn: $model.weighted) {
                        Label { Text(verbatim: L10n.t("tb.weight")) } icon: { Image(systemName: "scalemass") }
                    }
                    NavigationLink {
                        ModelsListView(model: model).navigationBarTitleDisplayMode(.inline)
                    } label: {
                        LabeledContent {
                            if let c = model.modelCounts {
                                Text(verbatim: L10n.t("m.active", ["a": String(c.active), "n": String(c.unique)])).monospacedDigit()
                            }
                        } label: {
                            Label { Text(verbatim: L10n.t("tb.models")) } icon: { Image(systemName: "square.stack.3d.up") }
                        }
                    }
                } footer: {
                    Text(app: "app.weight.hint")
                }

                Section {
                    Picker(selection: $language.choice) {
                        ForEach(LanguageSettings.Choice.allCases) { c in Text(app: Self.languageKey(c)).tag(c) }
                    } label: {
                        Text(app: "app.lang")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } header: {
                    Text(app: "app.lang")
                }

                Section {
                    Picker(selection: $model.theme) {
                        ForEach(AppTheme.allCases, id: \.self) { t in
                            Text(app: Self.themeKey(t)).tag(t)
                        }
                    } label: {
                        Text(app: "app.theme")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } header: {
                    Text(app: "app.theme")
                }

                PlacesTransferSection()

                Section {
                    Button { model.reload(force: true) } label: {
                        Label { Text(verbatim: L10n.t("tb.refresh.title")) } icon: { Image(systemName: "arrow.clockwise") }
                    }
                    .disabled(model.place == nil || model.isLoading)
                }

                Section {
                    NavigationLink {
                        AttributionView().navigationBarTitleDisplayMode(.inline)
                    } label: {
                        Label { Text(verbatim: L10n.t("footer.more")) } icon: { Image(systemName: "info.circle") }
                    }
                    .id("about")
                    LabeledContent {
                        Text(verbatim: AppVersion.text).monospacedDigit()
                    } label: {
                        Label { Text(app: "app.version") } icon: { Image(systemName: "number") }
                    }
                } header: {
                    Text(app: "app.about")
                } footer: {
                    Text(verbatim: L10n.t("brand.sub") + " · " + AppText.t("app.brand"))
                }
            }
            .formStyle(.grouped)
            .task {
                reliability.attach(model)
                if let a = ScreenshotHook.take("-GlettScroll") {
                    try? await Task.sleep(for: .milliseconds(400))
                    proxy.scrollTo(a, anchor: .top)
                }
            }
        }
        .tint(.glett.accent)
        .navigationTitle(Text(verbatim: L10n.t("tb.settings")))
    }

    /// `orient.v` / `orient.h` / `orient.m`.
    static func hourViewKey(_ v: HourView) -> String { "orient.\(v.rawValue)" }

    static func languageKey(_ c: LanguageSettings.Choice) -> String { "app.lang.\(c.rawValue)" }

    static func themeKey(_ t: AppTheme) -> String { "app.theme.\(t.rawValue)" }
}

#Preview {
    NavigationStack { SettingsView(model: .preview(), reliability: .preview(ReliabilitySamples.oslo)).glettSheetRoot() }
        .glettSheet()
        .glettLanguage()
        .modelContainer(PlaceStore.previewContainer())
}
