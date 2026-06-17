import AppKit
import QuartzCore
import Foundation

private enum Constants {
  static let launchAgentLabel = "com.daily-os-feishu.agent"
  static let floatingBadgeSize = NSSize(width: 124, height: 124)
  static let penguinImageSize = NSSize(width: 96, height: 96)
}

final class FloatingBadgeButton: NSButton {
  private var trackingArea: NSTrackingArea?

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
    animateHover()
  }

  override func mouseExited(with event: NSEvent) {
    animateRest()
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

  private func animateHover() {
    wantsLayer = true
    layer?.masksToBounds = false

    var perspective = CATransform3DIdentity
    perspective.m34 = -1.0 / 700.0
    layer?.sublayerTransform = perspective

    let bounce = CAKeyframeAnimation(keyPath: "transform.scale")
    bounce.values = [1.0, 1.14, 0.97, 1.08]
    bounce.keyTimes = [0, 0.35, 0.68, 1]
    bounce.duration = 0.38
    bounce.timingFunctions = [
      CAMediaTimingFunction(name: .easeOut),
      CAMediaTimingFunction(name: .easeInEaseOut),
      CAMediaTimingFunction(name: .easeOut)
    ]
    bounce.fillMode = .forwards
    bounce.isRemovedOnCompletion = false

    let turn = CAKeyframeAnimation(keyPath: "transform.rotation.y")
    turn.values = [0, -0.18, 0.14, 0]
    turn.keyTimes = [0, 0.32, 0.72, 1]
    turn.duration = 0.42
    turn.timingFunctions = [
      CAMediaTimingFunction(name: .easeOut),
      CAMediaTimingFunction(name: .easeInEaseOut),
      CAMediaTimingFunction(name: .easeOut)
    ]

    layer?.add(bounce, forKey: "penguin-bounce")
    layer?.add(turn, forKey: "penguin-turn")
  }

  private func animateRest() {
    wantsLayer = true

    let settle = CABasicAnimation(keyPath: "transform")
    settle.fromValue = layer?.presentation()?.transform
    settle.toValue = CATransform3DIdentity
    settle.duration = 0.18
    settle.timingFunction = CAMediaTimingFunction(name: .easeOut)
    layer?.transform = CATransform3DIdentity
    layer?.add(settle, forKey: "penguin-rest")
  }
}

final class DailyOSCompanionApp: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var floatingWindows: [NSPanel] = []
  private var floatingButtons: [NSButton] = []
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

  private func configureFloatingButton(_ button: NSButton, isBusy: Bool) {
    button.isBordered = false
    button.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .bold)
    button.contentTintColor = nil
    button.toolTip = "Daily OS"
    button.wantsLayer = true
    button.layer?.backgroundColor = NSColor.clear.cgColor
    button.layer?.cornerRadius = 18
    button.layer?.masksToBounds = false
    button.alphaValue = isBusy ? 0.78 : 1

    if let image = penguinAvatarImage() {
      button.title = ""
      button.image = image
      button.imagePosition = .imageOnly
      button.imageScaling = .scaleProportionallyUpOrDown
    } else {
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

  private func penguinAvatarImage() -> NSImage? {
    let fileURL = URL(fileURLWithPath: repoRoot)
      .appendingPathComponent("mac-companion/assets/penguin-avatar.png")
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
