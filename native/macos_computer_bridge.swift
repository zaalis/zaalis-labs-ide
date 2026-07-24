import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import Carbon.HIToolbox

// Privileged macOS side of the computer-control feature.  It deliberately
// accepts one JSON request on stdin and emits one JSON response on stdout so it
// can be kept outside both the web renderer and the local HTTP API.
typealias JSON = [String: Any]

func output(_ value: JSON) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func error(_ message: String) { output(["ok": false, "error": message]) }

func accessibilityTrusted(prompt: Bool) -> Bool {
    if prompt {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }
    return AXIsProcessTrusted()
}

func screenPermission(prompt: Bool) -> Bool {
    if CGPreflightScreenCaptureAccess() { return true }
    if prompt { return CGRequestScreenCaptureAccess() }
    return false
}

@available(macOS 14.0, *)
func capturedImage() throws -> CGImage {
    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<CGImage, Error>!
    Task {
        do {
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else { throw NSError(domain: "zaalis", code: 1, userInfo: [NSLocalizedDescriptionKey: "display unavailable"]) }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = display.width
            config.height = display.height
            result = .success(try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config))
        } catch { result = .failure(error) }
        semaphore.signal()
    }
    semaphore.wait()
    return try result.get()
}

func pngBase64() throws -> String {
    guard #available(macOS 14.0, *) else { throw NSError(domain: "zaalis", code: 1, userInfo: [NSLocalizedDescriptionKey: "macOS 14 required for screen capture"]) }
    let image = try capturedImage()
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else {
        throw NSError(domain: "zaalis", code: 2, userInfo: [NSLocalizedDescriptionKey: "png destination unavailable"])
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw NSError(domain: "zaalis", code: 3, userInfo: [NSLocalizedDescriptionKey: "png encoding failed"])
    }
    return data.base64EncodedString()
}

func point(_ request: JSON) -> CGPoint? {
    guard let x = request["x"] as? Double, let y = request["y"] as? Double,
          x.isFinite, y.isFinite, x >= 0, y >= 0 else { return nil }
    return CGPoint(x: x, y: y)
}

func postMouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton = .left) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
}

func move(to target: CGPoint, duration: Double) {
    let current = CGEvent(source: nil)?.location ?? target
    let seconds = max(0.08, min(duration, 1.2))
    let frames = max(1, Int(seconds * 60.0))
    for frame in 1...frames {
        let t = Double(frame) / Double(frames)
        // Smoothstep gives a visible human-like ease in/out while staying deterministic.
        let eased = t * t * (3.0 - 2.0 * t)
        postMouse(.mouseMoved, at: CGPoint(x: current.x + (target.x - current.x) * eased, y: current.y + (target.y - current.y) * eased))
        usleep(16_666)
    }
}

struct KeyStroke { let code: CGKeyCode; let shift: Bool }

// Build a character -> (keycode, needsShift) map from a keyboard layout by
// asking UCKeyTranslate what each physical key produces, unshifted and
// shifted. This makes both typing and shortcuts correct on ANY layout
// (QWERTY, AZERTY, QWERTZ…): we look up the key that PRODUCES a character
// instead of assuming a fixed US position.
func strokeMap(from source: TISInputSource?) -> [Character: KeyStroke] {
    var result: [Character: KeyStroke] = [:]
    guard let src = source,
          let ptr = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else { return result }
    let layoutData = Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue() as Data
    let kbdType = UInt32(LMGetKbdType())
    for keycode in 0..<128 {
        for (modState, needsShift) in [(UInt32(0), false), (UInt32(2), true)] {
            var deadKeyState: UInt32 = 0
            var chars = [UniChar](repeating: 0, count: 4)
            var length = 0
            let status = layoutData.withUnsafeBytes { raw -> OSStatus in
                guard let base = raw.baseAddress else { return -1 }
                let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
                return UCKeyTranslate(layout, UInt16(keycode), UInt16(kUCKeyActionDown), modState, kbdType,
                                      OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeyState,
                                      chars.count, &length, &chars)
            }
            if status == noErr, length == 1, chars[0] >= 32, let unicode = Unicode.Scalar(chars[0]) {
                let ch = Character(unicode)
                if result[ch] == nil { result[ch] = KeyStroke(code: CGKeyCode(keycode), shift: needsShift) }
            }
        }
    }
    return result
}

// Typing uses the CURRENT layout (the characters the user actually sees);
// Command shortcuts use the ASCII-capable layout, matching how macOS itself
// resolves Cmd+<letter>.
let typingStrokes: [Character: KeyStroke] = strokeMap(from: TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue())
let shortcutStrokes: [Character: KeyStroke] = {
    let ascii = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()
        ?? TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()
    let map = strokeMap(from: ascii)
    return map.isEmpty ? typingStrokes : map
}()

func typeText(_ text: String) {
    let limited = String(text.prefix(8_000))
    let source = CGEventSource(stateID: .hidSystemState)
    for character in limited {
        // Prefer a REAL key event with the layout-correct keycode: Chromium
        // (Chrome, Electron) ignores synthetic Unicode-string events in its
        // text fields, so the omnibox stayed empty. Fall back to a Unicode
        // event only for characters that are not directly on the keyboard.
        if let stroke = typingStrokes[character] {
            let flags: CGEventFlags = stroke.shift ? [.maskShift] : []
            if let down = CGEvent(keyboardEventSource: source, virtualKey: stroke.code, keyDown: true) {
                down.flags = flags; down.post(tap: .cghidEventTap)
            }
            usleep(3_000)
            if let up = CGEvent(keyboardEventSource: source, virtualKey: stroke.code, keyDown: false) {
                up.flags = flags; up.post(tap: .cghidEventTap)
            }
            usleep(3_000)
        } else {
            let utf16 = Array(String(character).utf16)
            guard !utf16.isEmpty,
                  let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { continue }
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            down.post(tap: .cghidEventTap)
            usleep(3_000)
            up.post(tap: .cghidEventTap)
            usleep(3_000)
        }
    }
}

// Named keys map to fixed virtual key codes: these positions are stable
// across keyboard layouts. Character keys (letters, digits, punctuation) are
// resolved from the ACTIVE layout instead — see charKeyCodes — so a shortcut
// like Cmd+T hits the physical key that produces "t" on the user's layout.
let namedKeyCodes: [String: CGKeyCode] = [
    "enter": 36, "return": 36, "tab": 48, "escape": 53, "esc": 53, "space": 49, "spacebar": 49,
    "delete": 51, "backspace": 51, "forwarddelete": 117, "forward_delete": 117,
    "up": 126, "down": 125, "left": 123, "right": 124,
    "home": 115, "end": 119, "pageup": 116, "page_up": 116, "pagedown": 121, "page_down": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111
]

// Word aliases for single characters the model may spell out.
let charAliases: [String: String] = [
    "minus": "-", "hyphen": "-", "dash": "-", "equal": "=", "equals": "=",
    "comma": ",", "period": ".", "dot": ".", "slash": "/", "backslash": "\\",
    "semicolon": ";", "quote": "'", "apostrophe": "'", "grave": "`", "backtick": "`",
    "leftbracket": "[", "rightbracket": "]", "plus": "+"
]

func keyCode(for key: String) -> CGKeyCode? {
    if let named = namedKeyCodes[key] { return named }
    let resolved = charAliases[key] ?? key
    if resolved.count == 1, let ch = resolved.first {
        // shortcutStrokes maps the character to the physical key that produces
        // it, so Cmd+T / Cmd+L / Cmd+A land correctly on AZERTY and QWERTY.
        if let stroke = shortcutStrokes[ch] { return stroke.code }
        if let lower = ch.lowercased().first, let stroke = shortcutStrokes[lower] { return stroke.code }
    }
    return nil
}

func modifierFlags(_ names: Set<String>) -> CGEventFlags {
    var flags: CGEventFlags = []
    if names.contains("cmd") || names.contains("command") || names.contains("meta") || names.contains("super") { flags.insert(.maskCommand) }
    if names.contains("ctrl") || names.contains("control") { flags.insert(.maskControl) }
    if names.contains("alt") || names.contains("option") || names.contains("opt") { flags.insert(.maskAlternate) }
    if names.contains("shift") { flags.insert(.maskShift) }
    return flags
}

func keyPress(_ request: JSON) -> Bool {
    var rawKey = String(request["key"] as? String ?? "").lowercased()
    var modifiers = Set((request["modifiers"] as? [String] ?? []).map { $0.lowercased() })
    // Weaker models often pack the whole chord into `key`, e.g. "cmd+t" or
    // "cmd+shift+n". Split it so the shortcut still fires instead of failing.
    if rawKey.contains("+") && rawKey.count > 1 {
        let parts = rawKey.split(separator: "+").map { String($0) }
        if let last = parts.last, !last.isEmpty { rawKey = last }
        for part in parts.dropLast() { modifiers.insert(part) }
    }
    guard let code = keyCode(for: rawKey) else { return false }
    let flags = modifierFlags(modifiers)
    let source = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
    down?.flags = flags; down?.post(tap: .cghidEventTap)
    usleep(12_000)
    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    up?.flags = flags; up?.post(tap: .cghidEventTap)
    return true
}

func resolveAppURL(_ pathValue: String) -> URL {
    let manager = FileManager.default
    if manager.fileExists(atPath: pathValue) { return URL(fileURLWithPath: pathValue) }
    // Models frequently guess "/Applications/Notes.app" for apps that live in
    // /System/Applications (or the reverse).  Resolve by bundle name before
    // failing so a wrong-but-unambiguous prefix still activates the right app.
    let requestedName = URL(fileURLWithPath: pathValue).lastPathComponent
    let name = requestedName.lowercased().hasSuffix(".app") ? requestedName : "\(requestedName).app"
    let candidates = [
        "/System/Applications/\(name)",
        "/System/Applications/Utilities/\(name)",
        "/Applications/\(name)",
        "/Applications/Utilities/\(name)",
        (NSHomeDirectory() as NSString).appendingPathComponent("Applications/\(name)"),
    ]
    for candidate in candidates where manager.fileExists(atPath: candidate) {
        return URL(fileURLWithPath: candidate)
    }
    // Modern NSWorkspace resolves bundle identifiers directly. The standard
    // application locations above handle display names without relying on the
    // deprecated fullPath(forApplication:) lookup.
    for bundleIdentifier in [pathValue, (requestedName as NSString).deletingPathExtension] {
        if bundleIdentifier.contains("."),
           let found = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) {
            return found
        }
    }
    return URL(fileURLWithPath: pathValue)
}

func activateApp(_ pathValue: String) throws {
    let url = resolveAppURL(pathValue)
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    // The helper exits right after answering: wait for the launch to actually
    // complete, otherwise the pending async activation dies with the process
    // and the action reports ok without any visible effect.
    let semaphore = DispatchSemaphore(value: 0)
    var failure: Error?
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, err in
        failure = err
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + 15) == .timedOut {
        throw NSError(domain: "zaalis", code: 4, userInfo: [NSLocalizedDescriptionKey: "application activation timed out"])
    }
    if let failure = failure { throw failure }
}

// Read the menu bar through macOS Accessibility rather than inferring an
// application's commands from its pixels.  This is intentionally read-only:
// it lets the model discover the exact commands and shortcuts of an unfamiliar
// app before choosing a normal keyboard or click action.
func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
          let value else { return nil }
    return value as? String
}

func axNumber(_ element: AXUIElement, _ attribute: CFString) -> NSNumber? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
          let value else { return nil }
    return value as? NSNumber
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
          let value else { return [] }
    return value as? [AXUIElement] ?? []
}

func menuShortcut(_ item: AXUIElement) -> JSON? {
    // AX modifiers use the same bit layout documented for AXMenuItem:
    // Shift=1, Option=2, Control=4, NoCommand=8. Command is implicit unless
    // NoCommand is set.
    let rawModifiers = axNumber(item, kAXMenuItemCmdModifiersAttribute as CFString)?.uintValue ?? 0
    var modifiers: [String] = []
    if rawModifiers & 8 == 0 { modifiers.append("cmd") }
    if rawModifiers & 1 != 0 { modifiers.append("shift") }
    if rawModifiers & 2 != 0 { modifiers.append("alt") }
    if rawModifiers & 4 != 0 { modifiers.append("ctrl") }

    var key = axString(item, kAXMenuItemCmdCharAttribute as CFString) ?? ""
    if key.isEmpty, let glyph = axNumber(item, kAXMenuItemCmdGlyphAttribute as CFString),
       let scalar = Unicode.Scalar(glyph.uint32Value) {
        key = String(Character(scalar))
    }
    guard !key.isEmpty else { return nil }
    let display = (modifiers + [key]).joined(separator: "+")
    return ["key": key, "modifiers": modifiers, "display": display]
}

func menuItems(_ element: AXUIElement, depth: Int = 0) -> [JSON] {
    // Deeply nested menus are unusual; the limit bounds a malformed AX tree
    // while still covering ordinary application menus.
    guard depth < 6 else { return [] }
    return axChildren(element).prefix(160).compactMap { child in
        let title = axString(child, kAXTitleAttribute as CFString)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let children = menuItems(child, depth: depth + 1)

        // Separators have neither a title nor useful descendants.  Containers
        // without a title are flattened so their visible commands are retained.
        guard !title.isEmpty else { return children.isEmpty ? nil : ["items": children] }
        var entry: JSON = ["title": title]
        if let enabled = axNumber(child, kAXEnabledAttribute as CFString) { entry["enabled"] = enabled.boolValue }
        if let shortcut = menuShortcut(child) { entry["shortcut"] = shortcut }
        if !children.isEmpty { entry["items"] = children }
        return entry
    }
}

func activeApplicationMenus() throws -> JSON {
    let system = AXUIElementCreateSystemWide()
    var focusedValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &focusedValue) == .success,
          let focusedValue,
          CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else {
        throw NSError(domain: "zaalis", code: 5, userInfo: [NSLocalizedDescriptionKey: "unable to read the active application; grant Accessibility access in macOS Settings"])
    }
    let app = focusedValue as! AXUIElement

    var menuBarValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &menuBarValue) == .success,
          let menuBarValue,
          CFGetTypeID(menuBarValue) == AXUIElementGetTypeID() else {
        throw NSError(domain: "zaalis", code: 6, userInfo: [NSLocalizedDescriptionKey: "the active application has no accessible menu bar"])
    }
    let menuBar = menuBarValue as! AXUIElement

    let menus: [JSON] = axChildren(menuBar).prefix(40).compactMap { menuBarItem in
        let title = axString(menuBarItem, kAXTitleAttribute as CFString)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let items = menuItems(menuBarItem)
        guard !title.isEmpty || !items.isEmpty else { return nil }
        return ["title": title.isEmpty ? "Menu" : title, "items": items]
    }
    return [
        "application": axString(app, kAXTitleAttribute as CFString) ?? "Application active",
        "menus": menus
    ]
}

guard let line = readLine(), let data = line.data(using: .utf8),
      let request = try? JSONSerialization.jsonObject(with: data) as? JSON else {
    error("invalid request"); exit(0)
}

let action = String(request["action"] as? String ?? "")
if action == "status" || action == "request_permissions" {
    let prompt = action == "request_permissions"
    output([
        "ok": true,
        "platform": "darwin",
        "accessibility": accessibilityTrusted(prompt: prompt),
        "screenRecording": screenPermission(prompt: prompt)
    ])
    exit(0)
}

guard ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 12 else {
    error("macOS 12 or newer is required"); exit(0)
}

do {
    switch action {
    case "menus":
        var result = try activeApplicationMenus()
        result["ok"] = true
        output(result)
    case "observe":
        // Do not gate actions on a preflight value: macOS may report a stale
        // TCC state just after an app/helper update.  The protected API itself
        // remains the authority and returns its real error if access is denied.
        output(["ok": true, "mime": "image/png", "image": try pngBase64()])
    case "move":
        guard let p = point(request) else { error("invalid coordinates"); break }
        move(to: p, duration: request["duration"] as? Double ?? 0.35)
        output(["ok": true])
    case "click":
        guard let p = point(request) else { error("invalid coordinates"); break }
        move(to: p, duration: request["duration"] as? Double ?? 0.28)
        let right = String(request["button"] as? String ?? "left") == "right"
        let button: CGMouseButton = right ? .right : .left
        postMouse(right ? .rightMouseDown : .leftMouseDown, at: p, button: button)
        usleep(55_000)
        postMouse(right ? .rightMouseUp : .leftMouseUp, at: p, button: button)
        output(["ok": true])
    case "scroll":
        let dx = Int32(max(-120, min(120, request["dx"] as? Int ?? 0)))
        let dy = Int32(max(-120, min(120, request["dy"] as? Int ?? 0)))
        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?.post(tap: .cghidEventTap)
        output(["ok": true])
    case "type":
        typeText(String(request["text"] as? String ?? "")); output(["ok": true])
    case "key":
        if keyPress(request) { output(["ok": true]) } else { error("unsupported key") }
    case "open_terminal":
        try activateApp("/System/Applications/Utilities/Terminal.app"); output(["ok": true])
    case "activate_app":
        let appPath = String(request["path"] as? String ?? "")
        guard appPath.hasPrefix("/") && appPath.hasSuffix(".app") else { error("invalid app path"); break }
        try activateApp(appPath); output(["ok": true])
    default:
        error("unsupported action")
    }
} catch {
    output(["ok": false, "error": error.localizedDescription])
}
