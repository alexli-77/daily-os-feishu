import AppKit
import AVFoundation
import CoreImage
import Foundation

private enum Constants {
  static let launchAgentLabel = "com.daily-os-feishu.agent"
  static let floatingBadgeSize = NSSize(width: 84, height: 84)
  static let penguinImageSize = NSSize(width: 68, height: 68)
  static let floatingPeekVisibleWidth: CGFloat = 34
  static let floatingEdgeMargin: CGFloat = 10
  static let todoPreviewCardSize = NSSize(width: 260, height: 236)
  static let quickCaptureCardSize = NSSize(width: 286, height: 214)
  static let todoCardCornerRadius: CGFloat = 38
  static let effectFileNames = [
    "penguin-fx-video.mp4",
    "penguin-fx-video-alt.mp4",
    "penguin-fx-thinking.mp4",
    "penguin-fx-celebrating.mp4",
    "penguin-fx-roll.mov",
    "penguin-fx-jump.mov"
  ]
}

private struct TodoCardItem {
  let text: String
  let type: String
  let due: String?
}

final class CompanionActionButton: NSButton {
  var onClick: (() -> Void)?

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    target = self
    action = #selector(runClick)
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    target = self
    action = #selector(runClick)
  }

  @objc private func runClick() {
    onClick?()
  }
}

final class TodoCardPanel: NSPanel {
  override var canBecomeKey: Bool {
    true
  }

  override var canBecomeMain: Bool {
    true
  }
}

final class FloatingBadgeButton: NSButton {
  var idleImage: NSImage?
  var blinkImage: NSImage?
  var onHoverStart: ((NSRect) -> Void)?
  var onHoverEnd: (() -> Void)?
  var onMoved: ((NSRect) -> Void)?

  private var trackingArea: NSTrackingArea?
  private var blinkWorkItems: [DispatchWorkItem] = []

  private var effectPlayer: AVPlayer?
  private var effectLayer: AVPlayerLayer?
  private var effectEndObserver: NSObjectProtocol?
  private var isPlayingEffect = false
  private static let transparentBlackKernel = CIColorKernel(source: """
  kernel vec4 transparentBlack(__sample pixel) {
    float key = max(max(pixel.r, pixel.g), pixel.b);
    if (key < 0.018) {
      return vec4(pixel.r, pixel.g, pixel.b, 0.0);
    }
    return pixel;
  }
  """)

  override func highlight(_ flag: Bool) {
    // Keep the desktop character visually stable while pressed.
  }

  override func updateTrackingAreas() {
    if let trackingArea {
      removeTrackingArea(trackingArea)
    }

    let options: NSTrackingArea.Options = [.mouseEnteredAndExited, .activeAlways, .inVisibleRect]
    let nextTrackingArea = NSTrackingArea(rect: bounds, options: options, owner: self, userInfo: nil)
    addTrackingArea(nextTrackingArea)
    trackingArea = nextTrackingArea
    super.updateTrackingAreas()
  }

  override func mouseEntered(with event: NSEvent) {
    onHoverStart?(window?.frame ?? .zero)
    guard !isPlayingEffect else {
      return
    }
    playBlink()
  }

  override func mouseExited(with event: NSEvent) {
    onHoverEnd?()
    guard !isPlayingEffect else {
      return
    }
    showIdleImage()
  }

  override func mouseDown(with event: NSEvent) {
    guard let window else {
      super.mouseDown(with: event)
      return
    }

    let startMouse = NSEvent.mouseLocation
    let startFrame = window.frame
    var didDrag = false

    while let nextEvent = NSApp.nextEvent(
      matching: [.leftMouseDragged, .leftMouseUp],
      until: .distantFuture,
      inMode: .eventTracking,
      dequeue: true
    ) {
      switch nextEvent.type {
      case .leftMouseDragged:
        let currentMouse = NSEvent.mouseLocation
        let deltaX = currentMouse.x - startMouse.x
        let deltaY = currentMouse.y - startMouse.y
        if abs(deltaX) > 3 || abs(deltaY) > 3 {
          didDrag = true
        }
        window.setFrameOrigin(NSPoint(x: startFrame.origin.x + deltaX, y: startFrame.origin.y + deltaY))
        onMoved?(window.frame)
      case .leftMouseUp:
        if !didDrag {
          if let action {
            _ = NSApp.sendAction(action, to: target, from: self)
          }
        }
        return
      default:
        break
      }
    }
  }

  func playEffect(url: URL) {
    cancelBlink()
    stopEffect()

    let item = effectPlayerItem(for: url)
    let player = AVPlayer(playerItem: item)
    player.actionAtItemEnd = .pause

    let layer = AVPlayerLayer(player: player)
    layer.frame = bounds
    layer.videoGravity = .resizeAspect
    layer.backgroundColor = NSColor.clear.cgColor

    wantsLayer = true
    self.layer?.addSublayer(layer)
    image = nil
    isPlayingEffect = true

    effectPlayer = player
    effectLayer = layer
    effectEndObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: player.currentItem,
      queue: .main
    ) { [weak self] _ in
      self?.stopEffect()
    }

    player.play()
  }

  private func stopEffect() {
    if let effectEndObserver {
      NotificationCenter.default.removeObserver(effectEndObserver)
    }
    effectEndObserver = nil
    effectPlayer?.pause()
    effectPlayer = nil
    effectLayer?.removeFromSuperlayer()
    effectLayer = nil
    isPlayingEffect = false
    setIdleImage()
  }

  private func effectPlayerItem(for url: URL) -> AVPlayerItem {
    let asset = AVURLAsset(url: url)
    let item = AVPlayerItem(asset: asset)
    if url.pathExtension.lowercased() == "mp4" {
      item.videoComposition = AVMutableVideoComposition(asset: asset) { request in
        let source = request.sourceImage
        guard let keyed = Self.transparentBlackKernel?.apply(extent: source.extent, arguments: [source]) else {
          request.finish(with: source, context: nil)
          return
        }
        request.finish(with: keyed, context: nil)
      }
    }
    return item
  }

  private func playBlink() {
    guard blinkImage != nil else {
      return
    }

    cancelBlink()
    setBlinkImage()
    scheduleBlinkFrame(after: 0.10) { [weak self] in self?.setIdleImage() }
    scheduleBlinkFrame(after: 0.22) { [weak self] in self?.setBlinkImage() }
    scheduleBlinkFrame(after: 0.32) { [weak self] in self?.setIdleImage() }
  }

  private func showIdleImage() {
    cancelBlink()
    setIdleImage()
  }

  private func setIdleImage() {
    if let idleImage {
      image = idleImage
    }
  }

  private func setBlinkImage() {
    if let blinkImage {
      image = blinkImage
    }
  }

  private func scheduleBlinkFrame(after delay: TimeInterval, _ frame: @escaping () -> Void) {
    let workItem = DispatchWorkItem(block: frame)
    blinkWorkItems.append(workItem)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
  }

  private func cancelBlink() {
    blinkWorkItems.forEach { $0.cancel() }
    blinkWorkItems.removeAll()
  }
}

final class CloudBubbleView: NSView {
  override var isOpaque: Bool {
    false
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)

    let body = cloudPath(in: bounds.insetBy(dx: 7, dy: 9))
    NSColor.white.setFill()
    body.fill()

    NSColor(calibratedWhite: 0.78, alpha: 0.22).setStroke()
    body.lineWidth = 1
    body.stroke()

    drawHighlight(in: bounds)
  }

  private func cloudPath(in rect: NSRect) -> NSBezierPath {
    let path = NSBezierPath()
    let minX = rect.minX
    let maxX = rect.maxX
    let minY = rect.minY + 22
    let maxY = rect.maxY - 6
    let width = rect.width
    let height = maxY - minY

    path.move(to: NSPoint(x: minX + width * 0.10, y: minY + height * 0.44))
    path.curve(
      to: NSPoint(x: minX + width * 0.30, y: minY + height * 0.78),
      controlPoint1: NSPoint(x: minX + width * 0.04, y: minY + height * 0.62),
      controlPoint2: NSPoint(x: minX + width * 0.14, y: minY + height * 0.82)
    )
    path.curve(
      to: NSPoint(x: minX + width * 0.54, y: maxY),
      controlPoint1: NSPoint(x: minX + width * 0.34, y: minY + height * 0.98),
      controlPoint2: NSPoint(x: minX + width * 0.47, y: maxY + 10)
    )
    path.curve(
      to: NSPoint(x: minX + width * 0.78, y: minY + height * 0.78),
      controlPoint1: NSPoint(x: minX + width * 0.65, y: maxY + 2),
      controlPoint2: NSPoint(x: minX + width * 0.70, y: minY + height * 0.80)
    )
    path.curve(
      to: NSPoint(x: maxX - 12, y: minY + height * 0.50),
      controlPoint1: NSPoint(x: minX + width * 0.92, y: minY + height * 0.84),
      controlPoint2: NSPoint(x: maxX, y: minY + height * 0.68)
    )
    path.curve(
      to: NSPoint(x: minX + width * 0.72, y: minY + height * 0.20),
      controlPoint1: NSPoint(x: maxX - 4, y: minY + height * 0.28),
      controlPoint2: NSPoint(x: minX + width * 0.88, y: minY + height * 0.12)
    )
    path.curve(
      to: NSPoint(x: minX + width * 0.84, y: rect.minY + 10),
      controlPoint1: NSPoint(x: minX + width * 0.75, y: minY + height * 0.04),
      controlPoint2: NSPoint(x: minX + width * 0.80, y: rect.minY + 8)
    )
    path.curve(
      to: NSPoint(x: minX + width * 0.63, y: minY + height * 0.18),
      controlPoint1: NSPoint(x: minX + width * 0.76, y: rect.minY + 7),
      controlPoint2: NSPoint(x: minX + width * 0.68, y: minY + height * 0.08)
    )
    path.curve(
      to: NSPoint(x: minX + width * 0.34, y: minY + height * 0.18),
      controlPoint1: NSPoint(x: minX + width * 0.56, y: minY + height * 0.04),
      controlPoint2: NSPoint(x: minX + width * 0.42, y: minY + height * 0.02)
    )
    path.curve(
      to: NSPoint(x: minX + width * 0.10, y: minY + height * 0.44),
      controlPoint1: NSPoint(x: minX + width * 0.18, y: minY + height * 0.10),
      controlPoint2: NSPoint(x: minX + width * 0.04, y: minY + height * 0.22)
    )
    path.close()
    return path
  }

  private func drawHighlight(in rect: NSRect) {
    NSColor(calibratedWhite: 1, alpha: 0.45).setFill()
    NSBezierPath(ovalIn: NSRect(x: rect.maxX - 86, y: rect.maxY - 74, width: 44, height: 24)).fill()
    NSBezierPath(ovalIn: NSRect(x: rect.maxX - 54, y: rect.maxY - 96, width: 30, height: 18)).fill()
  }
}

final class QuoteReminderCardView: NSView {
  override var isOpaque: Bool {
    false
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)

    let cardRect = bounds.insetBy(dx: 28, dy: 28)
    let card = NSBezierPath(roundedRect: cardRect, xRadius: 28, yRadius: 28)
    NSColor(calibratedWhite: 0.98, alpha: 0.98).setFill()
    card.fill()

    NSColor(calibratedWhite: 0.84, alpha: 0.26).setStroke()
    card.lineWidth = 1
    card.stroke()

    let highlight = NSBezierPath(roundedRect: cardRect.insetBy(dx: 5, dy: 5), xRadius: 23, yRadius: 23)
    NSColor(calibratedWhite: 1, alpha: 0.34).setStroke()
    highlight.lineWidth = 1
    highlight.stroke()

    drawQuote("“", at: NSPoint(x: cardRect.minX - 11, y: cardRect.maxY - 36), size: 54)
    drawQuote("”", at: NSPoint(x: cardRect.maxX - 36, y: cardRect.minY + 2), size: 54)
  }

  private func drawQuote(_ text: String, at point: NSPoint, size: CGFloat) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: size, weight: .heavy),
      .foregroundColor: NSColor(calibratedRed: 0.01, green: 0.55, blue: 0.86, alpha: 0.95),
      .paragraphStyle: paragraph
    ]
    (text as NSString).draw(
      in: NSRect(x: point.x, y: point.y, width: 58, height: 58),
      withAttributes: attributes
    )
  }
}

final class DailyOSCompanionApp: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var floatingWindows: [NSPanel] = []
  private var floatingButtons: [FloatingBadgeButton] = []
  private var todoCardPanel: NSPanel?
  private var todoCardIsHoverPreview = false
  private var isHoveringFloatingBadge = false
  private var cachedTodoItems: [TodoCardItem] = []
  private var todoCardAnchorFrame: NSRect?
  private let repoRoot = RepositoryLocator.find()

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    configureStatusButton(isBusy: false)
    rebuildMenu()
    showFloatingBadge()
    showRequestedTestCardIfNeeded()
    refreshTodoCache()
  }

  private func configureStatusButton(isBusy: Bool) {
    guard let button = statusItem.button else {
      return
    }

    button.title = isBusy ? "DO*" : "DO"
    button.image = nil
    button.toolTip = "Daily OS"
    for floatingButton in floatingButtons {
      floatingButton.alphaValue = isBusy ? 0.78 : 1.0
    }
  }

  private func rebuildMenu(status: String? = nil) {
    let menu = NSMenu()

    if let status {
      let statusItem = NSMenuItem(title: status, action: nil, keyEquivalent: "")
      statusItem.isEnabled = false
      menu.addItem(statusItem)
      menu.addItem(.separator())
    }

    menu.addItem(item("Open Dashboard", #selector(openDashboard), "o"))
    menu.addItem(item("Run Daily Plan", #selector(runDailyPlan), "p"))
    menu.addItem(item("Run Daily Review", #selector(runDailyReview), "r"))
    menu.addItem(item("Run Weekly Review", #selector(runWeeklyReview), "w"))
    menu.addItem(.separator())
    menu.addItem(item("Random Effect", #selector(playRandomEffect), "e"))
    menu.addItem(.separator())
    menu.addItem(item("Recent Runs", #selector(showRecentRuns), "l"))
    menu.addItem(item("Service Status", #selector(showServiceStatus), "s"))
    menu.addItem(item("Run Checks", #selector(runChecks), "d"))
    menu.addItem(item("Restart Service", #selector(restartService), "k"))
    menu.addItem(.separator())
    menu.addItem(item("Quit", #selector(quit), "q"))

    statusItem.menu = menu
  }

  private func showFloatingBadge() {
    guard floatingWindows.isEmpty else {
      return
    }

    for screen in NSScreen.screens {
      let button = FloatingBadgeButton(frame: NSRect(origin: .zero, size: Constants.floatingBadgeSize))
      button.target = self
      button.action = #selector(showFloatingMenu(_:))
      configureFloatingButton(button, isBusy: false)

      let panel = NSPanel(
        contentRect: NSRect(origin: .zero, size: Constants.floatingBadgeSize),
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered,
        defer: false
      )
      panel.contentView = button
      panel.backgroundColor = .clear
      panel.isOpaque = false
      panel.hasShadow = true
      panel.level = .statusBar
      panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      panel.isMovableByWindowBackground = true

      button.onHoverStart = { [weak self, weak panel] _ in
        guard let self, let panel else {
          return
        }
        let expandedFrame = self.setFloatingBadge(panel, collapsed: false)
        self.showHoverTodoPreview(anchorFrame: expandedFrame)
      }
      button.onHoverEnd = { [weak self, weak panel] in
        self?.closeHoverTodoPreview()
        if let panel {
          _ = self?.setFloatingBadge(panel, collapsed: true)
        }
      }
      button.onMoved = { [weak self] anchorFrame in self?.updateHoverTodoCardPosition(anchorFrame: anchorFrame) }

      let frame = screen.visibleFrame
      panel.setFrameOrigin(
        NSPoint(
          x: frame.maxX - Constants.floatingPeekVisibleWidth,
          y: frame.maxY - Constants.floatingBadgeSize.height - 24
        )
      )

      floatingButtons.append(button)
      floatingWindows.append(panel)
      panel.orderFrontRegardless()
    }
  }

  @discardableResult
  private func setFloatingBadge(_ panel: NSPanel, collapsed: Bool) -> NSRect {
    let currentFrame = panel.frame
    let screenFrame = visibleFrame(for: currentFrame)
    let nextFrame = floatingBadgeFrame(from: currentFrame, screenFrame: screenFrame, collapsed: collapsed)
    panel.setFrame(nextFrame, display: true)
    return nextFrame
  }

  private func floatingBadgeFrame(from currentFrame: NSRect, screenFrame: NSRect, collapsed: Bool) -> NSRect {
    let y = min(
      max(currentFrame.origin.y, screenFrame.minY + Constants.floatingEdgeMargin),
      screenFrame.maxY - Constants.floatingBadgeSize.height - Constants.floatingEdgeMargin
    )
    let x = collapsed
      ? screenFrame.maxX - Constants.floatingPeekVisibleWidth
      : screenFrame.maxX - Constants.floatingBadgeSize.width

    return NSRect(origin: NSPoint(x: x, y: y), size: Constants.floatingBadgeSize)
  }

  private func configureFloatingButton(_ button: FloatingBadgeButton, isBusy: Bool) {
    button.isBordered = false
    button.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .bold)
    button.contentTintColor = nil
    button.toolTip = "Daily OS"
    button.wantsLayer = true
    button.layer?.backgroundColor = NSColor.clear.cgColor
    button.layer?.cornerRadius = 18
    button.layer?.masksToBounds = false
    button.alphaValue = isBusy ? 0.78 : 1

    if let idleImage = penguinImage(named: "penguin-idle.png") ?? penguinImage(named: "penguin-avatar.png") {
      button.title = ""
      button.idleImage = idleImage
      button.blinkImage = penguinImage(named: "penguin-blink.png")
      button.image = idleImage
      button.imagePosition = .imageOnly
      button.imageScaling = .scaleProportionallyUpOrDown
    } else {
      button.idleImage = nil
      button.blinkImage = nil
      button.title = isBusy ? "DO*" : "DO"
      button.image = nil
      button.contentTintColor = .white
      button.layer?.backgroundColor = NSColor.systemBlue.cgColor
    }
  }

  private func item(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
    let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: key)
    menuItem.target = self
    return menuItem
  }

  @objc private func showFloatingMenu(_ sender: NSButton) {
    todoCardAnchorFrame = sender.window?.frame
    rebuildMenu()
    statusItem.menu?.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.maxY + 4), in: sender)
  }

  @objc private func openDashboard() {
    runProcess("/usr/bin/open", [uiRuntimeURL().absoluteString]) { [weak self] result in
      if case let .failure(message) = result {
        self?.showAlert(title: "Dashboard did not open", message: message)
      }
    }
  }

  @objc private func showTodayTodo() {
    runAfterMenuDismiss { [weak self] in
      self?.setBusy("Loading todos...")
      self?.fetchState { [weak self] result in
        switch result {
        case .success(let body):
          self?.cachedTodoItems = todayTodoItems(from: body)
          self?.setReady("Todos loaded")
          self?.showTodayTodoCard(items: self?.cachedTodoItems ?? [], activate: true)
        case .failure(let message):
          self?.setReady("Todo load failed")
          self?.showWidgetCard(title: "提醒", count: "!", lines: ["Todo 加载失败", message], size: Constants.todoPreviewCardSize, activate: true)
        }
      }
    }
  }

  @objc private func showQuickCapture() {
    runAfterMenuDismiss { [weak self] in
      NSApp.activate(ignoringOtherApps: true)
      self?.showQuickCaptureCard()
    }
  }

  private func showHoverTodoPreview(anchorFrame: NSRect) {
    isHoveringFloatingBadge = true
    todoCardAnchorFrame = anchorFrame
    showTodayTodoCard(items: cachedTodoItems, activate: false, hoverPreview: true, anchorFrame: anchorFrame)
    refreshTodoCache { [weak self] items in
      if self?.isHoveringFloatingBadge == true {
        self?.showTodayTodoCard(items: items, activate: false, hoverPreview: true, anchorFrame: anchorFrame)
      }
    }
  }

  private func updateHoverTodoCardPosition(anchorFrame: NSRect) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in
        self?.updateHoverTodoCardPosition(anchorFrame: anchorFrame)
      }
      return
    }

    todoCardAnchorFrame = anchorFrame
    guard todoCardIsHoverPreview, let panel = todoCardPanel else {
      return
    }

    let screenFrame = visibleFrame(for: anchorFrame)
    let origin = todoCardOrigin(size: panel.frame.size, anchorFrame: anchorFrame, screenFrame: screenFrame)
    panel.setFrameOrigin(origin)
  }

  private func closeHoverTodoPreview() {
    isHoveringFloatingBadge = false
    DispatchQueue.main.async { [weak self] in
      guard self?.todoCardIsHoverPreview == true else {
        return
      }
      self?.closeTodoCard()
    }
  }

  @objc private func runDailyPlan() {
    runWorkflow(action: "plan", label: "daily plan")
  }

  @objc private func runDailyReview() {
    runWorkflow(action: "review", label: "daily review")
  }

  @objc private func runWeeklyReview() {
    runWorkflow(action: "weekly", label: "weekly review")
  }

  @objc private func playRandomEffect() {
    triggerRandomEffect()
  }

  private func triggerRandomEffect() {
    guard let pick = Constants.effectFileNames.randomElement() else {
      return
    }

    let url = URL(fileURLWithPath: repoRoot)
      .appendingPathComponent("mac-companion/assets/\(pick)")

    guard FileManager.default.fileExists(atPath: url.path) else {
      return
    }

    DispatchQueue.main.async {
      for button in self.floatingButtons {
        button.playEffect(url: url)
      }
    }
  }

  @objc private func showRecentRuns() {
    showAlert(title: "Recent Runs", message: recentRunsText())
  }

  @objc private func showServiceStatus() {
    serviceStatus { [weak self] text in
      self?.showAlert(title: "Daily OS Service", message: text)
    }
  }

  @objc private func runChecks() {
    setBusy("Running checks...")
    postAction("doctor") { [weak self] result in
      switch result {
      case .success(let body):
        self?.setReady("Checks finished")
        self?.triggerRandomEffect()
        self?.showAlert(title: "Daily OS Checks", message: actionText(from: body))
      case .failure(let message):
        self?.setReady("Checks failed")
        self?.showAlert(title: "Checks failed", message: message)
      }
    }
  }

  @objc private func restartService() {
    setBusy("Restarting service...")
    let uid = getuid()
    runProcess("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/\(Constants.launchAgentLabel)"]) { [weak self] result in
      switch result {
      case .success:
        self?.setReady("Service restarted")
        self?.triggerRandomEffect()
      case .failure(let message):
        self?.setReady("Restart failed")
        self?.showAlert(title: "Service restart failed", message: message)
      }
    }
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }

  private func runWorkflow(action: String, label: String) {
    setBusy("Running \(label)...")
    postAction(action) { [weak self] result in
      switch result {
      case .success:
        self?.setReady("\(label) finished")
        self?.triggerRandomEffect()
      case .failure(let message):
        self?.setReady("\(label) failed")
        self?.showAlert(
          title: "\(label) failed",
          message: "\(message)\n\nIf the local API is not running, start the service or open the dashboard first."
        )
      }
    }
  }

  private func postAction(_ action: String, completion: @escaping (CommandResult) -> Void) {
    var request = URLRequest(url: uiRuntimeURL().appendingPathComponent("api/action"))
    request.httpMethod = "POST"
    request.timeoutInterval = 600
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["action": action], options: [])

    URLSession.shared.dataTask(with: request) { data, response, error in
      if let error {
        completion(.failure(error.localizedDescription))
        return
      }

      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      if (200..<300).contains(statusCode) {
        completion(.success(body))
      } else {
        completion(.failure(body.isEmpty ? "HTTP \(statusCode)" : body))
      }
    }.resume()
  }

  private func captureTodo(_ text: String, showResultCard: Bool = false) {
    setBusy("Saving todo...")
    var request = URLRequest(url: uiRuntimeURL().appendingPathComponent("api/capture"))
    request.httpMethod = "POST"
    request.timeoutInterval = 30
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text], options: [])

    URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      if let error {
        self?.setReady("Todo save failed")
        self?.showAlert(title: "Todo save failed", message: error.localizedDescription)
        return
      }

      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      if (200..<300).contains(statusCode) {
        self?.setReady("Todo saved")
        self?.triggerRandomEffect()
        self?.refreshTodoCache()
        if showResultCard {
          self?.showWidgetCard(
            title: "已记录",
            count: "1",
            lines: ["Saved", "进入今日计划上下文"],
            size: Constants.todoPreviewCardSize,
            activate: true,
            anchorFrame: self?.todoCardAnchorFrame
          )
        } else {
          self?.showAlert(title: "Todo saved", message: actionText(from: body))
        }
      } else {
        self?.setReady("Todo save failed")
        self?.showAlert(title: "Todo save failed", message: body.isEmpty ? "HTTP \(statusCode)" : body)
      }
    }.resume()
  }

  private func fetchState(completion: @escaping (CommandResult) -> Void) {
    var request = URLRequest(url: uiRuntimeURL().appendingPathComponent("api/state"))
    request.httpMethod = "GET"
    request.timeoutInterval = 30

    URLSession.shared.dataTask(with: request) { data, response, error in
      if let error {
        completion(.failure(error.localizedDescription))
        return
      }

      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      if (200..<300).contains(statusCode) {
        completion(.success(body))
      } else {
        completion(.failure(body.isEmpty ? "HTTP \(statusCode)" : body))
      }
    }.resume()
  }

  private func refreshTodoCache(completion: (([TodoCardItem]) -> Void)? = nil) {
    fetchState { [weak self] result in
      guard case .success(let body) = result else {
        return
      }
      let items = todayTodoItems(from: body)
      DispatchQueue.main.async {
        self?.cachedTodoItems = items
        completion?(items)
      }
    }
  }

  private func showTodayTodoCard(items: [TodoCardItem], activate: Bool, hoverPreview: Bool = false, anchorFrame: NSRect? = nil) {
    let lines: [String]
    if items.isEmpty {
      lines = ["All Reminders", "Completed"]
    } else {
      lines = items.prefix(3).map { item in
        let due = item.due.map { "  \($0)" } ?? ""
        return "\(todoTypeLabel(item.type))  \(item.text)\(due)"
      }
    }
    showWidgetCard(
      title: "提醒",
      count: "\(items.count)",
      lines: lines,
      size: Constants.todoPreviewCardSize,
      activate: activate,
      hoverPreview: hoverPreview,
      anchorFrame: anchorFrame
    )
  }

  private func showQuickCaptureCard() {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in self?.showQuickCaptureCard() }
      return
    }

    todoCardIsHoverPreview = false
    closeTodoCard()

    let panel = makeTodoCardPanel(size: Constants.quickCaptureCardSize)
    let card = makeCardContainer(size: Constants.quickCaptureCardSize)
    panel.contentView = card

    let title = makeLabel("记录", frame: NSRect(x: 24, y: 158, width: 120, height: 34), size: 25, weight: .bold, color: NSColor.systemOrange)
    let count = makeLabel("+", frame: NSRect(x: 232, y: 154, width: 32, height: 38), size: 34, weight: .bold, color: NSColor.labelColor, alignment: .right)
    card.addSubview(title)
    card.addSubview(count)

    let input = NSTextField(frame: NSRect(x: 24, y: 96, width: 238, height: 38))
    input.placeholderString = "帮我记一下..."
    input.font = NSFont.systemFont(ofSize: 16, weight: .medium)
    input.isBezeled = false
    input.isBordered = false
    input.focusRingType = .none
    input.backgroundColor = NSColor(calibratedWhite: 0.94, alpha: 1)
    input.wantsLayer = true
    input.layer?.cornerRadius = 14
    input.layer?.masksToBounds = true
    card.addSubview(input)

    let saveButton = makePillButton(title: "保存", frame: NSRect(x: 24, y: 34, width: 110, height: 38), fill: NSColor.systemOrange, text: .white)
    saveButton.onClick = { [weak self, weak input] in
      let text = input?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard !text.isEmpty else {
        return
      }
      self?.closeTodoCard()
      self?.captureTodo(text, showResultCard: true)
    }
    let cancelButton = makePillButton(title: "取消", frame: NSRect(x: 152, y: 34, width: 110, height: 38), fill: NSColor(calibratedWhite: 0.90, alpha: 1), text: NSColor.secondaryLabelColor)
    cancelButton.onClick = { [weak self] in self?.closeTodoCard() }
    card.addSubview(saveButton)
    card.addSubview(cancelButton)

    presentTodoCard(panel, size: Constants.quickCaptureCardSize, activate: true, anchorFrame: todoCardAnchorFrame)
    panel.makeFirstResponder(input)
  }

  private func showWidgetCard(
    title: String,
    count: String,
    lines: [String],
    size: NSSize,
    activate: Bool,
    hoverPreview: Bool = false,
    anchorFrame: NSRect? = nil
  ) {
    guard Thread.isMainThread else {
      DispatchQueue.main.async {
        [weak self] in self?.showWidgetCard(
          title: title,
          count: count,
          lines: lines,
          size: size,
          activate: activate,
          hoverPreview: hoverPreview,
          anchorFrame: anchorFrame
        )
      }
      return
    }

    todoCardIsHoverPreview = hoverPreview
    closeTodoCard()

    let panel = makeTodoCardPanel(size: size)
    let card = hoverPreview ? makeQuoteReminderContainer(size: size) : makeCardContainer(size: size)
    panel.contentView = card

    let titleFrame = hoverPreview
      ? NSRect(x: 52, y: size.height - 84, width: 82, height: 24)
      : NSRect(x: 24, y: size.height - 60, width: 110, height: 34)
    let countFrame = hoverPreview
      ? NSRect(x: size.width - 90, y: size.height - 88, width: 36, height: 32)
      : NSRect(x: size.width - 72, y: size.height - 64, width: 48, height: 42)
    card.addSubview(makeLabel(title, frame: titleFrame, size: hoverPreview ? 17 : 25, weight: .bold, color: NSColor.systemOrange))
    card.addSubview(makeLabel(count, frame: countFrame, size: hoverPreview ? 25 : 34, weight: .bold, color: NSColor.labelColor, alignment: .right))

    let list = NSTextField(wrappingLabelWithString: lines.joined(separator: "\n"))
    list.frame = hoverPreview
      ? NSRect(x: 52, y: 84, width: size.width - 104, height: 58)
      : NSRect(x: 24, y: 34, width: size.width - 48, height: size.height - 112)
    list.font = NSFont.systemFont(ofSize: hoverPreview ? 12 : (lines.count <= 2 ? 21 : 15), weight: .medium)
    list.textColor = NSColor.secondaryLabelColor
    list.maximumNumberOfLines = hoverPreview ? 3 : 4
    list.lineBreakMode = .byTruncatingTail
    card.addSubview(list)

    presentTodoCard(panel, size: size, activate: activate, anchorFrame: anchorFrame ?? todoCardAnchorFrame)
  }

  private func makeTodoCardPanel(size: NSSize) -> NSPanel {
    let panel = TodoCardPanel(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.titled, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.isMovableByWindowBackground = true
    panel.standardWindowButton(.closeButton)?.isHidden = true
    panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
    panel.standardWindowButton(.zoomButton)?.isHidden = true
    return panel
  }

  private func makeCardContainer(size: NSSize) -> NSView {
    let card = NSView(frame: NSRect(origin: .zero, size: size))
    card.wantsLayer = true
    card.layer?.backgroundColor = NSColor.white.cgColor
    card.layer?.cornerRadius = Constants.todoCardCornerRadius
    card.layer?.masksToBounds = true
    return card
  }

  private func makeCloudContainer(size: NSSize) -> NSView {
    let card = NSView(frame: NSRect(origin: .zero, size: size))
    card.wantsLayer = true
    card.layer?.backgroundColor = NSColor.clear.cgColor

    if let image = companionAssetImage(named: "todo-cloud-bubble.png") {
      let imageView = NSImageView(frame: card.bounds)
      imageView.autoresizingMask = [.width, .height]
      imageView.image = image
      imageView.imageAlignment = .alignCenter
      imageView.imageScaling = .scaleAxesIndependently
      card.addSubview(imageView)
    } else {
      let fallback = CloudBubbleView(frame: card.bounds)
      fallback.autoresizingMask = [.width, .height]
      card.addSubview(fallback)
    }

    return card
  }

  private func makeQuoteReminderContainer(size: NSSize) -> NSView {
    let card = QuoteReminderCardView(frame: NSRect(origin: .zero, size: size))
    card.wantsLayer = true
    card.layer?.backgroundColor = NSColor.clear.cgColor
    return card
  }

  private func makeLabel(
    _ text: String,
    frame: NSRect,
    size: CGFloat,
    weight: NSFont.Weight,
    color: NSColor,
    alignment: NSTextAlignment = .left
  ) -> NSTextField {
    let label = NSTextField(labelWithString: text)
    label.frame = frame
    label.font = NSFont.systemFont(ofSize: size, weight: weight)
    label.textColor = color
    label.alignment = alignment
    label.lineBreakMode = .byTruncatingTail
    return label
  }

  private func makePillButton(title: String, frame: NSRect, fill: NSColor, text: NSColor) -> CompanionActionButton {
    let button = CompanionActionButton(frame: frame)
    button.title = title
    button.font = NSFont.systemFont(ofSize: 16, weight: .semibold)
    button.contentTintColor = text
    button.isBordered = false
    button.wantsLayer = true
    button.layer?.backgroundColor = fill.cgColor
    button.layer?.cornerRadius = 16
    button.layer?.masksToBounds = true
    return button
  }

  private func presentTodoCard(_ panel: NSPanel, size: NSSize, activate: Bool, anchorFrame: NSRect? = nil) {
    let screenFrame = visibleFrame(for: anchorFrame)
    let origin = todoCardOrigin(size: size, anchorFrame: anchorFrame, screenFrame: screenFrame)
    panel.setFrameOrigin(origin)
    todoCardPanel = panel
    if activate {
      NSApp.activate(ignoringOtherApps: true)
      panel.makeKeyAndOrderFront(nil)
    } else {
      panel.orderFront(nil)
    }
    panel.orderFrontRegardless()
  }

  private func visibleFrame(for anchorFrame: NSRect?) -> NSRect {
    if let anchorFrame,
       let screen = NSScreen.screens.first(where: { $0.visibleFrame.intersects(anchorFrame) || $0.frame.intersects(anchorFrame) }) {
      return screen.visibleFrame
    }
    return NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
  }

  private func todoCardOrigin(size: NSSize, anchorFrame: NSRect?, screenFrame: NSRect) -> NSPoint {
    guard let anchorFrame, !anchorFrame.isEmpty else {
      let rightInset = Constants.floatingBadgeSize.width + 40
      return NSPoint(
        x: max(screenFrame.minX + 16, screenFrame.maxX - size.width - rightInset),
        y: screenFrame.maxY - size.height - 28
      )
    }

    let margin: CGFloat = 10
    let preferredX = anchorFrame.midX - size.width + 46
    let preferredY = anchorFrame.maxY - 8
    let fallbackY = anchorFrame.minY - size.height + 18

    let x = min(max(preferredX, screenFrame.minX + margin), screenFrame.maxX - size.width - margin)
    let yCandidate = preferredY + size.height <= screenFrame.maxY - margin ? preferredY : fallbackY
    let y = min(max(yCandidate, screenFrame.minY + margin), screenFrame.maxY - size.height - margin)
    return NSPoint(x: x, y: y)
  }

  private func closeTodoCard() {
    todoCardPanel?.close()
    todoCardPanel = nil
  }

  private func serviceStatus(completion: @escaping (String) -> Void) {
    let plistPath = "\(NSHomeDirectory())/Library/LaunchAgents/\(Constants.launchAgentLabel).plist"
    let installed = FileManager.default.fileExists(atPath: plistPath)
    let uid = getuid()

    runProcess("/bin/launchctl", ["print", "gui/\(uid)/\(Constants.launchAgentLabel)"]) { result in
      let registered: String
      switch result {
      case .success(let output):
        registered = output.contains("pid =") ? "registered, running" : "registered"
      case .failure:
        registered = "not registered"
      }

      completion(
        [
          "Repo: \(self.repoRoot)",
          "UI: \(self.uiRuntimeURL().absoluteString)",
          "LaunchAgent: \(installed ? "installed" : "not installed")",
          "Runtime: \(registered)"
        ].joined(separator: "\n")
      )
    }
  }

  private func uiRuntimeURL() -> URL {
    let fileURL = URL(fileURLWithPath: repoRoot)
      .appendingPathComponent("data/runtime/ui.json")

    if
      let data = try? Data(contentsOf: fileURL),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let rawURL = object["url"] as? String,
      let url = URL(string: rawURL)
    {
      return url
    }

    return URL(string: "http://127.0.0.1:14573")!
  }

  private func penguinImage(named fileName: String) -> NSImage? {
    guard let image = companionAssetImage(named: fileName) else {
      return nil
    }
    image.size = Constants.penguinImageSize
    return image
  }

  private func companionAssetImage(named fileName: String) -> NSImage? {
    let fileURL = URL(fileURLWithPath: repoRoot)
      .appendingPathComponent("mac-companion/assets/\(fileName)")
    return NSImage(contentsOf: fileURL)
  }

  private func recentRunsText() -> String {
    let directory = URL(fileURLWithPath: repoRoot).appendingPathComponent("data/memory/workflow-runs")
    guard
      let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        .filter({ $0.pathExtension == "json" })
        .sorted(by: { $0.lastPathComponent > $1.lastPathComponent })
        .prefix(5),
      !files.isEmpty
    else {
      return "No workflow runs recorded yet."
    }

    let lines = files.enumerated().map { index, file -> String in
      guard
        let data = try? Data(contentsOf: file),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else {
        return "\(index + 1). unreadable run record"
      }

      let workflow = object["workflow"] as? String ?? "workflow"
      let trigger = object["trigger"] as? String ?? "unknown"
      let status = object["status"] as? String ?? "unknown"
      let startedAt = object["started_at"] as? String ?? ""
      let send = (object["send"] as? [String: Any])?["status"] as? String ?? "unknown"
      return "\(index + 1). \(workflow) | \(trigger) | \(status) | send=\(send) | \(startedAt)"
    }

    return lines.joined(separator: "\n")
  }

  private func setBusy(_ text: String) {
    DispatchQueue.main.async {
      self.configureStatusButton(isBusy: true)
      self.rebuildMenu(status: text)
    }
  }

  private func setReady(_ text: String) {
    DispatchQueue.main.async {
      self.configureStatusButton(isBusy: false)
      self.rebuildMenu(status: text)
    }
  }

  private func showAlert(title: String, message: String) {
    DispatchQueue.main.async {
      NSApp.activate(ignoringOtherApps: true)
      let alert = NSAlert()
      alert.messageText = title
      alert.informativeText = message
      alert.addButton(withTitle: "OK")
      alert.runModal()
    }
  }

  private func runAfterMenuDismiss(_ work: @escaping () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: work)
  }

  private func showRequestedTestCardIfNeeded() {
    let arguments = CommandLine.arguments
    if arguments.contains("--show-todo-card-test") {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
        self?.showWidgetCard(title: "提醒", count: "2", lines: ["All Reminders", "Completed"], size: Constants.todoPreviewCardSize, activate: true)
      }
    }

    if arguments.contains("--show-cloud-card-test") {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
        self?.showWidgetCard(
          title: "提醒",
          count: "2",
          lines: ["今晚 7:30 室外音乐会", "线上报销医疗费用"],
          size: Constants.todoPreviewCardSize,
          activate: true,
          hoverPreview: true
        )
      }
    }

    if arguments.contains("--show-quick-capture-test") {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
        self?.showQuickCaptureCard()
      }
    }
  }

}

private enum CommandResult {
  case success(String)
  case failure(String)
}

private func runProcess(_ executable: String, _ arguments: [String], completion: @escaping (CommandResult) -> Void) {
  DispatchQueue.global(qos: .utility).async {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    do {
      try process.run()
      process.waitUntilExit()
      let output = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      let error = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      if process.terminationStatus == 0 {
        completion(.success(output))
      } else {
        completion(.failure(error.isEmpty ? output : error))
      }
    } catch {
      completion(.failure(error.localizedDescription))
    }
  }
}

private func actionText(from body: String) -> String {
  guard
    let data = body.data(using: .utf8),
    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let text = object["text"] as? String
  else {
    return body
  }

  return text
}

private func todayTodoText(from body: String) -> String {
  let items = todayTodoItems(from: body)
  if items.isEmpty {
    return "No open Daily OS todo."
  }

  return items.enumerated().map { index, item in
    let suffix = item.due.map { " (\($0))" } ?? ""
    return "\(index + 1). \(todoTypeLabel(item.type)): \(item.text)\(suffix)"
  }.joined(separator: "\n")
}

private func todayTodoItems(from body: String) -> [TodoCardItem] {
  guard
    let data = body.data(using: .utf8),
    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let todoInbox = object["todoInbox"] as? [String: Any],
    let open = todoInbox["open"] as? [[String: Any]]
  else {
    return []
  }

  return open.map { item in
    let text = item["text"] as? String ?? "Untitled"
    let type = item["type"] as? String ?? "todo"
    let due = item["due_hint"] as? String
    return TodoCardItem(text: text, type: type, due: due)
  }
}

private func todoTypeLabel(_ type: String) -> String {
  switch type {
  case "time_boundary":
    return "时间"
  case "reminder":
    return "提醒"
  case "note":
    return "备注"
  default:
    return "待办"
  }
}

private enum RepositoryLocator {
  static func find() -> String {
    let environment = ProcessInfo.processInfo.environment
    if let configured = environment["DAILY_OS_REPO_ROOT"], isRepoRoot(configured) {
      return configured
    }

    if let argument = repoArgument(), isRepoRoot(argument) {
      return argument
    }

    let bundleURL = Bundle.main.bundleURL
    if bundleURL.pathExtension == "app" {
      let candidate = bundleURL
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .path
      if isRepoRoot(candidate) {
        return candidate
      }
    }

    var current = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    for _ in 0..<8 {
      if isRepoRoot(current.path) {
        return current.path
      }
      current.deleteLastPathComponent()
    }

    return FileManager.default.currentDirectoryPath
  }

  private static func repoArgument() -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: "--repo"), arguments.indices.contains(index + 1) else {
      return nil
    }
    return arguments[index + 1]
  }

  private static func isRepoRoot(_ path: String) -> Bool {
    let packagePath = URL(fileURLWithPath: path).appendingPathComponent("package.json")
    guard let data = try? Data(contentsOf: packagePath),
          let text = String(data: data, encoding: .utf8)
    else {
      return false
    }
    return text.contains("\"name\": \"daily-os-feishu\"")
  }
}

private let app = NSApplication.shared
private let delegate = DailyOSCompanionApp()
app.delegate = delegate
app.run()
