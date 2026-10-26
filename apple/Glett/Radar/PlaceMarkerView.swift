import MapKit
import UIKit

/// The place on the radar map (`.lm-place`, css/style.css:1270, 1303): an accent dot with a white rim and the name
/// beside it; while it rains there (MET's nowcast) the dot turns the rain colour and pulses, unless Reduce Motion is on.
final class PlaceMarkerView: MKAnnotationView {
    static let reuseID = "glett.place"

    private let dot = CAShapeLayer()
    private let pulse = CAShapeLayer()
    private let label = UILabel()

    /// Raining at the place now.
    var isWet = false { didSet { if isWet != oldValue { restyle() } } }
    var reduceMotion = false { didSet { if reduceMotion != oldValue { restyle() } } }

    /// The dot's diameter (`radius: 7`).
    static let size: CGFloat = 14

    override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        let s = Self.size
        frame = CGRect(x: 0, y: 0, width: s, height: s)
        let circle = UIBezierPath(ovalIn: bounds).cgPath
        pulse.path = circle
        pulse.frame = bounds
        pulse.opacity = 0
        dot.path = circle
        dot.lineWidth = 2
        layer.addSublayer(pulse)
        layer.addSublayer(dot)

        label.font = .preferredFont(forTextStyle: .caption1).withWeight(.bold)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .label
        label.layer.shadowColor = UIColor.systemBackground.cgColor
        label.layer.shadowOpacity = 1
        label.layer.shadowRadius = 2
        label.layer.shadowOffset = .zero
        addSubview(label)

        collisionMode = .circle
        displayPriority = .required
        canShowCallout = false
        isAccessibilityElement = true
        accessibilityTraits = .staticText
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: PlaceMarkerView, _) in view.restyle() }
        restyle()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var annotation: (any MKAnnotation)? {
        didSet { label.text = annotation?.title ?? nil; accessibilityLabel = label.text; setNeedsLayout() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.sizeToFit()
        label.frame.origin = CGPoint(x: Self.size + 4, y: (Self.size - label.frame.height) / 2)
    }

    private func restyle() {
        let fill = (UIColor(named: isWet ? "Colors/rain" : "Colors/accent") ?? .systemBlue).resolvedColor(with: traitCollection)
        dot.fillColor = fill.cgColor
        dot.strokeColor = UIColor.white.cgColor
        pulse.fillColor = fill.cgColor
        label.layer.shadowColor = UIColor.systemBackground.resolvedColor(with: traitCollection).cgColor
        pulse.removeAllAnimations()
        guard isWet, !reduceMotion else { return }
        // lm-pulse: a ring that grows and fades every 1.6 s
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 1; grow.toValue = 2.6
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.55; fade.toValue = 0
        let g = CAAnimationGroup()
        g.animations = [grow, fade]
        g.duration = 1.6
        g.timingFunction = CAMediaTimingFunction(name: .easeOut)
        g.repeatCount = .infinity
        pulse.add(g, forKey: "pulse")
    }
}

private extension UIFont {
    func withWeight(_ w: UIFont.Weight) -> UIFont {
        let d = fontDescriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: w]])
        return UIFont(descriptor: d, size: 0)
    }
}
