import Foundation

/// Errors with the web's meaning (`DataError` kinds of js/data.js:46 and the gate's limits of js/omgate.js:35-37).
/// `l10nKey` and `l10nArgs` give the web's message from the string catalog.
public enum GlettError: Error, Sendable, Equatable {
    /// Which Open-Meteo limit was hit (`why` m/h/d in js/omgate.js:58).
    public enum Limit: String, Sendable { case minute = "m", hour = "h", day = "d" }

    /// No connection (`err.network`).
    case network(host: String)
    /// Over a request limit (`err.quota`, or `om.hour` / `om.day` for Open-Meteo's hour and day).
    case quota(host: String, limit: Limit)
    /// An HTTP error; `reason` is the service's `reason`/`error` text when it sent one.
    case http(host: String, status: Int, reason: String?)
    /// A body that is not what the service promises (`err.upstream` with an empty status).
    case upstream(host: String)
    /// Not a Glett places file (`err.import`).
    case importFormat

    public var l10nKey: String {
        switch self {
        case .network: "err.network"
        case .quota(_, let l): l == .hour ? "om.hour" : l == .day ? "om.day" : "err.quota"
        case .http: "err.upstream"   // with a reason the web shows `verbatim` instead
        case .upstream: "err.upstream"
        case .importFormat: "err.import"
        }
    }

    /// The placeholders of the message (`{host}`, `{s}`).
    public var l10nArgs: [String: String] {
        switch self {
        case .network(let h): ["host": h]
        case .quota(let h, _): ["host": h]
        case .http(let h, let s, _): ["host": h, "s": String(s)]
        case .upstream(let h): ["host": h, "s": ""]
        case .importFormat: [:]
        }
    }

    /// The web shows "host: reason" verbatim when the service gave a reason (js/data.js:115); nil otherwise.
    public var verbatim: String? {
        if case .http(let h, _, let r?) = self { return "\(h): \(r)" }
        return nil
    }

    /// `kind` of the web's DataError: "network", "quota", "http", "error".
    public var kind: String {
        switch self {
        case .network: "network"
        case .quota: "quota"
        case .http: "http"
        default: "error"
        }
    }
}
