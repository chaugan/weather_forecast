import GlettKit
import SwiftUI

/// The models (`#mdlList`, js/app.js:1020-1053) and their reliability (`renderReliability`, js/app.js:508-556):
/// each model with its region, its reliability badge and a switch (at least one stays on; a switched-off model
/// leaves the consensus), duplicates greyed, the models without coverage, then the ranking with a detail per model
/// (errors per measurement and its consensus weights) and the notes on how the check works.
struct ModelsListView: View {
    let model: AppModel
    var reliability: ReliabilityStore = .shared
    /// A model whose reliability is open (`-GlettModel`; taps use the links).
    @State private var opened: String?

    init(model: AppModel, reliability: ReliabilityStore = .shared) {
        self.model = model
        self.reliability = reliability
    }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                if let f = model.bundle?.forecast {
                    modelsSection(f)
                    missingSection(f)
                    reliabilitySection
                } else {
                    Text(verbatim: L10n.t("loading")).foregroundStyle(.glett.muted)
                }
            }
            .listStyle(.insetGrouped)
            .task {
                reliability.attach(model)
                if let a = ScreenshotHook.take("-GlettScroll") {
                    try? await Task.sleep(for: .milliseconds(400))
                    proxy.scrollTo(a, anchor: .top)
                }
                if let id = ScreenshotHook.take("-GlettModel") {
                    while reliability.result == nil, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(250)) }
                    opened = id
                }
            }
        }
        .navigationTitle(Text(verbatim: L10n.t("tb.models")))
        .refreshable { reliability.load(force: true) }
        .navigationDestination(item: $opened) { id in
            if let v = reliability.result {
                if id == "info" {
                    ReliabilityInfoView(result: v, placeName: model.place?.name ?? "")
                } else {
                    ModelReliabilityView(id: id, result: v, model: model)
                }
            }
        }
    }

    // MARK: The list (`renderModels`)

    private func modelsSection(_ f: Forecast) -> some View {
        Section {
            ForEach(f.providers) { p in
                ModelToggleRow(provider: p,
                               duplicateOf: p.dupOf.map { dup in f.providers.first { $0.id == dup }.map(Format.modelName) ?? ReliabilityFormat.name(dup) },
                               score: reliability.result?.models[p.id]?.score,
                               isOn: Binding(get: { !model.disabledModels.contains(p.id) },
                                             set: { model.setModel(p.id, enabled: $0) }))
            }
            if !model.disabledModels.isEmpty {
                Button { model.disabledModels = [] } label: {
                    Label { Text(verbatim: L10n.t("m.all")) } icon: { Image(systemName: "checkmark.circle") }
                }
                .tint(.glett.accent)
            }
        } header: {
            if let c = model.modelCounts {
                Text(verbatim: L10n.t("m.active", ["a": String(c.active), "n": String(c.unique)])).monospacedDigit()
            }
        } footer: {
            Text(app: "app.models.hint")
        }
    }

    /// `m.missing`: the models with no data at this place (js/app.js:1039-1041).
    @ViewBuilder
    private func missingSection(_ f: Forecast) -> some View {
        let missing = ModelCatalog.allIDs.filter { id in !f.providers.contains { $0.id == id } }
        if !missing.isEmpty {
            Section {
                ForEach(missing, id: \.self) { id in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: ReliabilityFormat.name(id)).font(.body.weight(.semibold))
                        if let r = ReliabilityFormat.region(id) { Text(verbatim: r).font(.caption) }
                    }
                    .foregroundStyle(.glett.muted)
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text(verbatim: L10n.t("m.missing"))
            }
        }
    }

    // MARK: Reliability (`renderReliability`)

    @ViewBuilder
    private var reliabilitySection: some View {
        @Bindable var model = model
        Section {
            Toggle(isOn: $model.weighted) { Text(verbatim: L10n.t("tb.weight")) }
                .tint(.glett.accent)
                .id("reliability")
            if let v = reliability.result {
                ReliabilityHeader()
                let best = v.best(disabled: model.disabledModels)
                ForEach(v.ranked(), id: \.id) { r in
                    NavigationLink {
                        ModelReliabilityView(id: r.id, result: v, model: model)
                    } label: {
                        ReliabilityRow(id: r.id, result: r.model, disabled: model.disabledModels.contains(r.id),
                                       bestCount: best.values.filter { $0 == r.id }.count)
                    }
                }
                NavigationLink {
                    ReliabilityInfoView(result: v, placeName: model.place?.name ?? "")
                } label: {
                    Label { Text(verbatim: L10n.t("lg.title")) } icon: { Image(systemName: "info.circle") }
                }
            } else if let e = reliability.errorMessage {
                VStack(alignment: .leading, spacing: 8) {
                    Label { Text(verbatim: L10n.t("r.unavailable", ["e": e])) } icon: {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(.glett.mid)
                    }
                    .font(.subheadline)
                    Button { reliability.load(force: false) } label: { Text(app: "app.rel.retry") }
                        .buttonStyle(.bordered)
                }
                .padding(.vertical, 4)
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(verbatim: L10n.t("r.loading")).foregroundStyle(.glett.muted)
                }
            }
        } header: {
            HStack {
                Text(verbatim: L10n.t("p.reliability"))
                Spacer()
                if reliability.isLoading, reliability.result != nil { ProgressView().controlSize(.mini) }
            }
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Text(app: "app.weight.hint")
                if let v = reliability.result {
                    Text(verbatim: AppText.t(v.truth == .frost ? "app.rel.truth.frost" : "app.rel.truth.era5") + " · "
                         + AppText.t("app.rel.period", ["start": v.start, "end": v.end, "hours": String(v.hours)]))
                }
            }
        }
    }
}

#Preview("Models") {
    NavigationStack { ModelsListView(model: .preview(), reliability: .preview(ReliabilitySamples.oslo)) }
}

#Preview("Loading") {
    NavigationStack { ModelsListView(model: .preview(), reliability: .preview(nil)) }
}

#Preview("Unavailable") {
    NavigationStack { ModelsListView(model: .preview(), reliability: .preview(nil, error: L10n.t("err.verify"))) }
}
