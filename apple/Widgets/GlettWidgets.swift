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
        DogWalkWidget()
        NextGlettLiveActivity()
    }
}

struct GlettEntry: TimelineEntry {
    var date: Date
    /// Nil before the first forecast (offline): the widget asks to open the app.
    var snapshot: GlettSnapshot?
    /// Opens the app at the widget's place (`PlaceLink`).
    var link: URL?
    /// The dog-walk widget's walker, and whether it shows the next 90 minutes.
    var walker: DogWalker = .woman
    var timeline = true
}

struct GlettProvider<Intent: PlaceConfiguration>: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> GlettEntry {
        GlettEntry(date: Date(), snapshot: .placeholder)
    }

    func snapshot(for configuration: Intent, in context: Context) async -> GlettEntry {
        if context.isPreview { return GlettEntry(date: Date(), snapshot: .placeholder, walker: configuration.walker, timeline: configuration.timeline) }
        let wp = configuration.place ?? .last, place = await wp.resolve()
        let t = await WidgetData.timeline(for: place)
        return GlettEntry(date: Date(), snapshot: t?.snapshots.first, link: PlaceLink.url(place, geo: wp.id == WidgetPlace.geoID),
                          walker: configuration.walker, timeline: configuration.timeline)
    }

    func timeline(for configuration: Intent, in context: Context) async -> Timeline<GlettEntry> {
        let now = Date()
        let wp = configuration.place ?? .last, place = await wp.resolve()
        let link = PlaceLink.url(place, geo: wp.id == WidgetPlace.geoID), walker = configuration.walker, timeline = configuration.timeline
        guard let t = await WidgetData.timeline(for: place, now: now), !t.snapshots.isEmpty else {
            return Timeline(entries: [GlettEntry(date: now, snapshot: nil, link: link, walker: walker, timeline: timeline)], policy: .after(now.addingTimeInterval(1800)))
        }
        return Timeline(entries: t.snapshots.map { GlettEntry(date: $0.date, snapshot: $0, link: link, walker: walker, timeline: timeline) }, policy: .after(t.next))
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
        .widgetURL(entry.link)
    }
}

struct NowWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "no.glett.now", intent: PlaceIntent.self, provider: GlettProvider<PlaceIntent>()) { entry in
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
        AppIntentConfiguration(kind: "no.glett.hours", intent: PlaceIntent.self, provider: GlettProvider<PlaceIntent>()) { entry in
            EntryView(entry: entry) { HoursMediumView(s: $0) }
        }
        .configurationDisplayName(Text(verbatim: AppText.t("app.w.hours.name")))
        .description(Text(verbatim: AppText.t("app.w.hours.desc")))
        .supportedFamilies([.systemMedium])
    }
}

struct DaysWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "no.glett.days", intent: PlaceIntent.self, provider: GlettProvider<PlaceIntent>()) { entry in
            EntryView(entry: entry) { DaysLargeView(s: $0) }
        }
        .configurationDisplayName(Text(verbatim: AppText.t("app.w.days.name")))
        .description(Text(verbatim: AppText.t("app.w.days.desc")))
        .supportedFamilies([.systemLarge])
    }
}

struct RingWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "no.glett.ring", intent: PlaceIntent.self, provider: GlettProvider<PlaceIntent>()) { entry in
            EntryView(entry: entry) { LockRingView(s: $0) }
        }
        .configurationDisplayName(Text(verbatim: AppText.t("app.w.ring.name")))
        .description(Text(verbatim: AppText.t("app.w.ring.desc")))
        .supportedFamilies([.accessoryCircular])
    }
}

/// "Hundetur": the walker and the corgi in the weather now, and the next 90 minutes; the picture fills the small widget.
struct DogWalkWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "no.glett.dogwalk", intent: DogWalkIntent.self, provider: GlettProvider<DogWalkIntent>()) { entry in
            DogWalkFace(entry: entry)
        }
        .configurationDisplayName(Text(verbatim: AppText.t("app.w.dog.name")))
        .description(Text(verbatim: AppText.t("app.w.dog.desc")))
        .supportedFamilies([.systemSmall, .accessoryRectangular])
        .contentMarginsDisabled()
    }
}

private struct DogWalkFace: View {
    let entry: GlettEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetContentMargins) private var margins

    var body: some View {
        let s = entry.snapshot ?? .placeholder
        Group {
            if entry.snapshot == nil {
                Text(verbatim: AppText.t("app.w.empty")).font(.caption).foregroundStyle(.secondary).padding(margins)
            } else if family == .accessoryRectangular {
                DogWalkLockView(s: s, walker: entry.walker, timeline: entry.timeline)
            } else {
                DogWalkSmallView(s: s, walker: entry.walker, timeline: entry.timeline).padding(margins)
            }
        }
        .containerBackground(for: .widget) {
            if family == .accessoryRectangular { Color.clear } else {
                DogWalkPicture(weather: DogWeather(s), walker: entry.walker, season: DogSeason(s),
                               bottomFade: entry.timeline && s.rain?.wet == true)
            }
        }
        .widgetURL(entry.link)
    }
}

/// The Live Activity "Neste glett" on the Lock Screen and in the Dynamic Island.
struct NextGlettLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NextGlettAttributes.self) { context in
            Group {
                if #available(iOS 26, *) {
                    // the system's glass behind it (no tint of our own)
                    NextGlettLockView(place: context.attributes.place, state: context.state, stale: context.isStale, glass: true)
                } else {
                    NextGlettLockView(place: context.attributes.place, state: context.state, stale: context.isStale)
                        .activityBackgroundTint(Color.glett.panel)
                        .activitySystemActionForegroundColor(Color.glett.text)
                }
            }
            .widgetURL(context.attributes.link)
        } dynamicIsland: { context in
            let s = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label { Text(verbatim: context.attributes.place).lineLimit(1) } icon: {
                        Image(systemName: s.symbol).foregroundStyle(s.tint)
                    }
                    .font(.subheadline.weight(.semibold))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    GlettCountdown(at: s.at).font(.title2.weight(.bold)).frame(maxWidth: 80, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(verbatim: s.sentence).font(.footnote)
                        ActivityBars(state: s).frame(height: 22)
                    }
                }
            } compactLeading: {
                Image(systemName: s.symbol).foregroundStyle(s.tint)
            } compactTrailing: {
                GlettCountdown(at: s.at).font(.caption.weight(.semibold)).frame(maxWidth: 40)
            } minimal: {
                Image(systemName: s.symbol).foregroundStyle(s.tint)
            }
            .keylineTint(s.tint)
            .widgetURL(context.attributes.link)
        }
    }
}
