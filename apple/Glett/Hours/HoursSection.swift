import GlettKit
import SwiftUI

/// "Time for time" (`#hoursCard`, index.html:155-193; js/app.js:822-875): the step (1/3/6/12 h), three views of the
/// same consensus — time down, time across and the meteogram — the individual models behind "Vis alle modellene"
/// (copies of another model greyed with "Samme data som …"), the colour key and "Slik leser du tabellen".
///
/// Inputs: `model.engine`, `model.selectedDay` (nil = today from now), `model.step`, `model.hourView` (stored as
/// `glett.orient2`), `model.windUnit`, `model.nowcast` (radar pills and bars), `model.weights` (score badges).
struct HoursSection: View {
    let model: AppModel

    /// `glett.models_open2` (js/app.js:562, 875): the model rows are collapsed by default and the choice is kept.
    @AppStorage("glett.models_open2", store: AppModel.settingsDefaults()) private var modelsOpen = false

    init(model: AppModel) { self.model = model }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HoursHeader(model: model, subtitle: subtitle)
            if let engine = model.engine {
                content(HourTable(engine: engine, step: model.step))
            }
        }
        .glettCard(padding: 14)
        .task(id: model.engine != nil) { await settleLaunchScroll() }
        .onAppear(perform: applyLaunchOptions)
    }

    /// `-GlettScreen hours`: the root scrolls to this section as soon as the forecast is there, before the lists above
    /// have their final height, and stops short. Asking once more after the first layout lands it on the section.
    private func settleLaunchScroll() async {
        guard model.engine != nil, model.launch.screen == .hours, !Self.launchScrollDone.value else { return }
        Self.launchScrollDone.value = true
        for wait in [600, 1400] {
            try? await Task.sleep(for: .milliseconds(wait))
            model.scrollToHours = true
        }
    }

    /// `-GlettHoursModels`, `-GlettStep` (once per launch).
    private func applyLaunchOptions() {
        guard !Self.launchOptionsDone.value else { return }
        Self.launchOptionsDone.value = true
        let o = HoursLaunchOptions.current
        if let open = o.modelsOpen { modelsOpen = open }
        if let step = o.step { model.step = step }
    }

    @MainActor private static let launchScrollDone = Flag()
    @MainActor private static let launchOptionsDone = Flag()
    @MainActor private final class Flag { var value = false }

    @ViewBuilder private func content(_ table: HourTable) -> some View {
        let day = model.selectedDay ?? table.today
        let view = model.hourView
        let all = table.models(weights: model.weights)
        let shown = modelsOpen && view != .meteogram ? all : []
        switch view {
        case .timeDown:
            SegmentKey(categories: table.categoriesInUse())
            TimeDownTable(table: table, day: day, models: shown, unit: model.windUnit)
                .id("\(table.step)-\(day)")   // a new day or step starts a new window (`state.vCount = null`)
        case .timeAcross:
            SegmentKey(categories: table.categoriesInUse())
            TimeAcrossTable(table: table, day: day, models: shown, unit: model.windUnit, nowcast: model.nowcast)
        case .meteogram:
            MeteogramView(table: table, day: day, unit: model.windUnit, nowcast: model.nowcast, now: table.engine.now)
        }
        if view != .meteogram {
            ModelsToggle(open: $modelsOpen, count: all.count)
            if modelsOpen { DuplicateModelsNote(duplicates: table.duplicates) }
        }
        HoursLegend(view: view, modelCount: all.count, unit: model.windUnit,
                    weighted: model.weighted && model.weights != nil,
                    showsCompare: !shown.isEmpty && shown.contains(where: \.isHeadline))
    }

    /// `syncHoursTitle()` (js/app.js:923): "fra nå" for today, else the day.
    private var subtitle: String {
        guard let e = model.engine else { return "" }
        let day = model.selectedDay ?? e.todayIndex
        return day == e.todayIndex ? L10n.t("hrs.fromnow") : Format.dayLabel(day, in: e.forecast, today: e.todayIndex)
    }
}

#Preview("Time down") {
    let m = AppModel.preview()
    m.hourView = .timeDown
    return ScrollView { HoursSection(model: m).padding() }.background(.glett.bg)
}

#Preview("Time across") {
    let m = AppModel.preview()
    m.hourView = .timeAcross
    return ScrollView { HoursSection(model: m).padding() }.background(.glett.bg)
}

#Preview("Meteogram") {
    let m = AppModel.preview()
    m.hourView = .meteogram
    return ScrollView { HoursSection(model: m).padding() }.background(.glett.bg)
}
