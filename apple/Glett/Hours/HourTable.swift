import GlettKit
import SwiftUI

/// The numbers behind the three hour views, from one consensus and one step: the week's columns, the models that get
/// their own rows, and the per-model cells (`buildRows('weather', cols)`, js/app.js:277-330). Cheap to build; the
/// per-column consensus is computed by the cells that are on screen (the across strip and meteogram are lazy).
struct HourTable {
    let engine: ConsensusEngine
    let step: Int
    /// The whole week at this step (`columns()`, js/app.js:174).
    let columns: [StepColumn]

    /// `HEADLINE_MODEL_IDS` (js/app.js:275): ECMWF's AI model gets its own row, tagged AI, above the others.
    static let headlineIDs = ModelCatalog.headlineIDs

    /// `V_WINDOW` (js/app.js:566): rows the time-down list shows at first, by step (about two screens).
    static let downWindow: [Int: Int] = [1: 24, 3: 16, 6: 16, 12: 14]
    /// `V_APPEND` (js/app.js:567): rows added per press of "more" (6 h, 12 h, 24 h, 24 h).
    static let downAppend: [Int: Int] = [1: 6, 3: 4, 6: 4, 12: 2]

    init(engine: ConsensusEngine, step: Int) {
        self.engine = engine
        self.step = StepAggregation.steps.contains(step) ? step : 1
        columns = engine.columns(step: self.step)
    }

    var forecast: Forecast { engine.forecast }
    var today: Int { engine.todayIndex }

    /// The first column of `day` that is not over (`renderGridVertical`'s start, js/app.js:580-582): today starts at
    /// the current step, a past day at its first future step, else the week's first future step.
    func startIndex(day: Int) -> Int {
        if let i = columns.firstIndex(where: { $0.day == day && (!$0.past || $0.now) }) { return i }
        if let i = columns.firstIndex(where: { !$0.past || $0.now }) { return i }
        return 0
    }

    /// The index of the step that holds the current hour, if it is in the forecast.
    var nowIndex: Int? { columns.firstIndex(where: \.now) }

    // MARK: Models

    /// One model row: the provider, its display name, the AI tag and its reliability score when one is loaded.
    struct Model: Identifiable {
        let provider: Provider
        let name: String
        let isHeadline: Bool
        /// The reliability score 0–100 (`badge(id)`, js/app.js:558), nil without a reliability check.
        let score: Int?
        var id: String { provider.id }
    }

    /// The active models with data, the headline model first (`extraRows` then `rows`, js/app.js:292, 311).
    func models(weights: (any ConsensusWeights)?) -> [Model] {
        let verify = weights as? VerificationResult
        let withData = engine.providers.filter { p in p.hourly.code.contains { $0 != nil } }
        let head = Self.headlineIDs.compactMap { id in withData.first { $0.id == id } }
        let rest = withData.filter { !Self.headlineIDs.contains($0.id) }
        return (head + rest).map { p in
            Model(provider: p, name: Format.modelName(p), isHeadline: Self.headlineIDs.contains(p.id), score: verify?.models[p.id]?.score)
        }
    }

    /// Models whose series are an exact copy of an earlier one (`dupOf`, js/app.js:101-105), with the name of the original.
    var duplicates: [(provider: Provider, original: String)] {
        forecast.providers.compactMap { p in
            guard let orig = p.dupOf else { return nil }
            let name = forecast.providers.first { $0.id == orig }.map(Format.modelName) ?? ModelCatalog.name(orig)
            return (p, name)
        }
    }

    /// One model's cell in the weather tab (`weatherCell`, js/app.js:286-290): the step's highest code as an icon, the
    /// mean temperature, and the mean wind with its direction.
    struct ModelCell {
        var code: Int?
        var temperature: Double?
        var wind: Double?
        var direction: Double?
    }

    func cell(_ p: Provider, _ c: StepColumn) -> ModelCell {
        ModelCell(code: engine.aggregate(p, .code, c).map { Int($0) },
                  temperature: engine.aggregate(p, .mean(.temperature2m), c),
                  wind: engine.aggregate(p, .mean(.windSpeed10m), c),
                  direction: engine.aggregate(p, .dir, c))
    }

    /// The weather categories that occur in the week (`renderSegKey`, js/app.js:815), in `CAT_ORDER`.
    func categoriesInUse() -> [WeatherCategory] {
        let hourly = engine.columns(step: 1)
        var seen = Set<WeatherCategory>()
        for c in hourly { engine.weatherShares(c)?.forEach { seen.insert($0.category) } }
        return WeatherCategory.allCases.filter(seen.contains)
    }
}

/// How sure the models are, as the web colours it.
enum AgreementLevel {
    case high, mid, low

    /// The meteogram's `agreeCls(v)` (js/app.js:683): from 0.75 high, from 0.5 mid.
    init(meteogramShare v: Double) { self = v >= 0.75 ? .high : v >= 0.5 ? .mid : .low }

    var color: Color {
        switch self {
        case .high: .glett.good
        case .mid: .glett.mid
        case .low: .glett.bad
        }
    }

    /// The across strip's agreement lane (js/app.js:322): bold from 70 %.
    static let laneStrongPercent = 70
}
