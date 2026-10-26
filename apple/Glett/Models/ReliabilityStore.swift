import Foundation
import GlettKit
import Observation

/// The reliability check for the shown place (`loadVerify`, js/app.js:1167-1182): loaded after the place changes,
/// shown by the model list, and handed to the consensus as `AppModel.weights`. One instance (`shared`); `attach`
/// makes it follow the model's place from then on, as the web loads it after every forecast.
@MainActor @Observable
final class ReliabilityStore {
    static let shared = ReliabilityStore()

    /// The result for `placeKey` (possibly a stored, expired one while a fresh one loads, or after the fetch failed:
    /// shown in the list, but not used as weights).
    private(set) var result: VerificationResult?
    /// The place the result belongs to.
    private(set) var placeKey: String?
    private(set) var isLoading = false
    /// `r.unavailable`'s `{e}`: the error as the web shows `err.message`.
    private(set) var errorMessage: String?

    /// When `result` stops being fresh (24 h after it was fetched); nil for an expired one.
    @ObservationIgnored private var freshUntil: Date?
    @ObservationIgnored private weak var attached: AppModel?
    @ObservationIgnored private var task: Task<Void, Never>?
    /// Previews: never touches the network.
    @ObservationIgnored private let offline: Bool

    init(offline: Bool = false) { self.offline = offline }

    /// A store with a ready result (previews).
    static func preview(_ result: VerificationResult?, error: String? = nil) -> ReliabilityStore {
        let s = ReliabilityStore(offline: true)
        s.result = result
        s.errorMessage = error
        return s
    }

    /// Follows `model.place`: loads now and again whenever the place changes. Safe to call more than once.
    func attach(_ model: AppModel) {
        guard !offline else { return }
        if attached !== model {
            attached = model
            observe()
        }
        load(force: false)
    }

    /// Loads (or reloads) the check for the attached model's place.
    func load(force: Bool) {
        guard !offline, let model = attached, let place = model.place else { return }
        let key = place.placeKey
        if key != placeKey {
            placeKey = key
            result = nil
            freshUntil = nil
            errorMessage = nil
            model.weights = nil
        } else if result != nil, !force, errorMessage == nil, !isLoading, let f = freshUntil, f > Date() {
            return
        }
        task?.cancel()
        task = Task { await run(place, key: key, force: force, model: model) }
    }

    private func run(_ place: Place, key: String, force: Bool, model: AppModel) async {
        isLoading = true
        defer { if placeKey == key { isLoading = false } }
        errorMessage = nil
        // a stored result shows in the list at once; as weights only while fresh, as the web's `cacheGet` (js/data.js:298)
        if result == nil, let stored = await model.service.cachedVerificationEntry(for: place), placeKey == key {
            apply(stored.value, fresh: stored.isFresh(), to: model)
            freshUntil = stored.isFresh() ? stored.expiresAt : nil
        }
        do {
            let v = try await model.service.verification(for: place, force: force)
            guard placeKey == key, !Task.isCancelled else { return }
            apply(v, fresh: true, to: model)
            freshUntil = await model.service.cachedVerificationEntry(for: place)?.expiresAt ?? Date().addingTimeInterval(CacheKey.verifyTTL)
        } catch is CancellationError {
            return
        } catch {
            guard placeKey == key, !Task.isCancelled else { return }
            errorMessage = Self.message(error)
            // the web keeps `state.verify` null on failure (js/app.js:1175-1179): no weights from an expired result
            if let f = freshUntil, f > Date() { return }
            freshUntil = nil
            if model.place?.placeKey == placeKey { model.weights = nil }
        }
    }

    private func apply(_ v: VerificationResult, fresh: Bool, to model: AppModel) {
        result = v
        guard model.place?.placeKey == placeKey else { return }
        model.weights = fresh ? v : nil
    }

    /// The text the web puts in `r.unavailable`'s `{e}`.
    static func message(_ error: any Error) -> String {
        if let e = error as? GlettError { return e.verbatim ?? L10n.t(e.l10nKey, e.l10nArgs) }
        if let e = error as? VerificationError { return L10n.t(e.l10nKey, e.l10nArgs) }
        return L10n.t("err.verify")
    }

    private func observe() {
        withObservationTracking {
            _ = attached?.place?.placeKey
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.observe()
                self.load(force: false)
            }
        }
    }
}
