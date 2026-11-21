// The on-screen sign that Claude is working in an app: a cursor of its own
// that glides to where it acts, with a ripple for a click, and a banner at the
// top of the screen saying what it is doing and that Esc stops it.
//
// The Computer Use plugin starts this program and writes one JSON object per line:
//   {"op": "act", "app": "...", "what": "...", "x": 100, "y": 200, "kind": "click"}
//   {"op": "hide"}
// x and y are in points from the top left of the main display and may be left
// out; the cursor then stays as it is. When the user presses Esc while the
// banner shows, this program writes "stop" on a line of its own. It ends when
// its input does.
//
// "window" in an order is the number of the window acted in. The cursor and
// its ripple sit just above that window, among the ordinary windows, so other
// windows in front of it hide them too; while that window is not on screen
// (minimized, hidden, on another space) or not named, they do not show. The
// cursor is never put over other windows. The banner stays on
// top of everything. These windows never take the keyboard or the mouse,
// never come in front of the user's work as an app, and are left out of
// screen pictures.
//
// Build: swiftc -O -swift-version 5 overlay.swift -o ClaudeOverlay
import AppKit
import QuartzCore

let accent = NSColor(srgbRed: 0.85, green: 0.47, blue: 0.34, alpha: 1)
let bannerHeight: CGFloat = 34
let cursorSize = NSSize(width: 120, height: 50)

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

final class CursorView: NSView {
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let scale: CGFloat = 1.25
        let outline: [(CGFloat, CGFloat)] = [(0, 0), (0, 17), (4.6, 13), (7.6, 19.6), (10.4, 18.4), (7.4, 12),
                                             (12.6, 12)]
        let arrow = NSBezierPath()
        arrow.move(to: NSPoint(x: 2 + outline[0].0 * scale, y: 2 + outline[0].1 * scale))
        for point in outline.dropFirst() {
            arrow.line(to: NSPoint(x: 2 + point.0 * scale, y: 2 + point.1 * scale))
        }
        arrow.close()
        arrow.lineJoinStyle = .round
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowBlurRadius = 3
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        shadow.shadowColor = NSColor(white: 0, alpha: 0.35)
        shadow.set()
        accent.setFill()
        arrow.fill()
        NSGraphicsContext.restoreGraphicsState()
        NSColor.white.setStroke()
        arrow.lineWidth = 1.5
        arrow.stroke()
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11, weight: .semibold),
                                                         .foregroundColor: NSColor.white]
        let caption = "Claude" as NSString
        let size = caption.size(withAttributes: attributes)
        let pill = NSRect(x: 18, y: 24, width: size.width + 14, height: size.height + 6)
        accent.setFill()
        NSBezierPath(roundedRect: pill, xRadius: pill.height / 2, yRadius: pill.height / 2).fill()
        caption.draw(at: NSPoint(x: pill.minX + 7, y: pill.minY + 3), withAttributes: attributes)
    }
}

final class BannerView: NSView {
    var words = ""
    var dot = accent
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

final class Overlay {
    let cursorPanel = overlayPanel(NSRect(origin: .zero, size: cursorSize), level: .normal)
    let bannerPanel = overlayPanel(NSRect(x: 0, y: 0, width: 300, height: bannerHeight))
    let bannerView = BannerView(frame: NSRect(x: 0, y: 0, width: 300, height: bannerHeight))
    var ripples: [NSPanel] = []
    var hideTimer: Timer?
    var working = false      // the banner shows work going on, so Esc stops it
    var cursorShown = false
    var generation = 0
    var target = 0           // the window acted in
    var keeper: Timer?

    init() {
        cursorPanel.contentView = CursorView(frame: NSRect(origin: .zero, size: cursorSize))
        bannerPanel.contentView = bannerView
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { self?.escape() }
        }
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
        generation += 1
        working = true
        let app = order["app"] as? String ?? ""
        let what = order["what"] as? String ?? ""
        say("Claude 正在使用「\(app)」" + (what.isEmpty ? "" : " · \(what)") + "   ·   按 Esc 停止", dot: accent)
        // An order without a place (looking, a key, a menu) leaves the cursor where it is.
        if let x = (order["x"] as? NSNumber)?.doubleValue, let y = (order["y"] as? NSNumber)?.doubleValue {
            target = (order["window"] as? NSNumber)?.intValue ?? 0
            let tip = screenPoint(CGFloat(x), CGFloat(y))
            // The arrow's tip is 2 points in from the top left of its window.
            let frame = NSRect(x: tip.x - 2, y: tip.y + 2 - cursorSize.height, width: cursorSize.width,
                               height: cursorSize.height)
            cursorPanel.alphaValue = 1
            if cursorShown {
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.3
                    context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                    cursorPanel.animator().setFrame(frame, display: true)
                }
            } else {
                cursorPanel.setFrame(frame, display: true)
                cursorShown = true
            }
            keepAboveTarget()
            keeper?.invalidate()
            keeper = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
                self?.keepAboveTarget()
            }
            if order["kind"] as? String == "click" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.ripple(at: tip) }
            }
        }
        later(4) { self.fade() }
    }

    /// Put a window just above the one acted in, or out of sight when that one is not known or not on screen:
    /// the cursor never shows over other windows.
    func place(_ panel: NSPanel) {
        if target > 0 && onScreen(target) {
            panel.order(.above, relativeTo: target)
        } else {
            panel.orderOut(nil)
        }
    }

    func keepAboveTarget() {
        guard cursorShown else { keeper?.invalidate(); return }
        place(cursorPanel)
    }

    func later(_ seconds: TimeInterval, _ work: @escaping () -> Void) {
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in work() }
    }

    func ripple(at point: NSPoint) {
        let size: CGFloat = 46
        let panel = overlayPanel(NSRect(x: point.x - size / 2, y: point.y - size / 2, width: size, height: size),
                                 level: .normal)
        let view = NSView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        view.wantsLayer = true
        let ring = CAShapeLayer()
        ring.frame = view.bounds
        ring.path = CGPath(ellipseIn: view.bounds.insetBy(dx: 3, dy: 3), transform: nil)
        ring.fillColor = accent.withAlphaComponent(0.25).cgColor
        ring.strokeColor = accent.cgColor
        ring.lineWidth = 2.5
        view.layer?.addSublayer(ring)
        panel.contentView = view
        place(panel)
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.3
        grow.toValue = 1.0
        let vanish = CABasicAnimation(keyPath: "opacity")
        vanish.fromValue = 1.0
        vanish.toValue = 0.0
        let both = CAAnimationGroup()
        both.animations = [grow, vanish]
        both.duration = 0.5
        both.fillMode = .forwards
        both.isRemovedOnCompletion = false
        ring.add(both, forKey: "ripple")
        ripples.append(panel)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) {
            panel.orderOut(nil)
            self.ripples.removeAll { $0 === panel }
        }
    }

    func fade() {
        let seen = generation
        working = false
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.35
            bannerPanel.animator().alphaValue = 0
            cursorPanel.animator().alphaValue = 0
        }, completionHandler: {
            guard seen == self.generation else { return }  // work started again meanwhile
            self.bannerPanel.orderOut(nil)
            self.cursorPanel.orderOut(nil)
            self.cursorShown = false
            self.keeper?.invalidate()
        })
    }

    func escape() {
        guard working else { return }
        working = false
        generation += 1
        FileHandle.standardOutput.write("stop\n".data(using: .utf8)!)
        cursorPanel.orderOut(nil)
        cursorShown = false
        say("已让 Claude 停止操作", dot: .systemRed)
        later(2.5) { self.fade() }
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let overlay = Overlay()
Thread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let order = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            switch order["op"] as? String {
            case "act": overlay.act(order)
            case "hide": overlay.fade()
            default: break
            }
        }
    }
    DispatchQueue.main.async { exit(0) }
}.start()
application.run()
