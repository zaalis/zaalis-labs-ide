import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import ImageIO
import Vision
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

// CoreGraphics' synchronous capture API works with the macOS 13 SDK used by
// Command Line Tools as well as newer Xcode SDKs.
func capturedImage(displayID: CGDirectDisplayID? = nil) throws -> CGImage {
    if let displayID, let image = CGDisplayCreateImage(displayID) {
        return image
    }
    if displayID == nil,
       let image = CGWindowListCreateImage(.infinite, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]) {
        return image
    }
    throw NSError(domain: "zaalis", code: 1, userInfo: [NSLocalizedDescriptionKey: "screen capture failed; grant Screen Recording permission to zaalis IDE"])
}

func pngBase64() throws -> String {
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
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
    "del": 117, "insert": 114, "ins": 114, "help": 114, "pgup": 116, "pgdn": 121,
    "capslock": 57, "caps_lock": 57, "numlock": 71, "clear": 71,
    "volumeup": 72, "volume_up": 72, "volumedown": 73, "volume_down": 73, "volumemute": 74, "mute": 74,
    "numpad0": 82, "numpad1": 83, "numpad2": 84, "numpad3": 85, "numpad4": 86,
    "numpad5": 87, "numpad6": 88, "numpad7": 89, "numpad8": 91, "numpad9": 92,
    "multiply": 67, "add": 69, "subtract": 78, "decimal": 65, "divide": 75, "numpadenter": 76
]

// Media keys are not keyboard events on macOS: they travel as NX system
// events (NX_KEYTYPE_*), exactly what the hardware keys send.
let mediaKeyTypes: [String: Int] = [
    "mediaplaypause": 16, "playpause": 16, "medianext": 17, "mediaprev": 18, "mediaprevious": 18,
    "brightnessup": 2, "brightnessdown": 3
]

func postMediaKey(_ type: Int) {
    for down in [true, false] {
        let flags = NSEvent.ModifierFlags(rawValue: down ? 0xa00 : 0xb00)
        let data1 = (type << 16) | ((down ? 0xa : 0xb) << 8)
        let event = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags, timestamp: 0,
                                       windowNumber: 0, context: nil, subtype: 8, data1: data1, data2: -1)
        event?.cgEvent?.post(tap: .cghidEventTap)
        usleep(12_000)
    }
}

// Keys without a macOS equivalent: the Windows key acts as Command, the
// context-menu key as a right click is not a key, so it is refused clearly.
let keyAliases: [String: String] = ["win": "cmd", "windows": "cmd", "super": "cmd", "meta": "cmd", "option": "alt"]

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
    if names.contains("cmd") || names.contains("command") || names.contains("meta") || names.contains("super") || names.contains("win") || names.contains("windows") { flags.insert(.maskCommand) }
    if names.contains("ctrl") || names.contains("control") { flags.insert(.maskControl) }
    if names.contains("alt") || names.contains("option") || names.contains("opt") { flags.insert(.maskAlternate) }
    if names.contains("shift") { flags.insert(.maskShift) }
    return flags
}

// Modifier keys pressed on their own ("key": "shift", hold_key "alt").
let modifierKeyCodes: [String: CGKeyCode] = [
    "cmd": 55, "command": 55, "shift": 56, "alt": 58, "ctrl": 59, "control": 59, "fn": 63
]

func parsedChord(_ request: JSON) -> (key: String, modifiers: Set<String>) {
    var rawKey = String(request["key"] as? String ?? "").lowercased()
    var modifiers = Set((request["modifiers"] as? [String] ?? []).map { $0.lowercased() })
    // Weaker models often pack the whole chord into `key`, e.g. "cmd+t" or
    // "cmd+shift+n". Split it so the shortcut still fires instead of failing.
    if rawKey.contains("+") && rawKey.count > 1 {
        let parts = rawKey.split(separator: "+").map { String($0) }
        if let last = parts.last, !last.isEmpty { rawKey = last }
        for part in parts.dropLast() { modifiers.insert(part) }
    }
    if let alias = keyAliases[rawKey] { rawKey = alias }
    return (rawKey, modifiers)
}

// Presses (and, unless `hold` is given, releases) one chord. `hold` keeps
// the key and its modifiers down for that many seconds before releasing.
func keyPress(_ request: JSON, hold: Double? = nil) -> Bool {
    let chord = parsedChord(request)
    let repeatCount = max(1, min(30, request["repeat"] as? Int ?? 1))
    if let media = mediaKeyTypes[chord.key] {
        for _ in 0..<repeatCount { postMediaKey(media) }
        return true
    }
    guard let code = keyCode(for: chord.key) ?? modifierKeyCodes[chord.key] else { return false }
    let lone: [String] = modifierKeyCodes[chord.key] != nil ? [chord.key] : []
    let flags = modifierFlags(chord.modifiers.union(lone))
    let source = CGEventSource(stateID: .hidSystemState)
    let modifierCodes = chord.modifiers.compactMap { modifierKeyCodes[keyAliases[$0] ?? $0] }
    for _ in 0..<(hold == nil ? repeatCount : 1) {
        if hold != nil {
            // Real modifier key-downs first, so applications that watch the
            // modifier state (drag with Option, Shift-select) see them held.
            for modifier in modifierCodes {
                let event = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: true)
                event?.flags = flags; event?.post(tap: .cghidEventTap)
            }
        }
        let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
        down?.flags = flags; down?.post(tap: .cghidEventTap)
        if let hold {
            // Auto-repeat is left to the application, as with a physical key.
            usleep(useconds_t(max(0.05, min(10, hold)) * 1_000_000))
        } else {
            usleep(12_000)
        }
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        up?.flags = hold == nil ? flags : []; up?.post(tap: .cghidEventTap)
        if hold != nil {
            for modifier in modifierCodes.reversed() {
                CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: false)?.post(tap: .cghidEventTap)
            }
        }
        usleep(12_000)
    }
    return true
}

func mouseButton(_ request: JSON) -> (button: CGMouseButton, down: CGEventType, up: CGEventType) {
    switch String(request["button"] as? String ?? "left") {
    case "right": return (.right, .rightMouseDown, .rightMouseUp)
    case "middle": return (.center, .otherMouseDown, .otherMouseUp)
    default: return (.left, .leftMouseDown, .leftMouseUp)
    }
}

func cursorLocation() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

// The clipboard as the user would paste it: text first, otherwise the files
// copied in the Finder, otherwise whether an image is present.
func clipboardRead() -> JSON {
    let board = NSPasteboard.general
    var result: JSON = ["ok": true]
    if let text = board.string(forType: .string), !text.isEmpty {
        result["text"] = String(text.prefix(200_000))
        return result
    }
    if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
        result["files"] = urls.prefix(50).map { $0.path }
    }
    result["has_image"] = board.canReadItem(withDataConformingToTypes: [NSPasteboard.PasteboardType.png.rawValue, NSPasteboard.PasteboardType.tiff.rawValue])
    return result
}

func clipboardWrite(_ text: String) -> Bool {
    let board = NSPasteboard.general
    board.clearContents()
    return board.setString(text, forType: .string)
}

// A 64x36 grey-level thumbnail, two hex digits per cell: the shared
// automation manager compares two of them to tell whether the screen
// visibly changed after an action (same format as the Windows bridge).
func visualSignature(_ image: CGImage) -> String? {
    let width = 64, height = 36
    var pixels = [UInt8](repeating: 0, count: width * height)
    let rendered = pixels.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    guard rendered else { return nil }
    return pixels.map { String(format: "%02x", $0) }.joined()
}

// Every installed application bundle, as Launchpad and the Finder's
// Applications folder list them (one level of subfolders, e.g. "Microsoft Office").
func installedApplications() -> [URL] {
    let manager = FileManager.default
    let roots = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
                 (NSHomeDirectory() as NSString).appendingPathComponent("Applications")]
    var found: [URL] = []
    for root in roots {
        guard let entries = try? manager.contentsOfDirectory(atPath: root) else { continue }
        for entry in entries {
            let full = (root as NSString).appendingPathComponent(entry)
            if entry.lowercased().hasSuffix(".app") { found.append(URL(fileURLWithPath: full)); continue }
            var isDirectory: ObjCBool = false
            guard manager.fileExists(atPath: full, isDirectory: &isDirectory), isDirectory.boolValue,
                  !["Utilities"].contains(entry),
                  let nested = try? manager.contentsOfDirectory(atPath: full) else { continue }
            for child in nested where child.lowercased().hasSuffix(".app") {
                found.append(URL(fileURLWithPath: (full as NSString).appendingPathComponent(child)))
            }
        }
    }
    return found
}

func applicationName(_ url: URL) -> String { (url.lastPathComponent as NSString).deletingPathExtension }

struct ApplicationNotFound: Error { let suggestions: [String] }

func resolveAppURL(_ pathValue: String) throws -> URL {
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
    // As on Windows (Start menu) and Linux (applications menu): the name the
    // user sees, matched without regard to case, never through PATH.
    let wanted = (requestedName as NSString).deletingPathExtension.lowercased()
    let installed = installedApplications()
    if let exact = installed.first(where: { applicationName($0).lowercased() == wanted }) { return exact }
    let close = installed.map(applicationName).filter { name in
        let lower = name.lowercased()
        return !wanted.isEmpty && (lower.contains(wanted) || wanted.contains(lower))
    }
    if close.count == 1, let only = installed.first(where: { applicationName($0) == close[0] }) { return only }
    throw ApplicationNotFound(suggestions: Array(Set(close)).sorted().prefix(8).map { $0 })
}

func activateApp(_ pathValue: String) throws {
    let url = try resolveAppURL(pathValue)
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

// Geometry is in macOS global display points; images and AX elements are
// returned in image pixels so the shared automation manager can map clicks.
func axElement(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
          let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func axRect(_ element: AXUIElement) -> CGRect? {
    var pv: CFTypeRef?, sv: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &pv) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sv) == .success,
          let pv, let sv, CFGetTypeID(pv) == AXValueGetTypeID(), CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    guard AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &s) else { return nil }
    return CGRect(origin: p, size: s)
}
func focusedElement() -> AXUIElement? {
    return axElement(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString)
}
func guardedTarget(_ request: JSON) -> String? {
    let action = request["action"] as? String ?? ""
    let system = AXUIElementCreateSystemWide()
    var target = focusedElement()
    if ["click", "double_click", "triple_click", "mouse_up"].contains(action) {
        let p = point(request) ?? (action == "mouse_up" ? cursorLocation() : nil)
        var hit: AXUIElement?
        if let p, AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &hit) == .success { target = hit }
    }
    guard let target else { return nil }
    let secureField = axString(target, kAXSubroleAttribute as CFString) == "AXSecureTextField"
    if action == "type", secureField { return "password-field" }
    if action == "key" || action == "hold_key" {
        // A key that would put text into the focused field: a character
        // without Command/Control/Option, or a paste (Cmd+V, Ctrl+V).
        let chord = parsedChord(request)
        let chorded = !chord.modifiers.intersection(["cmd", "command", "ctrl", "control", "alt", "option", "win", "meta"]).isEmpty
        let writes = (chord.key.count == 1 && !chorded)
            || (chord.key == "v" && !chord.modifiers.intersection(["cmd", "command", "ctrl", "control", "win", "meta"]).isEmpty)
        if secureField && writes { return "password-field" }
    }
    if action == "key" {
        let key = String(request["key"] as? String ?? "").lowercased()
        if !["enter", "return", "space", " "].contains(key) { return nil }
    }
    guard ["click", "double_click", "triple_click", "mouse_up", "key"].contains(action), let pattern = request["guard"] as? String,
          let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return nil }
    var element: AXUIElement? = target
    for _ in 0..<4 {
        guard let current = element else { break }
        let title = [axString(current, kAXTitleAttribute as CFString), axString(current, kAXDescriptionAttribute as CFString)].compactMap { $0 }.joined(separator: " ")
        if regex.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)) != nil { return title }
        element = axElement(current, kAXParentAttribute as CFString)
    }
    return nil
}
func pngData(_ image: CGImage) throws -> String {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { throw NSError(domain: "zaalis", code: 2) }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { throw NSError(domain: "zaalis", code: 3) }
    return data.base64EncodedString()
}
func inspectDesktop(_ request: JSON) throws -> JSON {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16), count: UInt32 = 0
    CGGetActiveDisplayList(16, &ids, &count)
    let displays = Array(ids.prefix(Int(count)))
    guard !displays.isEmpty else { throw NSError(domain: "zaalis", code: 1) }
    let target = request["target"] as? String ?? "display"
    let system = AXUIElementCreateSystemWide()
    let application = axElement(system, kAXFocusedApplicationAttribute as CFString)
    let window = application.flatMap { axElement($0, kAXFocusedWindowAttribute as CFString) }
    var area = displays.map { CGDisplayBounds($0) }.reduce(CGRect.null) { $0.union($1) }
    if let index = request["display_index"] as? Int, displays.indices.contains(index) { area = CGDisplayBounds(displays[index]) }
    if target == "active_window", let window, let frame = axRect(window) { area = frame }
    if target == "region" { area = CGRect(x: request["x"] as? Double ?? 0, y: request["y"] as? Double ?? 0, width: request["width"] as? Double ?? 0, height: request["height"] as? Double ?? 0) }
    guard area.width > 0, area.height > 0 else { throw NSError(domain: "zaalis", code: 1) }
    let maxDimension = max(800, min(4096, request["max_dimension"] as? Int ?? 2560))
    let scale = min(1, Double(maxDimension) / max(area.width, area.height))
    let width = max(1, Int(area.width * scale)), height = max(1, Int(area.height * scale))
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw NSError(domain: "zaalis", code: 1) }
    for id in displays {
        let frame = CGDisplayBounds(id), overlap = frame.intersection(area)
        if overlap.isNull || overlap.isEmpty { continue }
        let image = try capturedImage(displayID: id)
        let crop = CGRect(x: (overlap.minX-frame.minX)*Double(image.width)/frame.width, y: (overlap.minY-frame.minY)*Double(image.height)/frame.height, width: overlap.width*Double(image.width)/frame.width, height: overlap.height*Double(image.height)/frame.height)
        if let part = image.cropping(to: crop) {
            context.draw(part, in: CGRect(x: (overlap.minX-area.minX)*scale, y: (area.maxY-overlap.maxY)*scale, width: overlap.width*scale, height: overlap.height*scale))
        }
    }
    guard let image = context.makeImage() else { throw NSError(domain: "zaalis", code: 1) }
    var result: JSON = ["ok": true, "target": target, "application": NSWorkspace.shared.frontmostApplication?.localizedName ?? "", "capture": ["x": area.minX, "y": area.minY, "width": area.width, "height": area.height], "image_width": width, "image_height": height, "displays": displays.enumerated().map { index, id -> JSON in ["index": index, "x": CGDisplayBounds(id).minX, "y": CGDisplayBounds(id).minY, "width": CGDisplayBounds(id).width, "height": CGDisplayBounds(id).height] }]
    if request["include_image"] as? Bool != false { result["image"] = try pngData(image); result["mime"] = "image/png" }
    if let signature = visualSignature(image) { result["signature"] = signature }
    func relative(_ frame: CGRect) -> [Double] { return [(frame.minX-area.minX)*scale, (frame.minY-area.minY)*scale, frame.width*scale, frame.height*scale] }
    if request["include_ui"] as? Bool != false, let application {
        var elements: [JSON] = []
        let cap = max(25, min(400, request["max_elements"] as? Int ?? 220))
        var visited = Set<CFHashCode>()
        func walk(_ item: AXUIElement, _ depth: Int) {
            guard depth < 18, elements.count < cap, visited.insert(CFHash(item)).inserted else { return }
            if let frame = axRect(item), frame.intersects(area) {
                let secure = axString(item, kAXSubroleAttribute as CFString) == "AXSecureTextField"
                var e: JSON = ["role": axString(item, kAXRoleAttribute as CFString) ?? "", "title": axString(item, kAXTitleAttribute as CFString) ?? "", "label": axString(item, kAXDescriptionAttribute as CFString) ?? "", "frame": relative(frame), "center": [(frame.midX-area.minX)*scale, (frame.midY-area.minY)*scale], "secure": secure]
                if !secure { e["value"] = axString(item, kAXValueAttribute as CFString) }
                elements.append(e)
            }
            for child in axChildren(item) { walk(child, depth+1) }
        }
        walk(window ?? application, 0)
        result["ui"] = ["source": "macOS Accessibility", "elements": elements, "truncated": elements.count >= cap]
    }
    if request["include_ocr"] as? Bool != false {
        let recognition = VNRecognizeTextRequest()
        recognition.recognitionLevel = .accurate
        recognition.recognitionLanguages = ["fr-FR", "en-US"]
        do {
            try VNImageRequestHandler(cgImage: image).perform([recognition])
            result["ocr"] = (recognition.results ?? []).prefix(200).compactMap { item -> JSON? in
                guard let text = item.topCandidates(1).first?.string else { return nil }
                let box = item.boundingBox
                return ["text": text, "frame": [box.minX*Double(width), (1-box.maxY)*Double(height), box.width*Double(width), box.height*Double(height)]]
            }
        } catch { result["ocrError"] = error.localizedDescription }
    }
    return result
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

// One gesture, as the shared automation manager describes it. A batch runs
// several of them in this single process: no helper start-up between a click,
// the text and Enter, so the sequence runs as fast as a person would.
func perform(_ request: JSON) throws -> JSON {
    let action = String(request["action"] as? String ?? "")
    if let blocked = guardedTarget(request) {
        return ["ok": false, "error": blocked == "password-field" ? blocked : "sensitive-target", "target": blocked]
    }
    switch action {
    case "menus":
        var result = try activeApplicationMenus()
        result["ok"] = true
        return result
    case "inspect", "observe":
        // Do not gate actions on a preflight value: macOS may report a stale
        // TCC state just after an app/helper update.  The protected API itself
        // remains the authority and returns its real error if access is denied.
        return try inspectDesktop(request)
    case "move":
        guard let p = point(request) else { return ["ok": false, "error": "invalid coordinates"] }
        move(to: p, duration: request["duration"] as? Double ?? 0.35)
        return ["ok": true]
    case "drag":
        guard let p = point(request), let tx = request["to_x"] as? Double, let ty = request["to_y"] as? Double else { return ["ok": false, "error": "invalid coordinates"] }
        move(to: p, duration: 0.2)
        postMouse(.leftMouseDown, at: p)
        let end = CGPoint(x: tx, y: ty)
        let steps = max(6, Int((request["duration"] as? Double ?? 0.5) * 60))
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            postMouse(.leftMouseDragged, at: CGPoint(x: p.x+(end.x-p.x)*t, y: p.y+(end.y-p.y)*t))
            usleep(16_000)
        }
        postMouse(.leftMouseUp, at: end)
        return ["ok": true]
    case "click", "double_click", "triple_click":
        guard let p = point(request) else { return ["ok": false, "error": "invalid coordinates"] }
        move(to: p, duration: request["duration"] as? Double ?? 0.28)
        let mouse = mouseButton(request)
        let flags = modifierFlags(Set((request["modifiers"] as? [String] ?? []).map { $0.lowercased() }))
        let clicks = action == "triple_click" ? 3 : action == "double_click" ? 2 : 1
        for count in 1...clicks {
            for down in [true, false] {
                let event = CGEvent(mouseEventSource: nil, mouseType: down ? mouse.down : mouse.up, mouseCursorPosition: p, mouseButton: mouse.button)
                event?.flags = flags; event?.setIntegerValueField(.mouseEventClickState, value: Int64(count)); event?.post(tap: .cghidEventTap)
                usleep(55_000)
            }
        }
        return ["ok": true]
    case "mouse_down", "mouse_up":
        // Without coordinates the button acts under the pointer, where a
        // previous move or mouse_down left it.
        let p = point(request) ?? cursorLocation()
        if point(request) != nil { move(to: p, duration: 0.2) }
        let mouse = mouseButton(request)
        if action == "mouse_up", mouse.button == .left, point(request) != nil {
            // Pressed elsewhere: report the motion as a drag so the target
            // application follows the selection or the dragged object.
            postMouse(.leftMouseDragged, at: p)
        }
        CGEvent(mouseEventSource: nil, mouseType: action == "mouse_down" ? mouse.down : mouse.up, mouseCursorPosition: p, mouseButton: mouse.button)?.post(tap: .cghidEventTap)
        return ["ok": true]
    case "cursor_position":
        let p = cursorLocation()
        return ["ok": true, "x": p.x, "y": p.y]
    case "scroll":
        if let p = point(request) { move(to: p, duration: 0.1) }
        // dy > 0 goes down the page and dx > 0 to the right, as on Windows
        // and Linux; a positive CoreGraphics wheel delta scrolls the other way.
        let dx = Int32(max(-120, min(120, request["dx"] as? Int ?? 0)))
        let dy = Int32(max(-120, min(120, request["dy"] as? Int ?? 0)))
        CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0)?.post(tap: .cghidEventTap)
        return ["ok": true]
    case "type":
        typeText(String(request["text"] as? String ?? ""))
        return ["ok": true]
    case "key":
        return keyPress(request) ? ["ok": true] : ["ok": false, "error": "unknown-key: \(parsedChord(request).key)"]
    case "hold_key":
        let seconds = max(0.05, min(10, request["seconds"] as? Double ?? 1))
        return keyPress(request, hold: seconds) ? ["ok": true] : ["ok": false, "error": "unknown-key: \(parsedChord(request).key)"]
    case "clipboard_read":
        return clipboardRead()
    case "clipboard_write":
        let text = String(request["text"] as? String ?? "")
        guard !text.isEmpty else { return ["ok": false, "error": "clipboard: empty text"] }
        return clipboardWrite(text) ? ["ok": true] : ["ok": false, "error": "clipboard: write failed"]
    case "wait":
        usleep(useconds_t(max(0.05, min(10, request["seconds"] as? Double ?? 1)) * 1_000_000))
        return ["ok": true]
    case "open_terminal":
        try activateApp("/System/Applications/Utilities/Terminal.app")
        return ["ok": true]
    case "activate_app":
        let appPath = String(request["path"] as? String ?? "")
        guard !appPath.isEmpty else { return ["ok": false, "error": "invalid app path"] }
        try activateApp(appPath)
        return ["ok": true, "application": NSWorkspace.shared.frontmostApplication?.localizedName ?? ""]
    default:
        return ["ok": false, "error": "unsupported-action: \(action)"]
    }
}

func performCatching(_ request: JSON) -> JSON {
    do { return try perform(request) }
    catch let missing as ApplicationNotFound { return ["ok": false, "error": "application-not-found", "suggestions": missing.suggestions] }
    catch { return ["ok": false, "error": error.localizedDescription] }
}

if action == "batch" {
    let steps = request["actions"] as? [JSON] ?? []
    var outcomes: [JSON] = []
    var okAll = !steps.isEmpty
    for step in steps.prefix(20) {
        let outcome = performCatching(step)
        outcomes.append(outcome)
        if outcome["ok"] as? Bool != true { okAll = false; break }
        // Lets the application react before the next gesture.
        usleep(60_000)
    }
    output(["ok": okAll, "steps": outcomes])
} else {
    output(performCatching(request))
}
