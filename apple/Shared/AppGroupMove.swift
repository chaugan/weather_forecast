import Foundation
import GlettKit

/// Moves what builds without the App Group entitlement stored into the App Group, once. TestFlight builds up to
/// 2026-10-27 were signed without it (it was not registered yet): `UserDefaults(suiteName:)` then kept the settings in
/// the app's own `Library/Preferences/group.no.glett.shared.plist`, and SwiftData the saved places in the app's own
/// `Glett.store`. With the entitlement both open in the group container, which starts empty.
enum AppGroupMove {
    /// Runs the move the first time it is read (a static `let` runs once, thread-safe).
    static let once: Void = {
        guard let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppGroup.identifier)
        else { return }
        moveSettings()
        movePlaces(to: groupStoreURL(group))
    }()

    /// The places store in the group container (`PlaceStore.makeContainer()`).
    static func groupStoreURL(_ group: URL) -> URL {
        group.appending(path: "Library/Application Support/Glett.store")
    }

    /// The app's own store, where SwiftData puts `ModelConfiguration("Glett")` without a group.
    static var appStoreURL: URL {
        URL.applicationSupportDirectory.appending(path: "Glett.store")
    }

    private static let movedKey = "glett.appGroupMoved"

    /// Copies each setting the group does not have yet; the old file stays as it is.
    private static func moveSettings() {
        guard let suite = UserDefaults(suiteName: AppGroup.identifier), suite.object(forKey: movedKey) == nil else { return }
        let old = URL.libraryDirectory.appending(path: "Preferences/\(AppGroup.identifier).plist")
        if let values = NSDictionary(contentsOf: old) as? [String: Any] {
            for (k, v) in values where suite.object(forKey: k) == nil { suite.set(v, forKey: k) }
        }
        suite.set(true, forKey: movedKey)
    }

    /// Copies the store with its journal files, unless the group already has one.
    private static func movePlaces(to dest: URL) {
        let fm = FileManager.default
        let src = appStoreURL
        guard !fm.fileExists(atPath: dest.path), fm.fileExists(atPath: src.path) else { return }
        try? fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        for suffix in ["", "-shm", "-wal"] {
            let from = URL(fileURLWithPath: src.path + suffix), to = URL(fileURLWithPath: dest.path + suffix)
            if fm.fileExists(atPath: from.path) { try? fm.copyItem(at: from, to: to) }
        }
    }
}
