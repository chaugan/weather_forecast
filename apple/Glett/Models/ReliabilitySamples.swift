import Foundation
import GlettKit

/// A made-up reliability result in the web's JSON shape (Frost truth, Oslo-like numbers) for previews; no network.
enum ReliabilitySamples {
    static let oslo: VerificationResult? = {
        var models: [String: Any] = [:]
        for (i, id) in ModelCatalog.verifyModels.enumerated() {
            let q = Double((i * 7) % 12) / 11            // 0…1, a different spread per model
            let skill: [String: Double] = [
                "temperature_2m": 0.82 - 0.3 * q, "wind_speed_10m": 0.7 - 0.25 * q, "cloud_cover": 0.55 - 0.2 * q,
                "relative_humidity_2m": 0.66 - 0.2 * q, "pressure_msl": 0.9 - 0.15 * q, "precip": 0.6 - 0.3 * q, "code": 0.58 - 0.2 * q,
            ]
            let mean = skill.values.reduce(0, +) / Double(skill.count)
            let w = { (s: Double) in min(1.8, max(0.5, ((s + 0.15) / (mean + 0.15) * 1000).rounded() / 1000)) }
            models[id] = [
                "score": Int((mean * 100).rounded()), "score7": Int((mean * 100).rounded()) + (i % 3) - 1,
                "skill": skill,
                "mae": ["temperature_2m": 0.7 + 1.2 * q, "wind_speed_10m": 4.5 + 3.8 * q, "cloud_cover": 22 + 10 * q,
                        "relative_humidity_2m": 8 + 5 * q, "pressure_msl": 0.4 + 0.6 * q],
                "bias": ["temperature_2m": -0.3 + 0.8 * q, "wind_speed_10m": 1.2 - 2 * q, "cloud_cover": -4 + 9 * q,
                         "relative_humidity_2m": 2 - 3 * q, "pressure_msl": 0.1 - 0.3 * q],
                "csi": skill["precip"]!, "code_acc": skill["code"]!,
                "obs": ["mae": ["temperature_2m": 0.9 + q, "relative_humidity_2m": 9 + 4 * q], "bias": ["temperature_2m": 0.2, "relative_humidity_2m": -1.5],
                        "csi": 0.5 - 0.2 * q] as [String: Any],
                "weights": ["weather": w(skill["code"]!), "temperature_2m": w(skill["temperature_2m"]!), "precip": w(skill["precip"]!),
                            "wind": w(skill["wind_speed_10m"]!), "storm": w(skill["code"]!), "cloud_cover": w(skill["cloud_cover"]!),
                            "relative_humidity_2m": w(skill["relative_humidity_2m"]!), "pressure_msl": w(skill["pressure_msl"]!)],
            ]
        }
        let json: [String: Any] = [
            "truth": "frost", "start": "2026-09-21", "end": "2026-10-19", "hours": 672, "recent_from": "2026-10-12",
            "frost": ["stations": ["t": ["id": "SN18700", "name": "Oslo - Blindern", "km": 2.1],
                                   "w": ["id": "SN18700", "name": "Oslo - Blindern", "km": 2.1],
                                   "h": ["id": "SN18700", "name": "Oslo - Blindern", "km": 2.1],
                                   "p": ["id": "SN18700", "name": "Oslo - Blindern", "km": 2.1],
                                   "c": ["id": "SN4780", "name": "Gardermoen", "km": 35.4],
                                   "r": ["id": "SN18700", "name": "Oslo - Blindern", "km": 2.1]]],
            "netatmo_hours": 214, "obs_weight": 0.3, "station": NSNull(), "models": models,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        return try? JSONDecoder().decode(VerificationResult.self, from: data)
    }()
}
