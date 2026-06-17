import AppKit
import AVFoundation
import Foundation

private enum Constants {
  static let launchAgentLabel = "com.daily-os-feishu.agent"
  static let floatingBadgeSize = NSSize(width: 124, height: 124)
  static let penguinImageSize = NSSize(width: 96, height: 96)
  static let effectFileNames = ["penguin-fx-flap.mov", "penguin-fx-roll.mov", "penguin-fx-jump.mov"]
}

final class FloatingBadgeButton: NSButton {
  var idleImage: NSImage?
  var blinkImage: NSImage?

  private var trackingArea: NSTrackingArea?
  private var blinkWorkItems: [DispatchWorkItem] = []

  private var effectPlayer: AVPlayer?
  private var effectLayer: AVPlayerLayer?
  private var effectEndObserver: NSObjectProtocol?
  private var isPlayingEffect = false

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
    guard !isPlayingEffect else {
      return
    }
    playBlink()
  }

  override func mouseExited(with event: NSEvent) {
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
      case .leftMouseUp:
        if !didDrag {
          performClick(nil)
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

    let player = AVPlayer(url: url)
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

final class DailyOSCompanionApp: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var floatingWindows: [NSPanel] = []
  private var floatingButtons: [FloatingBadgeButton] = []
  private let repoRoot = RepositoryLocator.find()

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    configureStatusButton(isBusy: false)
    rebuildMenu()
    showFloatingBadge()
  }

  private func configureStatusButton(isBusy: Bool) {
    guard let button = statusItem.button else {
      return
    }

    button.title = isBusy ? "DO*" : "DO"
    button.image = nil
    button.toolTip = "Daily OS"
    for floatingButton in floatingButtons {
      configureFloatingButton(floatingButton, isBusy: isBusy)
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

      let frame = screen.visibleFrame
      panel.setFrameOrigin(NSPoint(x: frame.maxX - Constants.floatingBadgeSize.width - 24, y: frame.maxY - Constants.floatingBadgeSize.height - 24))

      floatingButtons.append(button)
      floatingWindows.append(panel)
      panel.orderFrontRegardless()
    }
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
    guard let pick = Constants.effectFileNames.randomElement() else {
      return
    }

    let url = URL(fileURLWithPath: repoRoot)
      .appendingPathComponent("mac-companion/assets/\(pick)")

    guard FileManager.default.fileExists(atPath: url.path) else {
      showAlert(title: "随机效果", message: "找不到动效文件:\(pick)")
      return
    }

    for button in floatingButtons {
      button.playEffect(url: url)
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
    let fileURL = URL(fileURLWithPath: repoRoot)
      .appendingPathComponent("mac-companion/assets/\(fileName)")
    guard let image = NSImage(contentsOf: fileURL) else {
      return nil
    }
    image.size = Constants.penguinImageSize
    return image
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
