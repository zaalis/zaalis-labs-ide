import AppKit
import CryptoKit

let fm = FileManager.default
let appName = "zaalis IDE.app"
let bundleID = "fr.zaalis.ide"
let accent = NSColor(srgbRed: 0.65, green: 0.61, blue: 0.85, alpha: 1)
let muted = NSColor(srgbRed: 0.62, green: 0.62, blue: 0.68, alpha: 1)

struct InstallationError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

func command(_ executable: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        throw InstallationError(message: String(data: data, encoding: .utf8) ?? "La vérification a échoué.")
    }
}

func validateApplication(_ source: URL) throws {
    let infoURL = source.appendingPathComponent("Contents/Info.plist")
    guard let info = NSDictionary(contentsOf: infoURL),
          info["CFBundleIdentifier"] as? String == bundleID,
          let executable = info["CFBundleExecutable"] as? String,
          !executable.contains("/"),
          fm.isExecutableFile(atPath: source.appendingPathComponent("Contents/MacOS/" + executable).path) else {
        throw InstallationError(message: "L’application zaalis IDE est absente ou endommagée. Téléchargez à nouveau l’installateur.")
    }
    if let expected = Bundle.main.object(forInfoDictionaryKey: "ZaalisPayloadSeal") as? String {
        let seal = try Data(contentsOf: source.appendingPathComponent("Contents/_CodeSignature/CodeResources"))
        let actual = SHA256.hash(data: seal).map { String(format: "%02x", $0) }.joined()
        guard actual == expected else { throw InstallationError(message: "Le paquet ne correspond pas à cet installateur.") }
    }
    if let expected = Bundle.main.object(forInfoDictionaryKey: "ZaalisPayloadCode") as? String {
        let code = try Data(contentsOf: source.appendingPathComponent("Contents/MacOS/" + executable))
        guard SHA256.hash(data: code).map({ String(format: "%02x", $0) }).joined() == expected else {
            throw InstallationError(message: "Le programme ne correspond pas à cet installateur.")
        }
    }
    try command("/usr/bin/codesign", ["--verify", "--deep", "--strict", source.path])
}

// Gatekeeper can launch a downloaded assistant from an isolated location.
// Find its original mounted volume by a per-image token, never by volume name.
func locatePayload(installer: URL, token: String, volumes: [URL]) throws -> URL {
    for volume in [installer.deletingLastPathComponent()] + volumes {
        let marker = volume.appendingPathComponent(".zaalis-install-id")
        if let value = try? String(contentsOf: marker), value.trimmingCharacters(in: .whitespacesAndNewlines) == token {
            let payload = volume.appendingPathComponent(".payload/" + appName)
            if fm.fileExists(atPath: payload.path) { return payload }
        }
    }
    throw InstallationError(message: "Gardez l’image disque zaalis IDE ouverte pendant l’installation, puis réessayez.")
}

// Stage on the destination filesystem, verify the copy, then swap it into
// place. Never delete an existing installation before a complete copy exists.
func installApplication(source: URL, directory: URL, validate: (URL) throws -> Void = validateApplication,
                        move: (URL, URL) throws -> Void = { try fm.moveItem(at: $0, to: $1) },
                        progress: (String) -> Void = { _ in }) throws -> URL {
    try validate(source)
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    let target = directory.appendingPathComponent(appName)
    let stage = directory.appendingPathComponent(".zaalis-install-\(UUID().uuidString).app")
    let backup = directory.appendingPathComponent(".zaalis-backup-\(UUID().uuidString).app")
    var backedUp = false
    defer { try? fm.removeItem(at: stage) }
    progress("Copie de votre espace de travail…")
    try fm.copyItem(at: source, to: stage)
    progress("Vérification de l’application…")
    try validate(stage)
    if fm.fileExists(atPath: target.path) {
        // A folder with this name is not necessarily our application.
        let info = NSDictionary(contentsOf: target.appendingPathComponent("Contents/Info.plist"))
        guard info?["CFBundleIdentifier"] as? String == bundleID else {
            throw InstallationError(message: "Un autre élément nommé zaalis IDE existe dans ce dossier. Choisissez un autre emplacement.")
        }
        try move(target, backup)
        backedUp = true
    }
    do {
        progress("Mise en place dans Applications…")
        try move(stage, target)
    } catch {
        if backedUp { try move(backup, target) }
        throw error
    }
    // Installation is already committed. A cleanup failure must not imply
    // that replacing a valid application failed or trigger a destructive retry.
    if backedUp { try? fm.removeItem(at: backup) }
    return target
}

func installTerminal(target: URL, home: URL = fm.homeDirectoryForCurrentUser) throws {
    let bin = home.appendingPathComponent(".local/bin")
    try fm.createDirectory(at: bin, withIntermediateDirectories: true)
    let link = bin.appendingPathComponent("zaalis")
    let executable = target.appendingPathComponent("Contents/Resources/app/bundle/bin/zaalis")
    guard fm.isExecutableFile(atPath: executable.path) else {
        throw InstallationError(message: "La commande Terminal est absente du paquet.")
    }
    if (try? link.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
        let old = try fm.destinationOfSymbolicLink(atPath: link.path)
        guard old.hasSuffix("/zaalis IDE.app/Contents/Resources/app/bundle/bin/zaalis") else {
            throw InstallationError(message: "Une autre commande zaalis existe déjà. Elle a été conservée.")
        }
        try fm.removeItem(at: link)
    } else if fm.fileExists(atPath: link.path) {
        throw InstallationError(message: "Une autre commande zaalis existe déjà. Elle a été conservée.")
    }
    try fm.createSymbolicLink(at: link, withDestinationURL: executable)
    let profile = home.appendingPathComponent(".zprofile")
    let previous = fm.fileExists(atPath: profile.path) ? try String(contentsOf: profile, encoding: .utf8) : ""
    if !previous.contains("# zaalis IDE — Terminal") && !previous.contains(".local/bin") {
        try (previous + "\n# zaalis IDE — Terminal\nexport PATH=\"$HOME/.local/bin:$PATH\"\n")
            .write(to: profile, atomically: true, encoding: .utf8)
    }
}

func selfTest() throws {
    let root = fm.temporaryDirectory.appendingPathComponent("zaalis-installer-test-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: root) }
    let source = root.appendingPathComponent("source/" + appName)
    try fm.createDirectory(at: source.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    let plist: [String: Any] = ["CFBundleIdentifier": bundleID]
    (plist as NSDictionary).write(to: source.appendingPathComponent("Contents/Info.plist"), atomically: true)
    let file = source.appendingPathComponent("version")
    try "new".write(to: file, atomically: true, encoding: .utf8)
    let directory = root.appendingPathComponent("Applications")
    let validate: (URL) throws -> Void = { url in
        guard try String(contentsOf: url.appendingPathComponent("version")) == "new" else {
            throw InstallationError(message: "Invalid test copy")
        }
    }
    let installed = try installApplication(source: source, directory: directory, validate: validate)
    try "old".write(to: installed.appendingPathComponent("version"), atomically: true, encoding: .utf8)
    do {
        _ = try installApplication(source: source, directory: directory, validate: { url in
            if url != source { throw InstallationError(message: "Injected invalid staged copy") }
        })
        throw InstallationError(message: "Invalid copy was accepted")
    } catch let error as InstallationError where error.message == "Injected invalid staged copy" {}
    guard try String(contentsOf: installed.appendingPathComponent("version")) == "old" else {
        throw InstallationError(message: "Existing application was not preserved")
    }
    do {
        _ = try installApplication(source: source, directory: directory, validate: validate, move: { from, to in
            if from.lastPathComponent.hasPrefix(".zaalis-install-") { throw InstallationError(message: "Injected commit failure") }
            try fm.moveItem(at: from, to: to)
        })
        throw InstallationError(message: "Commit failure was ignored")
    } catch let error as InstallationError where error.message == "Injected commit failure" {}
    guard try String(contentsOf: installed.appendingPathComponent("version")) == "old" else {
        throw InstallationError(message: "Rollback did not restore the previous application")
    }
    _ = try installApplication(source: source, directory: directory, validate: validate)
    guard try String(contentsOf: installed.appendingPathComponent("version")) == "new",
          try fm.contentsOfDirectory(atPath: directory.path) == [appName] else {
        throw InstallationError(message: "Replacement left unexpected files")
    }
    // A conflicting command and an unrelated .app must survive unchanged.
    let conflict = root.appendingPathComponent("Other/" + appName)
    try fm.createDirectory(at: conflict, withIntermediateDirectories: true)
    do {
        _ = try installApplication(source: source, directory: conflict.deletingLastPathComponent(), validate: validate)
        throw InstallationError(message: "Unrelated application was replaced")
    } catch let error as InstallationError where error.message.hasPrefix("Un autre élément") {}
    let cli = installed.appendingPathComponent("Contents/Resources/app/bundle/bin/zaalis")
    try fm.createDirectory(at: cli.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "#!/bin/sh\n".write(to: cli, atomically: true, encoding: .utf8)
    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cli.path)
    let home = root.appendingPathComponent("test-home")
    try fm.createDirectory(at: home, withIntermediateDirectories: true)
    let profile = home.appendingPathComponent(".zprofile")
    try "# Existing settings\n".write(to: profile, atomically: true, encoding: .utf8)
    try installTerminal(target: installed, home: home)
    try installTerminal(target: installed, home: home)
    let settings = try String(contentsOf: profile)
    guard settings.hasPrefix("# Existing settings\n"), settings.components(separatedBy: "# zaalis IDE — Terminal").count == 2 else {
        throw InstallationError(message: "Terminal configuration was duplicated or overwritten")
    }
    let link = home.appendingPathComponent(".local/bin/zaalis")
    try fm.removeItem(at: link)
    try "another command".write(to: link, atomically: true, encoding: .utf8)
    do {
        try installTerminal(target: installed, home: home)
        throw InstallationError(message: "Existing command was replaced")
    } catch let error as InstallationError where error.message.hasPrefix("Une autre commande") {}
    guard try String(contentsOf: link) == "another command" else { throw InstallationError(message: "Command lost") }
    let volume = root.appendingPathComponent("mounted-image")
    let payload = volume.appendingPathComponent(".payload/" + appName)
    try fm.createDirectory(at: payload, withIntermediateDirectories: true)
    try "fixture-token".write(to: volume.appendingPathComponent(".zaalis-install-id"), atomically: true, encoding: .utf8)
    let isolated = root.appendingPathComponent("isolated/Installer.app")
    guard try locatePayload(installer: isolated, token: "fixture-token", volumes: [root, volume]).standardizedFileURL.path == payload.standardizedFileURL.path else {
        throw InstallationError(message: "Isolated launch did not find its mounted payload")
    }
    do {
        _ = try locatePayload(installer: isolated, token: "wrong-token", volumes: [volume])
        throw InstallationError(message: "A different image was accepted")
    } catch let error as InstallationError where error.message.hasPrefix("Gardez") {}
    print("Installer checks: first install, replacement, invalid-copy preservation, rollback, cleanup, unrelated-app protection, Terminal idempotence, command conflict and isolated-launch payload resolution OK")
}

final class Backdrop: NSView {
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(srgbRed: 9/255, green: 9/255, blue: 11/255, alpha: 1).setFill()
        bounds.fill()
        if let background = NSImage(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("background.png")) {
            background.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        }
        NSColor(white: 1, alpha: 0.075).setFill()
        NSRect(x: 282, y: 0, width: 1, height: bounds.height - 78).fill()
        NSRect(x: 0, y: bounds.height - 78, width: bounds.width, height: 1).fill()
    }
}

final class ActionButton: NSButton {
    var primary = false
    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7)
        let fill = primary ? accent : NSColor(white: 0.10, alpha: 1)
        fill.withAlphaComponent(isEnabled ? (cell?.isHighlighted == true ? 0.75 : 1) : 0.4).setFill()
        shape.fill()
        if !primary { NSColor(white: 0.23, alpha: 1).setStroke(); shape.lineWidth = 1; shape.stroke() }
        let text = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: primary ? NSColor(srgbRed: 0.07, green: 0.06, blue: 0.10, alpha: 1) : NSColor(white: 0.87, alpha: isEnabled ? 1 : 0.4)
        ])
        let size = text.size()
        text.draw(at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2))
    }
}

func label(_ text: String, _ size: CGFloat, _ weight: NSFont.Weight = .regular,
           _ color: NSColor = .labelColor) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight)
    field.textColor = color
    return field
}

final class Installer: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    let canvas = Backdrop(frame: NSRect(x: 0, y: 0, width: 940, height: 620))
    var content = NSView()
    var step = 0
    var installing = false
    var installed: URL?
    var status: NSTextField?
    var next: NSButton!
    var back: NSButton!
    var cancel: NSButton!
    var destination: NSPopUpButton!
    var terminal: NSButton!
    var launch: NSButton!
    var warnings = ""
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.16"
    let previewStep: Int?

    init(previewStep: Int? = nil) { self.previewStep = previewStep }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: canvas.bounds, styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Installation de zaalis IDE"
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = .black
        window.titlebarAppearsTransparent = true
        window.contentView = canvas
        window.delegate = self
        window.center()
        add(label("●  ZAALIS  /  IDE", 14, .semibold, accent), 34, 70, 220, 30)
        add(label("Créez. Codez.", 29, .bold, .white), 34, 238, 230, 42)
        add(label("Allez plus loin.", 27, .semibold, muted), 34, 284, 235, 40)
        add(label("VOTRE ESPACE\nDE TRAVAIL IA", 11, .semibold, muted), 36, 374, 225, 45)
        let rule = NSBox(frame: NSRect(x: 36, y: 352, width: 44, height: 2))
        rule.boxType = .custom; rule.fillColor = accent; rule.borderWidth = 0
        canvas.addSubview(rule)
        add(label("macOS  ·  \(version)", 11, .medium, muted), 35, 488, 220, 22)
        add(label("INSTALLATION", 10, .semibold, muted), 326, 43, 560, 20)
        next = button("Continuer", #selector(advance), primary: true)
        next.frame = NSRect(x: 758, y: 558, width: 145, height: 36)
        next.keyEquivalent = "\r"
        back = button("Retour", #selector(goBack))
        back.frame = NSRect(x: 643, y: 558, width: 103, height: 36)
        cancel = button("Annuler", #selector(close))
        cancel.frame = NSRect(x: 35, y: 558, width: 103, height: 36)
        cancel.keyEquivalent = "\u{1b}"
        [next!, back!, cancel!].forEach { canvas.addSubview($0) }
        if let previewStep { step = previewStep; installing = previewStep == 2 }
        render()
        if previewStep == nil {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func add(_ view: NSView, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) {
        view.frame = NSRect(x: x, y: y, width: w, height: h)
        canvas.addSubview(view)
    }
    func item(_ view: NSView, _ y: CGFloat, _ h: CGFloat = 40) {
        view.frame = NSRect(x: 0, y: y, width: 552, height: h)
        content.addSubview(view)
    }
    func button(_ title: String, _ action: Selector, primary: Bool = false) -> NSButton {
        let button = ActionButton(title: title, target: self, action: action)
        button.primary = primary
        button.bezelStyle = .rounded
        if primary { button.bezelColor = accent; button.contentTintColor = .black }
        return button
    }
    func render() {
        content.removeFromSuperview()
        // Flipped coordinates match the containing view.
        content = BackdropContent(frame: NSRect(x: 326, y: 100, width: 552, height: 410))
        canvas.addSubview(content)
        back.isHidden = step != 1
        cancel.isEnabled = !installing
        next.isEnabled = !installing
        window.standardWindowButton(.closeButton)?.isEnabled = !installing
        switch step {
        case 0:
            item(label("Bienvenue dans\nzaalis IDE", 34, .bold, .white), 0, 94)
            item(label("Votre espace de création, de code et d’agents IA\nest prêt à prendre place sur votre Mac.", 16, .regular, muted), 118, 60)
            item(label("Continuez pour installer l’application et ses composants\ndans votre dossier Applications.", 14, .regular, muted), 212, 60)
            item(label("Chat & agents IA     ·     Éditeur & terminal     ·     Intégrations", 12, .medium, accent), 318, 45)
            next.title = "Continuer"
        case 1:
            item(label("Votre espace est prêt", 30, .bold, .white), 0, 50)
            item(label("Choisissez où installer zaalis IDE sur ce Mac.", 15, .regular, muted), 62, 40)
            item(label("EMPLACEMENT", 10, .semibold, muted), 124, 20)
            destination = NSPopUpButton(frame: .zero, pullsDown: false)
            destination.addItems(withTitles: ["Applications — tous les utilisateurs", "Applications — mon compte uniquement"])
            if !fm.isWritableFile(atPath: "/Applications") { destination.selectItem(at: 1) }
            item(destination, 154, 34)
            terminal = NSButton(checkboxWithTitle: "Installer la commande zaalis pour Terminal", target: nil, action: nil)
            terminal.font = .systemFont(ofSize: 13)
            terminal.state = .off
            item(terminal, 220, 30)
            item(label("Vos comptes, conversations et réglages sont conservés.\nL’application pourra être ouverte depuis Applications ou Spotlight.", 13, .regular, muted), 282, 70)
            next.title = "Installer"
        case 2:
            item(label("Installation de zaalis IDE", 29, .bold, .white), 0, 55)
            item(label("Nous mettons en place votre espace de travail.\nCela peut prendre quelques instants.", 15, .regular, muted), 78, 65)
            let bar = NSProgressIndicator(frame: .zero)
            bar.style = .bar; bar.isIndeterminate = true
            item(bar, 196, 12); bar.startAnimation(nil)
            status = label("Vérification du paquet…", 13, .medium, accent)
            item(status!, 234, 65)
            next.title = "Installation…"
        default:
            item(label("zaalis IDE est prêt", 32, .bold, .white), 0, 55)
            item(label("Installation terminée.\nVotre prochain projet commence ici.", 16, .regular, muted), 85, 70)
            launch = NSButton(checkboxWithTitle: "Lancer zaalis IDE", target: nil, action: nil)
            launch.state = .on; launch.font = .systemFont(ofSize: 14)
            item(launch, 205, 35)
            item(label(warnings.isEmpty ? "Retrouvez l’application dans Applications ou Spotlight." : warnings, 13, .regular, muted), 275, 110)
            next.title = "Terminer"; cancel.isHidden = true
        }
    }
    @objc func advance() {
        if step == 0 { step = 1; render(); return }
        if step == 1 { beginInstall(); return }
        if step == 3 {
            if launch.state == .on, let installed { NSWorkspace.shared.open(installed) }
            NSApp.terminate(nil)
        }
    }
    @objc func goBack() { step = 0; render() }
    @objc func close() { if !installing { NSApp.terminate(nil) } }
    func windowShouldClose(_ sender: NSWindow) -> Bool { !installing }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        installing ? .terminateCancel : .terminateNow
    }

    func beginInstall() {
        let directory = destination.indexOfSelectedItem == 0
            ? URL(fileURLWithPath: "/Applications", isDirectory: true)
            : fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
        let target = directory.appendingPathComponent(appName)
        let running = NSWorkspace.shared.runningApplications.filter { $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == target.resolvingSymlinksInPath().standardizedFileURL.path }
        if !running.isEmpty {
            let alert = NSAlert()
            alert.messageText = "Fermer zaalis IDE pour continuer ?"
            alert.informativeText = "Enregistrez votre travail avant de remplacer l’application."
            alert.addButton(withTitle: "Fermer et installer"); alert.addButton(withTitle: "Retour")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            running.forEach { _ = $0.terminate() }
        }
        let withTerminal = terminal.state == .on
        installing = true; step = 2; render()
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                for _ in 0..<50 {
                    if running.allSatisfy({ $0.isTerminated }) { break }
                    Thread.sleep(forTimeInterval: 0.2)
                }
                guard running.allSatisfy({ $0.isTerminated }) else {
                    throw InstallationError(message: "zaalis IDE est encore ouvert. Fermez-le puis réessayez.")
                }
                guard let token = Bundle.main.object(forInfoDictionaryKey: "ZaalisVolumeToken") as? String else {
                    throw InstallationError(message: "Cet assistant doit être lancé depuis son image disque zaalis IDE.")
                }
                let source = try locatePayload(installer: Bundle.main.bundleURL, token: token,
                    volumes: fm.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: []) ?? [])
                let result = try installApplication(source: source, directory: directory, progress: { text in
                    DispatchQueue.main.async { self.status?.stringValue = text }
                })
                var warning = ""
                if withTerminal {
                    do { try installTerminal(target: result) }
                    catch { warning = "L’application est installée. Terminal : \(error.localizedDescription)" }
                }
                DispatchQueue.main.async {
                    self.installed = result; self.warnings = warning; self.installing = false; self.step = 3; self.render()
                }
            } catch {
                DispatchQueue.main.async {
                    self.installing = false; self.step = 1; self.render()
                    let alert = NSAlert()
                    alert.messageText = "L’installation n’a pas pu se terminer"
                    alert.informativeText = error.localizedDescription + "\n\nVérifiez l’espace disponible et les droits d’accès au dossier Applications."
                    alert.addButton(withTitle: "Réessayer"); alert.runModal()
                }
            }
        }
    }
}

final class BackdropContent: NSView { override var isFlipped: Bool { true } }

do {
    if CommandLine.arguments.contains("--self-test") {
        try selfTest()
    } else if let index = CommandLine.arguments.firstIndex(of: "--verify-install"), CommandLine.arguments.count > index + 2 {
        let source = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        let directory = URL(fileURLWithPath: CommandLine.arguments[index + 2])
        let target = try installApplication(source: source, directory: directory, progress: { print($0) })
        print("Installed and verified: \(target.path)")
    } else {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let preview = CommandLine.arguments.firstIndex(of: "--preview")
        let delegate = Installer(previewStep: preview == nil ? nil : Int(CommandLine.arguments.last ?? "0") ?? 0)
        app.delegate = delegate
        if let preview, CommandLine.arguments.count > preview + 1 {
            delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
            delegate.canvas.layoutSubtreeIfNeeded()
            let bitmap = delegate.canvas.bitmapImageRepForCachingDisplay(in: delegate.canvas.bounds)!
            delegate.canvas.cacheDisplay(in: delegate.canvas.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[preview + 1]))
        } else { app.run() }
        withExtendedLifetime(delegate) {}
    }
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
}
