// The on-screen sign that Claude is working in an app: cursors of its own
// that glide to where they act, with a ripple for a click, and a banner at the
// top of the screen saying what is being done and that Esc stops it.
//
// The Computer Use plugin starts this program and writes one JSON object per line:
//   {"op": "act", "app": "...", "what": "...", "x": 100, "y": 200, "kind": "click",
//    "window": 1234, "cursor": "Claude"}
//   {"op": "hide"}
//   {"op": "ask", "id": "...", "app": "Safari", "bundle": "com.apple.Safari"}
//   {"op": "unask", "id": "..."}
// x and y are in points from the top left of the main display and may be left
// out; the cursor then stays as it is. "cursor" names the cursor: each name
// gets a cursor of its own, labelled with it, so several lines of work can
// show at once. When the user presses Esc while the banner shows, this
// program writes "stop" on a line of its own and puts every cursor away. It
// ends when its input does.
//
// "ask" shows the user a question: may Claude use this app? It is answered
// with "answer <id> always|hour|no" on a line of its own. Only a real click
// answers it: a click another program posts is ignored, so nothing that
// drives the computer can answer for the user. Esc puts it away unanswered
// ("later"), since Esc is pressed for many other things.
//
// "window" in an order is the number of the window acted in. A cursor and its
// ripple sit just above that window, among the ordinary windows, so other
// windows in front of it hide them too; while that window is not on screen
// (minimized, hidden, on another space) or not named, they do not show. A
// cursor is never put over other windows. The banner stays on top of
// everything. These windows never take the keyboard or the mouse, never come
// in front of the user's work as an app, and are left out of screen pictures.
//
// Build: swiftc -O -swift-version 5 overlay.swift -o ClaudeOverlay
import AppKit
import QuartzCore

let bannerHeight: CGFloat = 34
let defaultName = "Claude"
// Every cursor is the same see-through orange, lighter at its tip and deeper at its back.
let claudeOrange = NSColor(srgbRed: 0.85, green: 0.47, blue: 0.34, alpha: 1)
let glowLight = NSColor(srgbRed: 0.96, green: 0.66, blue: 0.40, alpha: 1)
let glowDeep = NSColor(srgbRed: 0.74, green: 0.36, blue: 0.22, alpha: 1)

func overlayPanel(_ rect: NSRect, level: NSWindow.Level = .screenSaver) -> NSPanel {
    let panel = NSPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
                        defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.level = level
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.sharingType = .none
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.animationBehavior = .none
    return panel
}

/// Whether a window, by its number, is on screen now.
func onScreen(_ number: Int) -> Bool {
    guard number > 0,
          let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(number)) as? [[String: Any]],
          let info = list.first else { return false }
    return (info[kCGWindowIsOnscreen as String] as? Bool) ?? false
}

/// A point given from the top left of the main display, in the system's own coordinates.
func screenPoint(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    return NSPoint(x: x, y: top - y)
}

func mix(_ a: NSColor, _ b: NSColor, _ amount: CGFloat) -> NSColor {
    a.blended(withFraction: amount, of: b) ?? a
}

/// Place a window just above the one acted in, or out of sight when that one is not known or not on screen.
func place(_ panel: NSPanel, above target: Int) {
    if target > 0 && onScreen(target) {
        panel.order(.above, relativeTo: target)
    } else {
        panel.orderOut(nil)
    }
}

/// One cursor: an arrow with a soft pulse at its tip and a label with its name. Drawn with layers, which are
/// animated: it leans into a move, springs on a click, wiggles while typing and bobs while scrolling.
final class Cursor {
    static let size = NSSize(width: 160, height: 72)
    static let tip = NSPoint(x: 18, y: 72 - 18)  // where the arrow points, from the bottom left of the panel

    let name: String
    let color: NSColor
    let panel: NSPanel
    let body = CALayer()     // the arrow, turned and scaled about its tip
    let halo = CAShapeLayer()
    var target = 0
    var shown = false
    var keeper: Timer?
    var fader: Timer?
    var generation = 0

    init(name: String, color: NSColor) {
        self.name = name
        self.color = color
        panel = overlayPanel(NSRect(origin: .zero, size: Cursor.size), level: .normal)
        let view = NSView(frame: NSRect(origin: .zero, size: Cursor.size))
        view.wantsLayer = true
        let root = view.layer!
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let tip = Cursor.tip

        // A ring that pulses out from the tip while the cursor is up.
        let ring: CGFloat = 26
        halo.frame = CGRect(x: tip.x - ring / 2, y: tip.y - ring / 2, width: ring, height: ring)
        halo.path = CGPath(ellipseIn: CGRect(x: 0, y: 0, width: ring, height: ring), transform: nil)
        halo.fillColor = color.withAlphaComponent(0.22).cgColor
        halo.strokeColor = color.withAlphaComponent(0.55).cgColor
        halo.lineWidth = 1.5
        halo.opacity = 0
        root.addSublayer(halo)

        // The arrow, with its tip at the anchor point so turns and springs happen about the tip.
        body.frame = CGRect(origin: .zero, size: Cursor.size)
        body.anchorPoint = CGPoint(x: tip.x / Cursor.size.width, y: tip.y / Cursor.size.height)
        body.position = tip
        // A rounded arrowhead pointing up and to the left, with a notch at its back. Each corner is
        // rounded by arcs, so the shape is soft; the tip the least, set back so its rounded point is the exact spot.
        let k: CGFloat = 2.4
        let corners: [(CGFloat, CGFloat, CGFloat)] = [(-0.58, -0.58, 0.6), (10.2, 3.7, 1.3), (5.9, 5.9, 0.8), (3.7, 10.2, 1.3)]
        func at(_ c: (CGFloat, CGFloat, CGFloat)) -> CGPoint { CGPoint(x: tip.x + c.0 * k, y: tip.y - c.1 * k) }
        let arrow = CGMutablePath()
        let first = at(corners[0]), last = at(corners[corners.count - 1])
        arrow.move(to: CGPoint(x: (first.x + last.x) / 2, y: (first.y + last.y) / 2))
        for index in 0..<corners.count {
            let corner = corners[index], next = corners[(index + 1) % corners.count]
            arrow.addArc(tangent1End: at(corner), tangent2End: at(next), radius: corner.2 * k)
        }
        arrow.closeSubpath()
        // A soft orange glow rather than a dark shadow, which would show through the clear fill.
        body.shadowPath = arrow
        body.shadowColor = color.cgColor
        body.shadowOpacity = 0.55
        body.shadowRadius = 5
        body.shadowOffset = .zero
        let fill = CAGradientLayer()
        fill.frame = body.bounds
        fill.colors = [glowLight.withAlphaComponent(0.88).cgColor, color.withAlphaComponent(0.74).cgColor,
                       glowDeep.withAlphaComponent(0.66).cgColor]
        fill.locations = [0, 0.55, 1]
        // From the tip to the notch, along the arrow.
        fill.startPoint = CGPoint(x: tip.x / Cursor.size.width, y: tip.y / Cursor.size.height)
        fill.endPoint = CGPoint(x: (tip.x + 8 * k) / Cursor.size.width, y: (tip.y - 8 * k) / Cursor.size.height)
        let mask = CAShapeLayer()
        mask.path = arrow
        fill.mask = mask
        body.addSublayer(fill)
        let edge = CAShapeLayer()
        edge.path = arrow
        edge.fillColor = nil
        edge.strokeColor = NSColor.white.withAlphaComponent(0.92).cgColor
        edge.lineWidth = 1.5
        edge.lineJoin = .round
        body.addSublayer(edge)

        // The name, on a pill below and to the right of the arrow.
        let caption = name == defaultName || name.lowercased().hasPrefix("claude") ? name : "Claude · \(name)"
        let font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        let words = NSAttributedString(string: caption, attributes: [.font: font, .foregroundColor: NSColor.white])
        let size = words.size()
        let pill = CAGradientLayer()
        pill.colors = [glowLight.withAlphaComponent(0.86).cgColor, color.withAlphaComponent(0.78).cgColor]
        pill.startPoint = CGPoint(x: 0, y: 1)
        pill.endPoint = CGPoint(x: 1, y: 0)
        pill.frame = CGRect(x: tip.x + 17, y: tip.y - 32 - (ceil(size.height) + 6), width: ceil(size.width) + 16,
                            height: ceil(size.height) + 6)
        pill.cornerRadius = pill.frame.height / 2
        pill.borderColor = NSColor.white.withAlphaComponent(0.7).cgColor
        pill.borderWidth = 1
        pill.shadowColor = color.cgColor
        pill.shadowOpacity = 0.4
        pill.shadowRadius = 3
        pill.shadowOffset = .zero
        let label = CATextLayer()
        label.string = words
        label.contentsScale = scale
        label.frame = CGRect(x: 8, y: 3, width: ceil(size.width) + 1, height: ceil(size.height))
        pill.addSublayer(label)
        body.addSublayer(pill)
        root.addSublayer(body)
        panel.contentView = view
    }

    func frame(at tip: NSPoint) -> NSRect {
        NSRect(x: tip.x - Cursor.tip.x, y: tip.y - Cursor.tip.y, width: Cursor.size.width, height: Cursor.size.height)
    }

    func breathe() {
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.45
        grow.toValue = 1.35
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9
        fade.toValue = 0.0
        let pulse = CAAnimationGroup()
        pulse.animations = [grow, fade]
        pulse.duration = 1.6
        pulse.timingFunction = CAMediaTimingFunction(name: .easeOut)
        pulse.repeatCount = .infinity
        halo.add(pulse, forKey: "breathe")
    }

    func appear() {
        let pop = CASpringAnimation(keyPath: "transform.scale")
        pop.fromValue = 0.4
        pop.toValue = 1.0
        pop.damping = 11
        pop.stiffness = 260
        pop.mass = 0.7
        pop.duration = pop.settlingDuration
        body.add(pop, forKey: "appear")
        let show = CABasicAnimation(keyPath: "opacity")
        show.fromValue = 0
        show.toValue = 1
        show.duration = 0.18
        body.add(show, forKey: "show")
    }

    /// Lean the arrow toward where it is going, and let it swing back upright when it gets there.
    func lean(dx: CGFloat, over seconds: Double) {
        let angle = max(-1, min(1, dx / 260)) * -0.30
        let swing = CAKeyframeAnimation(keyPath: "transform.rotation.z")
        swing.values = [0, angle, -angle * 0.35, angle * 0.12, 0]
        swing.keyTimes = [0, 0.35, 0.72, 0.88, 1]
        swing.duration = seconds + 0.25
        swing.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut),
                                 CAMediaTimingFunction(name: .easeInEaseOut), CAMediaTimingFunction(name: .easeIn)]
        body.add(swing, forKey: "lean")
    }

    func press() {
        let squash = CAKeyframeAnimation(keyPath: "transform.scale")
        squash.values = [1.0, 0.74, 1.12, 0.96, 1.0]
        squash.keyTimes = [0, 0.25, 0.55, 0.8, 1]
        squash.duration = 0.42
        body.add(squash, forKey: "press")
    }

    func wiggle() {
        let shake = CAKeyframeAnimation(keyPath: "transform.rotation.z")
        shake.values = [0, 0.14, -0.11, 0.08, -0.05, 0]
        shake.duration = 0.55
        body.add(shake, forKey: "wiggle")
    }

    func bob() {
        let move = CAKeyframeAnimation(keyPath: "transform.translation.y")
        move.values = [0, -7, 4, -2, 0]
        move.duration = 0.5
        body.add(move, forKey: "bob")
    }

    func keepAbove() {
        guard shown else { keeper?.invalidate(); return }
        place(panel, above: target)
    }
}

final class BannerView: NSView {
    var words = ""
    var dot = claudeOrange
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13, weight: .medium),
                                                     .foregroundColor: NSColor.white]
    override var isFlipped: Bool { true }

    func wanted() -> CGFloat { (words as NSString).size(withAttributes: attributes).width + 48 }

    override func draw(_ dirtyRect: NSRect) {
        let shape = bounds.insetBy(dx: 1, dy: 1)
        let back = NSBezierPath(roundedRect: shape, xRadius: shape.height / 2, yRadius: shape.height / 2)
        NSColor(white: 0.1, alpha: 0.86).setFill()
        back.fill()
        NSColor(white: 1, alpha: 0.18).setStroke()
        back.lineWidth = 1
        back.stroke()
        dot.setFill()
        NSBezierPath(ovalIn: NSRect(x: 16, y: bounds.midY - 4, width: 8, height: 8)).fill()
        let size = (words as NSString).size(withAttributes: attributes)
        (words as NSString).draw(in: NSRect(x: 32, y: bounds.midY - size.height / 2, width: bounds.width - 44,
                                            height: size.height), withAttributes: attributes)
    }
}

/// One answer to the question, drawn here rather than by the system, so it looks the same on every Mac and in
/// every appearance, and takes the first click on a panel that is never active.
final class Choice: NSView {
    let key: String
    let filled: Bool
    var action: ((Choice, NSEvent) -> Void)?
    private var down = false

    init(key: String, words: String, filled: Bool) {
        self.key = key
        self.filled = filled
        let font = NSFont.systemFont(ofSize: 12.5, weight: .semibold)
        let size = (words as NSString).size(withAttributes: [.font: font])
        super.init(frame: NSRect(x: 0, y: 0, width: max(ceil(size.width) + 28, 80), height: 28))
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.borderWidth = filled ? 0 : 1
        layer?.borderColor = NSColor(white: 1, alpha: 0.35).cgColor
        paint()
        let label = NSTextField(labelWithString: words)
        label.font = font
        label.textColor = .white
        label.alignment = .center
        label.frame = NSRect(x: 0, y: (28 - ceil(size.height)) / 2 - 1, width: frame.width, height: ceil(size.height))
        addSubview(label)
    }

    required init?(coder: NSCoder) { nil }

    func paint() {
        let base = filled ? claudeOrange : NSColor(white: 1, alpha: 0.10)
        layer?.backgroundColor = (down ? mix(base, filled ? .black : .white, 0.2) : base).cgColor
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { frame.contains(point) ? self : nil }
    override func mouseDown(with event: NSEvent) { down = true; paint() }
    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        down = false
        paint()
        if inside { action?(self, event) }
    }
}

/// The question whether Claude may use an app, near the top of the screen, above everything. It never takes the
/// keyboard or comes in front as an app, and is left out of screen pictures, as the cursors are.
final class Question: NSObject {
    static let size = NSSize(width: 400, height: 128)
    let id: String
    let panel: NSPanel
    let reply: (String, String) -> Void

    init(id: String, app: String, bundle: String, reply: @escaping (String, String) -> Void) {
        self.id = id
        self.reply = reply
        panel = overlayPanel(NSRect(origin: .zero, size: Question.size))
        panel.ignoresMouseEvents = false
        super.init()
        let view = NSView(frame: NSRect(origin: .zero, size: Question.size))
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor(white: 0.1, alpha: 0.94).cgColor
        view.layer?.cornerRadius = 14
        view.layer?.borderWidth = 1
        view.layer?.borderColor = claudeOrange.withAlphaComponent(0.7).cgColor

        let dot = NSView(frame: NSRect(x: 18, y: Question.size.height - 31, width: 10, height: 10))
        dot.wantsLayer = true
        dot.layer?.backgroundColor = claudeOrange.cgColor
        dot.layer?.cornerRadius = 5
        view.addSubview(dot)
        let title = NSTextField(labelWithString: "Claude 想要操作「\(app)」")
        title.font = .systemFont(ofSize: 14, weight: .semibold)
        title.textColor = .white
        title.lineBreakMode = .byTruncatingTail
        title.frame = NSRect(x: 36, y: Question.size.height - 37, width: Question.size.width - 52, height: 20)
        view.addSubview(title)
        let note = NSTextField(wrappingLabelWithString:
            "允许后它能读取这个应用的窗口并在里面点击、输入。\(bundle)\n选择保存在插件目录的 app-grants.json，可随时修改。")
        note.font = .systemFont(ofSize: 11)
        note.textColor = NSColor(white: 0.75, alpha: 1)
        note.frame = NSRect(x: 18, y: 50, width: Question.size.width - 36, height: 36)
        view.addSubview(note)

        let answers: [(String, String)] = [("no", "不允许"), ("hour", "允许 1 小时"), ("always", "始终允许")]
        var right = Question.size.width - 16
        for (key, words) in answers.reversed() {
            let choice = Choice(key: key, words: words, filled: key == "always")
            right -= choice.frame.width
            choice.frame.origin = NSPoint(x: right, y: 14)
            choice.action = { [weak self] choice, event in self?.pressed(choice, event) }
            view.addSubview(choice)
            right -= 8
        }
        panel.contentView = view
    }

    func show(at index: Int) {
        guard let screen = NSScreen.screens.first else { return }
        let frame = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x: frame.midX - Question.size.width / 2,
                                     y: frame.maxY - bannerHeight - 22 - CGFloat(index + 1) * (Question.size.height + 8)))
        panel.alphaValue = 1
        panel.orderFrontRegardless()
    }

    /// A click counts only when it came from the user's own mouse or trackpad, not from a program posting it.
    func pressed(_ choice: Choice, _ event: NSEvent) {
        let source = event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1
        if source != 0 && source != Int64(getpid()) {
            let shake = CAKeyframeAnimation(keyPath: "transform.translation.x")
            shake.values = [0, -6, 6, -4, 4, 0]
            shake.duration = 0.3
            panel.contentView?.layer?.add(shake, forKey: "no")
            return
        }
        reply(id, choice.key)
    }

    /// A picture of the question, for checking how it looks without showing it.
    func snapshot(to path: String) {
        guard let view = panel.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }

    func close() { panel.orderOut(nil) }
}

final class Overlay {
    let bannerPanel = overlayPanel(NSRect(x: 0, y: 0, width: 300, height: bannerHeight))
    let bannerView = BannerView(frame: NSRect(x: 0, y: 0, width: 300, height: bannerHeight))
    var cursors: [String: Cursor] = [:]
    var ripples: [NSPanel] = []
    var bannerTimer: Timer?
    var working = false      // the banner shows work going on, so Esc stops it
    var bannerGeneration = 0
    var questions: [Question] = []

    init() {
        bannerPanel.contentView = bannerView
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { self?.escape() }
        }
    }

    func cursor(named name: String) -> Cursor {
        if let found = cursors[name] { return found }
        let made = Cursor(name: name, color: claudeOrange)
        cursors[name] = made
        return made
    }

    func say(_ words: String, dot: NSColor) {
        guard let screen = NSScreen.screens.first else { return }
        bannerView.words = words
        bannerView.dot = dot
        let width = min(bannerView.wanted(), screen.visibleFrame.width - 40)
        let frame = NSRect(x: screen.visibleFrame.midX - width / 2, y: screen.visibleFrame.maxY - bannerHeight - 10,
                           width: width, height: bannerHeight)
        bannerPanel.setFrame(frame, display: false)
        bannerView.frame = NSRect(origin: .zero, size: frame.size)
        bannerView.needsDisplay = true
        bannerPanel.alphaValue = 1
        bannerPanel.orderFrontRegardless()
    }

    func act(_ order: [String: Any]) {
        working = true
        let name = (order["cursor"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? defaultName
        let cursor = cursor(named: name)
        let app = order["app"] as? String ?? ""
        let what = order["what"] as? String ?? ""
        let who = name == defaultName ? "Claude" : "Claude（\(name)）"
        let busy = cursors.values.filter { $0.shown || $0 === cursor }.count
        say("\(who) 正在使用「\(app)」" + (what.isEmpty ? "" : " · \(what)")
            + (busy > 1 ? "   ·   \(busy) 个光标在工作" : "") + "   ·   按 Esc 停止", dot: cursor.color)
        bannerGeneration += 1
        let seenBanner = bannerGeneration
        bannerTimer?.invalidate()
        bannerTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
            guard let self = self, seenBanner == self.bannerGeneration else { return }
            self.fadeBanner()
        }
        cursor.generation += 1
        let seen = cursor.generation
        cursor.fader?.invalidate()
        cursor.fader = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
            guard seen == cursor.generation else { return }
            self?.fade(cursor)
        }
        guard let x = (order["x"] as? NSNumber)?.doubleValue, let y = (order["y"] as? NSNumber)?.doubleValue else {
            return  // an order without a place (looking, a key, a menu) leaves the cursor where it is
        }
        cursor.target = (order["window"] as? NSNumber)?.intValue ?? 0
        let tip = screenPoint(CGFloat(x), CGFloat(y))
        let frame = cursor.frame(at: tip)
        let kind = order["kind"] as? String ?? ""
        cursor.panel.alphaValue = 1
        var travel = 0.0
        if cursor.shown {
            let from = cursor.panel.frame.origin
            let distance = hypot(frame.origin.x - from.x, frame.origin.y - from.y)
            travel = distance < 2 ? 0 : min(0.5, max(0.22, Double(distance) / 1600))
            if travel > 0 {
                cursor.lean(dx: frame.origin.x - from.x, over: travel)
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = travel
                    context.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 1.25, 0.5, 1)
                    cursor.panel.animator().setFrame(frame, display: true)
                }
            }
        } else {
            cursor.panel.setFrame(frame, display: true)
            cursor.shown = true
            cursor.halo.opacity = 1
            place(cursor.panel, above: cursor.target)
            cursor.appear()
            cursor.breathe()
        }
        place(cursor.panel, above: cursor.target)
        cursor.keeper?.invalidate()
        cursor.keeper = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in cursor.keepAbove() }
        let arrive = max(travel, 0.12)
        DispatchQueue.main.asyncAfter(deadline: .now() + arrive) {
            switch kind {
            case "click":
                cursor.press()
                self.ripple(at: tip, color: cursor.color, above: cursor.target)
            case "type": cursor.wiggle()
            case "scroll": cursor.bob()
            default: break
            }
        }
    }

    func ripple(at point: NSPoint, color: NSColor, above target: Int) {
        let size: CGFloat = 64
        let panel = overlayPanel(NSRect(x: point.x - size / 2, y: point.y - size / 2, width: size, height: size),
                                 level: .normal)
        let view = NSView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        view.wantsLayer = true
        for (index, delay) in [0.0, 0.12].enumerated() {
            let ring = CAShapeLayer()
            ring.frame = view.bounds
            ring.path = CGPath(ellipseIn: view.bounds.insetBy(dx: 4, dy: 4), transform: nil)
            ring.fillColor = index == 0 ? color.withAlphaComponent(0.22).cgColor : NSColor.clear.cgColor
            ring.strokeColor = color.cgColor
            ring.lineWidth = index == 0 ? 2.5 : 1.5
            ring.opacity = 0
            view.layer?.addSublayer(ring)
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = 0.2
            grow.toValue = 1.0
            let vanish = CAKeyframeAnimation(keyPath: "opacity")
            vanish.values = [0.0, 1.0, 0.0]
            vanish.keyTimes = [0, 0.15, 1]
            let both = CAAnimationGroup()
            both.animations = [grow, vanish]
            both.duration = 0.55
            both.beginTime = CACurrentMediaTime() + delay
            both.timingFunction = CAMediaTimingFunction(name: .easeOut)
            both.fillMode = .both
            both.isRemovedOnCompletion = false
            ring.add(both, forKey: "ripple")
        }
        panel.contentView = view
        place(panel, above: target)
        ripples.append(panel)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            panel.orderOut(nil)
            self.ripples.removeAll { $0 === panel }
        }
    }

    func fade(_ cursor: Cursor) {
        let seen = cursor.generation
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.35
            cursor.panel.animator().alphaValue = 0
        }, completionHandler: {
            guard seen == cursor.generation else { return }  // it was put to work again meanwhile
            cursor.panel.orderOut(nil)
            cursor.shown = false
            cursor.keeper?.invalidate()
            cursor.halo.removeAllAnimations()
        })
    }

    func fadeBanner() {
        let seen = bannerGeneration
        working = false
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.35
            bannerPanel.animator().alphaValue = 0
        }, completionHandler: {
            guard seen == self.bannerGeneration else { return }
            self.bannerPanel.orderOut(nil)
        })
    }

    func hideAll() {
        for cursor in cursors.values {
            cursor.generation += 1
            cursor.fader?.invalidate()
            cursor.keeper?.invalidate()
            cursor.panel.orderOut(nil)
            cursor.shown = false
            cursor.halo.removeAllAnimations()
        }
    }

    func ask(_ order: [String: Any]) {
        guard let id = order["id"] as? String else { return }
        let question = Question(id: id, app: order["app"] as? String ?? "这个应用",
                                bundle: order["bundle"] as? String ?? "") { [weak self] id, answer in
            self?.answer(id, answer)
        }
        questions.append(question)
        arrangeQuestions()
    }

    func answer(_ id: String, _ answer: String) {
        guard questions.contains(where: { $0.id == id }) else { return }
        FileHandle.standardOutput.write("answer \(id) \(answer)\n".data(using: .utf8)!)
        unask(id)
    }

    func unask(_ id: String) {
        questions.filter { $0.id == id }.forEach { $0.close() }
        questions.removeAll { $0.id == id }
        arrangeQuestions()
    }

    func arrangeQuestions() {
        for (index, question) in questions.enumerated() { question.show(at: index) }
    }

    func escape() {
        if !questions.isEmpty {
            questions.map { $0.id }.forEach { answer($0, "later") }
        }
        guard working else { return }
        working = false
        FileHandle.standardOutput.write("stop\n".data(using: .utf8)!)
        hideAll()
        say("已让 Claude 停止操作", dot: .systemRed)
        bannerGeneration += 1
        let seen = bannerGeneration
        bannerTimer?.invalidate()
        bannerTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in
            guard let self = self, seen == self.bannerGeneration else { return }
            self.fadeBanner()
        }
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--picture-of-question" {
    Question(id: "0", app: "Safari", bundle: "com.apple.Safari") { _, _ in }.snapshot(to: CommandLine.arguments[2])
    exit(0)
}
let overlay = Overlay()
Thread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let order = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            switch order["op"] as? String {
            case "act": overlay.act(order)
            case "ask": overlay.ask(order)
            case "unask": if let id = order["id"] as? String { overlay.unask(id) }
            case "hide":
                overlay.hideAll()
                overlay.fadeBanner()
            default: break
            }
        }
    }
    DispatchQueue.main.async { exit(0) }
}.start()
application.run()
