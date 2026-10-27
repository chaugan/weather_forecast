import GlettKit
import SwiftUI
import WidgetKit

/// Glett's widgets (brief §6): the now card on the Home Screen and the Lock Screen, the next hours, the days ahead
/// and the rain countdown. All read the app's App Group and show the same numbers as the app.
@main
struct GlettWidgetBundle: WidgetBundle {
    var body: some Widget {
        NowWidget()
        HoursWidget()
        DaysWidget()
        RingWidget()
    }
}

struct GlettEntry: TimelineEntry {
    var date: Date
    /// Nil before the first forecast (offline): the widget asks to open the app.
    var snapshot: GlettSnapshot?
}

struct GlettProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> GlettEntry {
        GlettEntry(date: Date(), snapshot: .placeholder)
    }

    func snapshot(for configuration: PlaceIntent, in context: Context) async -> GlettEntry {
        if context.isPreview { return GlettEntry(date: Date(), snapshot: .placeholder) }
        let t = await WidgetData.timeline(for: (configuration.place ?? .last).place)
        return GlettEntry(date: Date(), snapshot: t?.snapshots.first)
    }

    func timeline(for configuration: PlaceIntent, in context: Context) async -> Timeline<GlettEntry> {
        let now = Date()
        guard let t = await WidgetData.timeline(for: (configuration.place ?? .last).place, now: now), !t.snapshots.isEmpty else {
            return Timeline(entries: [GlettEntry(date: now, snapshot: nil)], policy: .after(now.addingTimeInterval(1800)))
        }
        return Timeline(entries: t.snapshots.map { GlettEntry(date: $0.date, snapshot: $0) }, policy: .after(t.next))
    }
}

/// The face for an entry, or the "open Glett" note before the first forecast.
private struct EntryView<Face: View>: View {
    let entry: GlettEntry
    @ViewBuilder let face: (GlettSnapshot) -> Face

    var body: some View {
        Group {
            if let s = entry.snapshot { face(s) } else {
                Text(verbatim: AppText.t("app.w.empty")).font(.caption).foregroundStyle(.secondary)
            }
        }
        .containerBackground(for: .widget) { Color.glett.panel }
    }
}

struct NowWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "no.glett.now", intent: PlaceIntent.self, provider: GlettProvider()) { entry in
            NowFace(entry: entry)
        }
        .configurationDisplayName(Text(verbatim: AppText.t("app.w.now.name")))
        .description(Text(verbatim: AppText.t("app.w.now.desc")))
        .supportedFamilies([.systemSmall, .accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}

private struct NowFace: View {
    let entry: GlettEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        EntryView(entry: entry) { s in
            switch family {
            case .accessoryRectangular: LockRectangularView(s: s)
            case .accessoryCircular: LockCircularView(s: s)
            case .accessoryInline: LockInlineView(s: s)
            default: NowSmallView(s: s)
            }
        }
    }
}

struct HoursWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "no.glett.hours", intent: PlaceIntent.self, provider: GlettProvider()) { entry in
            EntryView(entry: entry) { HoursMediumView(s: $0) }
        }
        .configurationDisplayName(Text(verbatim: AppText.t("app.w.hours.name")))
        .description(Text(verbatim: AppText.t("app.w.hours.desc")))
        .supportedFamilies([.systemMedium])
    }
}

struct DaysWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "no.glett.days", intent: PlaceIntent.self, provider: GlettProvider()) { entry in
            EntryView(entry: entry) { DaysLargeView(s: $0) }
        }
        .configurationDisplayName(Text(verbatim: AppText.t("app.w.days.name")))
        .description(Text(verbatim: AppText.t("app.w.days.desc")))
        .supportedFamilies([.systemLarge])
    }
}

struct RingWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "no.glett.ring", intent: PlaceIntent.self, provider: GlettProvider()) { entry in
            EntryView(entry: entry) { LockRingView(s: $0) }
        }
        .configurationDisplayName(Text(verbatim: AppText.t("app.w.ring.name")))
        .description(Text(verbatim: AppText.t("app.w.ring.desc")))
        .supportedFamilies([.accessoryCircular])
    }
}
