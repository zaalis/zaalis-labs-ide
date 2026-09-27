// =============================================================================
//  zaalis Browser integre a zaalis IDE  -  executant natif WebView2
// -----------------------------------------------------------------------------
//  La logique du navigateur est celle de zaalis Browser lui-meme (processus
//  principal vendu dans zaalis-browser/app/main.js), executee par
//  zaalis-server. Ce fichier ne contient aucune regle de navigation : il cree
//  et pilote les vues WebView2 qu'on lui demande, et remonte leurs evenements.
//
//  Canal : tube nomme prive (ACL proprietaire + SYSTEM), JSON par ligne.
//    - serveur -> natif : { op, id?, ... }       (id => reponse attendue)
//    - natif -> serveur : { re, ok, result } ou { ev, ... }
//  Le premier message doit etre { op:"hello", token } avec le jeton a usage
//  unique publie dans l'environnement du serveur par PrepareChannel().
//
//  Chaque vue vit dans sa propre fenetre conteneur : bornes, visibilite, ordre
//  d'empilement et decoupe (region) s'appliquent a cette fenetre, ce qui rend
//  l'ordre des vues deterministe (dernier element ajoute au-dessus).
// =============================================================================

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef UNICODE
#define UNICODE
#endif

#include <windows.h>
#include <wrl.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shobjidl.h>
#include <shellapi.h>
#include <commctrl.h>
#include <sddl.h>
#include <wincodec.h>
#include <wincrypt.h>
#include <bcrypt.h>
#include <string>
#include <vector>
#include <map>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <atomic>
#include <condition_variable>
#include <algorithm>
#include <cmath>
#include "WebView2.h"
#include "WebView2EnvironmentOptions.h"
#include "BrowserHost.h"
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "shlwapi.lib")
// Common Controls v6 : TaskDialog (boutons personnalises des autorisations).
#pragma comment(linker, "\"/manifestdependency:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"")

using namespace Microsoft::WRL;
using namespace winrt::Windows::Data::Json;

namespace ZaalisBrowser {

// ----- Constantes ---------------------------------------------------------------
static const wchar_t* kPanelClass = L"zaalisIdeBrowserPanel";
static const wchar_t* kViewClass  = L"zaalisIdeBrowserView";
static const UINT     WM_ZB_LINE  = WM_APP + 0x5B1;
static const size_t   kMaxLine    = 8 * 1024 * 1024;

// Pont window.zaalisBridge, uniquement pour les pages internes zaalis://
// (meme contrat que preload-chrome.js / preload-content.js d'Electron).
static const wchar_t* kBridgeScript =
    L"(() => {"
    // Un site externe ne voit aucune API du navigateur (certains, comme
    // YouTube, changent de comportement s'ils detectent une WebView).
    L"  if (location.protocol !== 'zaalis:') { try { if (window.chrome) delete window.chrome.webview; } catch (e) {} return; }"
    L"  if (window.zaalisBridge) return;"
    L"  const wv = window.chrome && window.chrome.webview; if (!wv) return;"
    L"  const handlers = new Map();"
    L"  Object.defineProperty(window, 'zaalisBridge', { value: Object.freeze({"
    L"    postMessage(m) { if (typeof m !== 'string') { try { m = JSON.stringify(m); } catch (e) { return; } } wv.postMessage(m); },"
    L"    addEventListener(name, cb) { if (name !== 'message' || typeof cb !== 'function' || handlers.has(cb)) return;"
    L"      const h = (e) => cb({ data: e.data }); handlers.set(cb, h); wv.addEventListener('message', h); },"
    L"    removeEventListener(name, cb) { const h = handlers.get(cb); if (h) { wv.removeEventListener('message', h); handlers.delete(cb); } }"
    L"  }) });"
    L"})();";

// ----- Etat ----------------------------------------------------------------------------
struct PendingDownload {
    ComPtr<ICoreWebView2DownloadStartingEventArgs> args;
    ComPtr<ICoreWebView2Deferral> deferral;
    ComPtr<ICoreWebView2DownloadOperation> operation;
};

struct View {
    int id = 0;
    std::wstring kind;
    std::wstring profile;
    bool inPrivate = false;
    HWND host = nullptr;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> webview;
    bool ready = false;
    bool destroyed = false;
    bool visible = true;
    RECT dip{ 0, 0, 0, 0 };          // x, y, largeur, hauteur (DIP)
    COREWEBVIEW2_COLOR background{ 0, 0, 0, 0 };
    double zoom = 1.0;
    int selfNavigations = 0;         // navigations demandees par le serveur
    std::vector<std::wstring> pending;
    // Decoupe de la barre d'outils quand un menu deborde sur la page.
    bool region = false;
    int regionTop = 0;
    RECT overlay{ 0, 0, 0, 0 };
    bool hasOverlay = false;
};

static HWND g_hwnd = nullptr;
static StateCallback g_stateCallback;
static bool g_closing = false;
static bool g_visible = false;
static bool g_authenticated = false;
static std::wstring g_lastTabs = L"[]";
static COREWEBVIEW2_COLOR g_panelColor{ 255, 32, 33, 36 };
static HBRUSH g_panelBrush = nullptr;

static ComPtr<ICoreWebView2Environment> g_env;
static bool g_envStarting = false;
static std::map<int, std::unique_ptr<View>> g_views;

struct Accelerator { bool ctrl, shift, alt; std::wstring key; };
static std::vector<Accelerator> g_accelerators;

static int g_nextRequest = 1;
static std::map<int, std::pair<ComPtr<ICoreWebView2PermissionRequestedEventArgs>, ComPtr<ICoreWebView2Deferral>>> g_permissions;
static std::map<int, std::pair<ComPtr<ICoreWebView2WebResourceRequestedEventArgs>, ComPtr<ICoreWebView2Deferral>>> g_resources;
static std::map<int, PendingDownload> g_downloads;

// ----- Canal (tube nomme) ---------------------------------------------------------
static std::wstring g_pipeName;
static std::string  g_token;
static HANDLE g_pipe = INVALID_HANDLE_VALUE;
static HANDLE g_stopEvent = nullptr;
static std::thread g_reader;
static std::thread g_writer;
static std::mutex g_writeLock;
static std::condition_variable g_writeSignal;
static std::deque<std::string> g_writeQueue;
static std::atomic<bool> g_stopping{ false };
static std::atomic<bool> g_pipeConnected{ false };

static std::string ToUtf8(const std::wstring& s)
{
    if (s.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0, nullptr, nullptr);
    std::string out(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), &out[0], n, nullptr, nullptr);
    return out;
}

static std::wstring FromUtf8(const std::string& s)
{
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring out(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &out[0], n);
    return out;
}

static std::wstring JsonEscape(const std::wstring& s)
{
    std::wstring o; o.reserve(s.size() + 8);
    for (wchar_t c : s) {
        switch (c) {
            case L'"':  o += L"\\\""; break;
            case L'\\': o += L"\\\\"; break;
            case L'\n': o += L"\\n";  break;
            case L'\r': o += L"\\r";  break;
            case L'\t': o += L"\\t";  break;
            default:
                if (c < 0x20 || c == 0x2028 || c == 0x2029) { wchar_t b[8]; swprintf(b, 8, L"\\u%04x", c); o += b; }
                else o += c;
        }
    }
    return o;
}

// Petit ecrivain JSON pour les messages sortants.
struct Json {
    std::wstring s = L"{";
    bool first = true;
    Json& key(const wchar_t* k) { if (!first) s += L','; first = false; s += L'"'; s += k; s += L"\":"; return *this; }
    Json& str(const wchar_t* k, const std::wstring& v) { key(k); s += L'"' + JsonEscape(v) + L'"'; return *this; }
    Json& num(const wchar_t* k, double v) {
        key(k);
        wchar_t b[64];
        if (std::floor(v) == v && std::fabs(v) < 9e15) swprintf(b, 64, L"%lld", (long long)v); else swprintf(b, 64, L"%.6f", v);
        s += b; return *this;
    }
    Json& boolean(const wchar_t* k, bool v) { key(k); s += v ? L"true" : L"false"; return *this; }
    Json& raw(const wchar_t* k, const std::wstring& json) { key(k); s += json.empty() ? L"null" : json; return *this; }
    std::wstring done() const { return s + L"}"; }
};

static void WriteLine(const std::wstring& json)
{
    if (!g_pipeConnected || g_stopping) return;
    std::string line = ToUtf8(json);
    line += '\n';
    {
        std::lock_guard<std::mutex> lock(g_writeLock);
        g_writeQueue.push_back(std::move(line));
    }
    g_writeSignal.notify_one();
}

static void Emit(Json& message) { if (g_authenticated) WriteLine(message.done()); }

static void Reply(int id, const std::wstring& resultJson)
{
    if (id <= 0) return;
    Json j; j.num(L"re", id).boolean(L"ok", true).raw(L"result", resultJson.empty() ? L"{}" : resultJson);
    WriteLine(j.done());
}

static void ReplyError(int id, const std::wstring& error)
{
    if (id <= 0) return;
    Json j; j.num(L"re", id).boolean(L"ok", false).str(L"error", error);
    WriteLine(j.done());
}

static void WriterLoop()
{
    OVERLAPPED ov{};
    ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    while (!g_stopping) {
        std::string line;
        {
            std::unique_lock<std::mutex> lock(g_writeLock);
            g_writeSignal.wait(lock, [] { return g_stopping.load() || !g_writeQueue.empty(); });
            if (g_stopping) break;
            line = std::move(g_writeQueue.front());
            g_writeQueue.pop_front();
        }
        size_t offset = 0;
        while (offset < line.size() && !g_stopping) {
            ResetEvent(ov.hEvent);
            DWORD chunk = (DWORD)std::min<size_t>(line.size() - offset, 1 << 20);
            DWORD written = 0;
            BOOL ok = WriteFile(g_pipe, line.data() + offset, chunk, nullptr, &ov);
            if (!ok && GetLastError() != ERROR_IO_PENDING) break;
            if (!GetOverlappedResult(g_pipe, &ov, &written, TRUE)) break;
            offset += written;
        }
    }
    CloseHandle(ov.hEvent);
}

static void ReaderLoop()
{
    OVERLAPPED ov{};
    ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    std::string buffer;
    std::vector<char> chunk(64 * 1024);
    while (!g_stopping) {
        // Attente d'un client (le serveur zaalis).
        ResetEvent(ov.hEvent);
        BOOL connected = ConnectNamedPipe(g_pipe, &ov);
        DWORD error = connected ? ERROR_PIPE_CONNECTED : GetLastError();
        if (error == ERROR_IO_PENDING) {
            HANDLE waits[2] = { ov.hEvent, g_stopEvent };
            if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0) break;
            DWORD ignored = 0;
            if (!GetOverlappedResult(g_pipe, &ov, &ignored, FALSE)) { DisconnectNamedPipe(g_pipe); continue; }
        } else if (error != ERROR_PIPE_CONNECTED) {
            if (WaitForSingleObject(g_stopEvent, 500) == WAIT_OBJECT_0) break;
            continue;
        }
        g_pipeConnected = true;
        buffer.clear();
        for (;;) {
            ResetEvent(ov.hEvent);
            DWORD read = 0;
            BOOL ok = ReadFile(g_pipe, chunk.data(), (DWORD)chunk.size(), nullptr, &ov);
            if (!ok && GetLastError() != ERROR_IO_PENDING && GetLastError() != ERROR_MORE_DATA) break;
            HANDLE waits[2] = { ov.hEvent, g_stopEvent };
            if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0) { CancelIoEx(g_pipe, &ov); break; }
            if (!GetOverlappedResult(g_pipe, &ov, &read, FALSE) && GetLastError() != ERROR_MORE_DATA) break;
            buffer.append(chunk.data(), read);
            size_t end;
            while ((end = buffer.find('\n')) != std::string::npos) {
                auto* line = new std::string(buffer.substr(0, end));
                buffer.erase(0, end + 1);
                if (!g_hwnd || !PostMessageW(g_hwnd, WM_ZB_LINE, 0, reinterpret_cast<LPARAM>(line))) delete line;
            }
            if (buffer.size() > kMaxLine) break;   // message hors limites : on coupe
        }
        g_pipeConnected = false;
        {
            std::lock_guard<std::mutex> lock(g_writeLock);
            g_writeQueue.clear();
        }
        auto* marker = new std::string("\x01disconnected");
        if (!g_hwnd || !PostMessageW(g_hwnd, WM_ZB_LINE, 0, reinterpret_cast<LPARAM>(marker))) delete marker;
        DisconnectNamedPipe(g_pipe);
    }
    CloseHandle(ov.hEvent);
}

static std::wstring RandomHex(size_t bytes)
{
    std::vector<unsigned char> raw(bytes);
    BCryptGenRandom(nullptr, raw.data(), (ULONG)raw.size(), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
    static const wchar_t* digits = L"0123456789abcdef";
    std::wstring out;
    for (unsigned char b : raw) { out += digits[b >> 4]; out += digits[b & 15]; }
    return out;
}

static std::wstring CurrentUserSid()
{
    HANDLE token = nullptr;
    std::wstring sid;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return sid;
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    std::vector<BYTE> data(size);
    if (size && GetTokenInformation(token, TokenUser, data.data(), size, &size)) {
        LPWSTR text = nullptr;
        if (ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &text)) { sid = text; LocalFree(text); }
    }
    CloseHandle(token);
    return sid;
}

bool PrepareChannel()
{
    if (g_pipe != INVALID_HANDLE_VALUE) return true;
    std::wstring sid = CurrentUserSid();
    if (sid.empty()) return false;
    // Seuls l'utilisateur courant et SYSTEM peuvent ouvrir le tube.
    std::wstring sddl = L"D:P(A;;GA;;;" + sid + L")(A;;GA;;;SY)";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return false;
    SECURITY_ATTRIBUTES attributes{ sizeof(attributes), descriptor, FALSE };
    g_pipeName = L"\\\\.\\pipe\\zaalis-browser-" + std::to_wstring(GetCurrentProcessId()) + L"-" + RandomHex(8);
    g_pipe = CreateNamedPipeW(g_pipeName.c_str(),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 1 << 20, 1 << 20, 0, &attributes);
    LocalFree(descriptor);
    if (g_pipe == INVALID_HANDLE_VALUE) return false;
    std::wstring token = RandomHex(32);
    g_token = ToUtf8(token);
    SetEnvironmentVariableW(L"ZAALIS_BROWSER_PIPE", g_pipeName.c_str());
    SetEnvironmentVariableW(L"ZAALIS_BROWSER_TOKEN", token.c_str());
    return true;
}

// ----- Utilitaires -------------------------------------------------------------------
static double DpiScale() { UINT d = g_hwnd ? GetDpiForWindow(g_hwnd) : 96; return d ? d / 96.0 : 1.0; }
static int Px(double dip) { return (int)std::lround(dip * DpiScale()); }

static std::wstring TakeString(LPWSTR value)
{
    std::wstring out = value ? value : L"";
    if (value) CoTaskMemFree(value);
    return out;
}

static std::wstring GetString(const JsonObject& o, const wchar_t* key)
{
    try { if (o.HasKey(key) && o.GetNamedValue(key).ValueType() == JsonValueType::String) return std::wstring(o.GetNamedString(key)); } catch (...) {}
    return L"";
}
static double GetNumber(const JsonObject& o, const wchar_t* key, double fallback = 0)
{
    try { if (o.HasKey(key) && o.GetNamedValue(key).ValueType() == JsonValueType::Number) return o.GetNamedNumber(key); } catch (...) {}
    return fallback;
}
static bool GetBool(const JsonObject& o, const wchar_t* key, bool fallback = false)
{
    try { if (o.HasKey(key) && o.GetNamedValue(key).ValueType() == JsonValueType::Boolean) return o.GetNamedBoolean(key); } catch (...) {}
    return fallback;
}

static COREWEBVIEW2_COLOR ParseColor(const std::wstring& text, COREWEBVIEW2_COLOR fallback)
{
    if (text.size() != 7 && text.size() != 9) return fallback;
    if (text[0] != L'#') return fallback;
    unsigned long v = wcstoul(text.c_str() + 1, nullptr, 16);
    COREWEBVIEW2_COLOR c;
    if (text.size() == 7) { c.A = 255; c.R = (BYTE)(v >> 16); c.G = (BYTE)(v >> 8); c.B = (BYTE)v; }
    else { c.R = (BYTE)(v >> 24); c.G = (BYTE)(v >> 16); c.B = (BYTE)(v >> 8); c.A = (BYTE)v; }
    // WebView2 n'accepte qu'un fond opaque ou totalement transparent.
    c.A = c.A < 128 ? 0 : 255;
    return c;
}

static std::wstring Base64(const BYTE* data, DWORD size)
{
    DWORD chars = 0;
    if (!CryptBinaryToStringW(data, size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &chars)) return L"";
    std::wstring out(chars, L'\0');
    CryptBinaryToStringW(data, size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, &out[0], &chars);
    out.resize(chars);
    return out;
}

static std::vector<BYTE> FromBase64(const std::wstring& text)
{
    std::vector<BYTE> out;
    DWORD size = 0;
    if (text.empty() || !CryptStringToBinaryW(text.c_str(), (DWORD)text.size(), CRYPT_STRING_BASE64, nullptr, &size, nullptr, nullptr)) return out;
    out.resize(size);
    CryptStringToBinaryW(text.c_str(), (DWORD)text.size(), CRYPT_STRING_BASE64, out.data(), &size, nullptr, nullptr);
    out.resize(size);
    return out;
}

static std::wstring KnownFolder(REFKNOWNFOLDERID id)
{
    PWSTR path = nullptr;
    std::wstring out;
    if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &path))) out = path;
    if (path) CoTaskMemFree(path);
    return out;
}

static std::wstring WebViewDataFolder()
{
    // ZAALIS_WEBVIEW_DATA_ROOT isole une version de developpement (voir main.cpp).
    wchar_t root[MAX_PATH] = {};
    std::wstring base = GetEnvironmentVariableW(L"ZAALIS_WEBVIEW_DATA_ROOT", root, MAX_PATH) ? std::wstring(root) : KnownFolder(FOLDERID_LocalAppData);
    std::wstring folder = base + L"\\zaalis\\Browser\\WebView2\\";
    SHCreateDirectoryExW(nullptr, folder.c_str(), nullptr);
    return folder;
}

static View* FindView(int id)
{
    auto it = g_views.find(id);
    return it == g_views.end() || it->second->destroyed ? nullptr : it->second.get();
}

static void PushHostState();

// ----- Mise en page ------------------------------------------------------------------
static void ApplyRegion(View* v)
{
    if (!v || !v->host) return;
    RECT rc{}; GetClientRect(v->host, &rc);
    const int width = rc.right, height = rc.bottom;
    const double scale = DpiScale();
    const int top = (int)std::lround(v->regionTop * scale);
    if (!v->region || !v->hasOverlay || height <= top + 2) { SetWindowRgn(v->host, nullptr, TRUE); return; }
    HRGN keep = CreateRectRgn(0, 0, width, top);
    int left = (int)std::lround(v->overlay.left * scale), otop = (int)std::lround(v->overlay.top * scale);
    int right = (int)std::lround(v->overlay.right * scale), bottom = (int)std::lround(v->overlay.bottom * scale);
    const int pad = (int)std::lround(scale);
    left = std::max(0, left - pad); otop = std::max(top, otop - pad);
    right = std::min(width, right + pad); bottom = std::min(height, bottom + pad);
    if (right > left && bottom > otop) {
        const int radius = (int)std::lround(16 * scale);
        HRGN popup = CreateRoundRectRgn(left, otop, right + 1, bottom + 1, radius * 2, radius * 2);
        // Le haut du menu est jointif avec la barre : coins superieurs carres.
        HRGN square = CreateRectRgn(left, otop, right + 1, otop + radius + 1);
        CombineRgn(popup, popup, square, RGN_OR);
        DeleteObject(square);
        CombineRgn(keep, keep, popup, RGN_OR);
        DeleteObject(popup);
    }
    SetWindowRgn(v->host, keep, TRUE);   // Windows possede la region
}

static void ApplyBounds(View* v)
{
    if (!v || !v->host) return;
    SetWindowPos(v->host, nullptr, Px(v->dip.left), Px(v->dip.top), Px(v->dip.right), Px(v->dip.bottom),
                 SWP_NOZORDER | SWP_NOACTIVATE);
    if (v->controller) {
        RECT rc{}; GetClientRect(v->host, &rc);
        v->controller->put_Bounds(rc);
    }
    ApplyRegion(v);
}

static void ApplyScale(View* v)
{
    ComPtr<ICoreWebView2Controller3> c3;
    if (v && v->controller && SUCCEEDED(v->controller.As(&c3))) {
        c3->put_ShouldDetectMonitorScaleChanges(FALSE);
        c3->put_BoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS);
        c3->put_RasterizationScale(DpiScale());
    }
}

static void ApplyVisibility(View* v)
{
    if (!v || !v->host) return;
    ShowWindow(v->host, v->visible ? SW_SHOWNA : SW_HIDE);
    if (v->controller) v->controller->put_IsVisible(v->visible && g_visible ? TRUE : FALSE);
}

static void EmitResize()
{
    if (!g_hwnd) return;
    RECT rc{}; GetClientRect(g_hwnd, &rc);
    const double scale = DpiScale();
    Json j; j.str(L"ev", L"resize").num(L"width", std::lround(rc.right / scale)).num(L"height", std::lround(rc.bottom / scale));
    Emit(j);
}

// ----- Evenements des vues -------------------------------------------------------------
static std::wstring ViewSource(View* v)
{
    LPWSTR source = nullptr;
    if (v && v->webview) v->webview->get_Source(&source);
    return TakeString(source);
}

static bool StartsWith(const std::wstring& s, const wchar_t* prefix) { return s.rfind(prefix, 0) == 0; }

static std::wstring KeyName(UINT vk)
{
    if ((vk >= 'A' && vk <= 'Z') || (vk >= '0' && vk <= '9')) return std::wstring(1, (wchar_t)vk);
    if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9) return std::wstring(1, (wchar_t)(L'0' + (vk - VK_NUMPAD0)));
    if (vk >= VK_F1 && vk <= VK_F24) return L"F" + std::to_wstring(vk - VK_F1 + 1);
    switch (vk) {
        case VK_LEFT: return L"Left";
        case VK_RIGHT: return L"Right";
        case VK_TAB: return L"Tab";
        case VK_OEM_PLUS: case VK_ADD: return L"=";
        case VK_OEM_MINUS: case VK_SUBTRACT: return L"-";
        default: return L"";
    }
}

static void RegisterEvents(View* v)
{
    ICoreWebView2* wv = v->webview.Get();
    const int id = v->id;
    EventRegistrationToken token;

    wv->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
        [id](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
            View* v = FindView(id);
            if (!v) return S_OK;
            LPWSTR raw = nullptr; args->get_Uri(&raw);
            std::wstring uri = TakeString(raw);
            BOOL redirected = FALSE; args->get_IsRedirected(&redirected);
            UINT64 navId = 0; args->get_NavigationId(&navId);
            // Seuls les schemas d'une page web ou du navigateur lui-meme
            // s'ouvrent ; javascript:, file:, protocoles tiers : refuses.
            const bool allowed = StartsWith(uri, L"http://") || StartsWith(uri, L"https://") ||
                StartsWith(uri, L"zaalis://") || StartsWith(uri, L"data:") || StartsWith(uri, L"about:") ||
                StartsWith(uri, L"blob:");
            if (!allowed) { args->put_Cancel(TRUE); return S_OK; }
            ComPtr<ICoreWebView2Settings> settings;
            if (SUCCEEDED(v->webview->get_Settings(&settings)))
                settings->put_IsWebMessageEnabled(StartsWith(uri, L"zaalis://") ? TRUE : FALSE);
            bool self = false;
            if (!redirected && v->selfNavigations > 0) { self = true; v->selfNavigations--; }
            Json j; j.str(L"ev", L"navStarting").num(L"view", id).str(L"url", uri).num(L"navId", (double)navId)
                .boolean(L"self", self).boolean(L"redirect", redirected != FALSE);
            Emit(j);
            return S_OK;
        }).Get(), &token);

    wv->add_ContentLoading(Callback<ICoreWebView2ContentLoadingEventHandler>(
        [id](ICoreWebView2*, ICoreWebView2ContentLoadingEventArgs* args) -> HRESULT {
            View* v = FindView(id);
            if (!v) return S_OK;
            BOOL error = FALSE; args->get_IsErrorPage(&error);
            if (error) return S_OK;
            Json j; j.str(L"ev", L"committed").num(L"view", id).str(L"url", ViewSource(v));
            Emit(j);
            return S_OK;
        }).Get(), &token);

    wv->add_SourceChanged(Callback<ICoreWebView2SourceChangedEventHandler>(
        [id](ICoreWebView2*, ICoreWebView2SourceChangedEventArgs* args) -> HRESULT {
            View* v = FindView(id);
            if (!v) return S_OK;
            BOOL fresh = FALSE; args->get_IsNewDocument(&fresh);
            Json j; j.str(L"ev", L"sourceChanged").num(L"view", id).str(L"url", ViewSource(v)).boolean(L"newDocument", fresh != FALSE);
            Emit(j);
            return S_OK;
        }).Get(), &token);

    wv->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
        [id](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
            View* v = FindView(id);
            if (!v) return S_OK;
            BOOL ok = FALSE; args->get_IsSuccess(&ok);
            COREWEBVIEW2_WEB_ERROR_STATUS status = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
            args->get_WebErrorStatus(&status);
            int http = 0;
            ComPtr<ICoreWebView2NavigationCompletedEventArgs2> args2;
            if (SUCCEEDED(args->QueryInterface(IID_PPV_ARGS(&args2)))) args2->get_HttpStatusCode(&http);
            Json j; j.str(L"ev", L"completed").num(L"view", id).boolean(L"ok", ok != FALSE)
                .num(L"status", (double)status).num(L"httpStatus", http).str(L"url", ViewSource(v));
            Emit(j);
            return S_OK;
        }).Get(), &token);

    ComPtr<ICoreWebView2_2> wv2;
    if (SUCCEEDED(v->webview.As(&wv2))) {
        wv2->add_DOMContentLoaded(Callback<ICoreWebView2DOMContentLoadedEventHandler>(
            [id](ICoreWebView2*, ICoreWebView2DOMContentLoadedEventArgs*) -> HRESULT {
                Json j; j.str(L"ev", L"domReady").num(L"view", id);
                Emit(j);
                return S_OK;
            }).Get(), &token);
    }

    wv->add_DocumentTitleChanged(Callback<ICoreWebView2DocumentTitleChangedEventHandler>(
        [id](ICoreWebView2* sender, IUnknown*) -> HRESULT {
            LPWSTR title = nullptr; sender->get_DocumentTitle(&title);
            Json j; j.str(L"ev", L"title").num(L"view", id).str(L"title", TakeString(title));
            Emit(j);
            return S_OK;
        }).Get(), &token);

    wv->add_HistoryChanged(Callback<ICoreWebView2HistoryChangedEventHandler>(
        [id](ICoreWebView2* sender, IUnknown*) -> HRESULT {
            BOOL back = FALSE, forward = FALSE;
            sender->get_CanGoBack(&back); sender->get_CanGoForward(&forward);
            Json j; j.str(L"ev", L"history").num(L"view", id).boolean(L"canBack", back != FALSE).boolean(L"canForward", forward != FALSE);
            Emit(j);
            return S_OK;
        }).Get(), &token);

    ComPtr<ICoreWebView2_8> wv8;
    if (SUCCEEDED(v->webview.As(&wv8))) {
        wv8->add_IsDocumentPlayingAudioChanged(Callback<ICoreWebView2IsDocumentPlayingAudioChangedEventHandler>(
            [id](ICoreWebView2* sender, IUnknown*) -> HRESULT {
                ComPtr<ICoreWebView2_8> s8;
                BOOL playing = FALSE;
                if (SUCCEEDED(sender->QueryInterface(IID_PPV_ARGS(&s8)))) s8->get_IsDocumentPlayingAudio(&playing);
                Json j; j.str(L"ev", L"audible").num(L"view", id).boolean(L"audible", playing != FALSE);
                Emit(j);
                return S_OK;
            }).Get(), &token);
    }

    wv->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
        [id](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
            // Jamais de fenetre separee : le navigateur ouvre un onglet s'il le souhaite.
            args->put_Handled(TRUE);
            LPWSTR uri = nullptr; args->get_Uri(&uri);
            Json j; j.str(L"ev", L"newWindow").num(L"view", id).str(L"url", TakeString(uri));
            Emit(j);
            return S_OK;
        }).Get(), &token);

    wv->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
        [id](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
            LPWSTR source = nullptr; args->get_Source(&source);
            std::wstring origin = TakeString(source);
            if (!StartsWith(origin, L"zaalis://home/")) return S_OK;   // pages internes uniquement
            LPWSTR message = nullptr;
            if (FAILED(args->TryGetWebMessageAsString(&message)) || !message) return S_OK;
            Json j; j.str(L"ev", L"webMessage").num(L"view", id).str(L"message", TakeString(message));
            Emit(j);
            return S_OK;
        }).Get(), &token);

    wv->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>(
        [id](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
            ComPtr<ICoreWebView2Deferral> deferral;
            if (FAILED(args->GetDeferral(&deferral))) return S_OK;
            const int req = g_nextRequest++;
            g_permissions[req] = { args, deferral };
            LPWSTR uri = nullptr; args->get_Uri(&uri);
            COREWEBVIEW2_PERMISSION_KIND kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
            args->get_PermissionKind(&kind);
            Json j; j.str(L"ev", L"permission").num(L"req", req).num(L"view", id).str(L"uri", TakeString(uri)).num(L"kind", (double)kind);
            Emit(j);
            return S_OK;
        }).Get(), &token);

    wv->AddWebResourceRequestedFilter(L"zaalis://*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    wv->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>(
        [id](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
            ComPtr<ICoreWebView2WebResourceRequest> request;
            if (FAILED(args->get_Request(&request))) return S_OK;
            LPWSTR uri = nullptr; request->get_Uri(&uri);
            std::wstring url = TakeString(uri);
            if (!StartsWith(url, L"zaalis://")) return S_OK;
            ComPtr<ICoreWebView2Deferral> deferral;
            if (FAILED(args->GetDeferral(&deferral))) return S_OK;
            const int req = g_nextRequest++;
            g_resources[req] = { args, deferral };
            LPWSTR method = nullptr; request->get_Method(&method);
            Json j; j.str(L"ev", L"resource").num(L"req", req).num(L"view", id).str(L"url", url).str(L"method", TakeString(method));
            Emit(j);
            return S_OK;
        }).Get(), &token);

    ComPtr<ICoreWebView2_4> wv4;
    if (SUCCEEDED(v->webview.As(&wv4))) {
        wv4->add_DownloadStarting(Callback<ICoreWebView2DownloadStartingEventHandler>(
            [id](ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* args) -> HRESULT {
                PendingDownload pending;
                pending.args = args;
                if (FAILED(args->GetDeferral(&pending.deferral))) return S_OK;
                args->get_DownloadOperation(&pending.operation);
                const int req = g_nextRequest++;
                LPWSTR path = nullptr; args->get_ResultFilePath(&path);
                LPWSTR uri = nullptr, mime = nullptr;
                INT64 total = 0;
                if (pending.operation) {
                    pending.operation->get_Uri(&uri);
                    pending.operation->get_MimeType(&mime);
                    pending.operation->get_TotalBytesToReceive(&total);
                }
                g_downloads[req] = pending;
                Json j; j.str(L"ev", L"downloadStarting").num(L"req", req).num(L"view", id)
                    .str(L"url", TakeString(uri)).str(L"path", TakeString(path)).str(L"mime", TakeString(mime)).num(L"total", (double)total);
                Emit(j);
                return S_OK;
            }).Get(), &token);
    }

    ComPtr<ICoreWebView2_11> wv11;
    if (SUCCEEDED(v->webview.As(&wv11))) {
        wv11->add_ContextMenuRequested(Callback<ICoreWebView2ContextMenuRequestedEventHandler>(
            [id](ICoreWebView2*, ICoreWebView2ContextMenuRequestedEventArgs* args) -> HRESULT {
                // Le menu est celui de zaalis Browser (construit cote serveur).
                args->put_Handled(TRUE);
                POINT at{}; args->get_Location(&at);
                ComPtr<ICoreWebView2ContextMenuTarget> target;
                std::wstring link, selection;
                BOOL editable = FALSE;
                if (SUCCEEDED(args->get_ContextMenuTarget(&target)) && target) {
                    BOOL has = FALSE;
                    if (SUCCEEDED(target->get_HasLinkUri(&has)) && has) { LPWSTR s = nullptr; target->get_LinkUri(&s); link = TakeString(s); }
                    if (SUCCEEDED(target->get_HasSelection(&has)) && has) { LPWSTR s = nullptr; target->get_SelectionText(&s); selection = TakeString(s); }
                    target->get_IsEditable(&editable);
                }
                const double scale = DpiScale();
                Json j; j.str(L"ev", L"contextMenu").num(L"view", id).num(L"x", std::lround(at.x / scale)).num(L"y", std::lround(at.y / scale))
                    .str(L"link", link).str(L"selection", selection).boolean(L"editable", editable != FALSE);
                Emit(j);
                return S_OK;
            }).Get(), &token);
    }

    wv->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>(
        [id](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*) -> HRESULT {
            Json j; j.str(L"ev", L"crashed").num(L"view", id);
            Emit(j);
            return S_OK;
        }).Get(), &token);

    // Console de la page, pour l'outil read_console de l'assistant.
    if (v->kind == L"tab") {
        ComPtr<ICoreWebView2DevToolsProtocolEventReceiver> receiver;
        if (SUCCEEDED(wv->GetDevToolsProtocolEventReceiver(L"Runtime.consoleAPICalled", &receiver))) {
            receiver->add_DevToolsProtocolEventReceived(Callback<ICoreWebView2DevToolsProtocolEventReceivedEventHandler>(
                [id](ICoreWebView2*, ICoreWebView2DevToolsProtocolEventReceivedEventArgs* args) -> HRESULT {
                    LPWSTR json = nullptr; args->get_ParameterObjectAsJson(&json);
                    std::wstring raw = TakeString(json);
                    if (raw.size() > 64 * 1024) return S_OK;
                    Json j; j.str(L"ev", L"console").num(L"view", id).raw(L"raw", raw);
                    Emit(j);
                    return S_OK;
                }).Get(), &token);
            wv->CallDevToolsProtocolMethod(L"Runtime.enable", L"{}",
                Callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler>(
                    [](HRESULT, LPCWSTR) -> HRESULT { return S_OK; }).Get());
        }
    }

    v->controller->add_AcceleratorKeyPressed(Callback<ICoreWebView2AcceleratorKeyPressedEventHandler>(
        [](ICoreWebView2Controller*, ICoreWebView2AcceleratorKeyPressedEventArgs* args) -> HRESULT {
            COREWEBVIEW2_KEY_EVENT_KIND kind; args->get_KeyEventKind(&kind);
            if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) return S_OK;
            UINT vk = 0; args->get_VirtualKey(&vk);
            const bool ctrl = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
            const bool shift = (GetKeyState(VK_SHIFT) & 0x8000) != 0;
            const bool alt = (GetKeyState(VK_MENU) & 0x8000) != 0;
            std::wstring key = KeyName(vk);
            if (key.empty()) return S_OK;
            for (const auto& a : g_accelerators) {
                if (a.ctrl == ctrl && a.shift == shift && a.alt == alt && a.key == key) {
                    args->put_Handled(TRUE);
                    Json j; j.str(L"ev", L"accelerator").boolean(L"ctrl", ctrl).boolean(L"shift", shift).boolean(L"alt", alt).str(L"key", key);
                    Emit(j);
                    break;
                }
            }
            return S_OK;
        }).Get(), &token);
}

static void RunOp(const JsonObject& message, const std::wstring& raw);

static void ControllerReady(View* v)
{
    ApplyScale(v);
    ComPtr<ICoreWebView2Controller2> c2;
    if (SUCCEEDED(v->controller.As(&c2))) c2->put_DefaultBackgroundColor(v->background);
    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(v->webview->get_Settings(&settings))) {
        settings->put_AreDefaultContextMenusEnabled(TRUE);
        settings->put_AreDevToolsEnabled(TRUE);
        settings->put_IsStatusBarEnabled(v->kind == L"tab" ? TRUE : FALSE);
        settings->put_IsZoomControlEnabled(v->kind == L"tab" ? TRUE : FALSE);
        settings->put_IsWebMessageEnabled(v->kind == L"tab" ? FALSE : TRUE);
        ComPtr<ICoreWebView2Settings3> s3;
        if (SUCCEEDED(settings.As(&s3))) s3->put_AreBrowserAcceleratorKeysEnabled(TRUE);
    }
    v->webview->AddScriptToExecuteOnDocumentCreated(kBridgeScript, nullptr);
    RegisterEvents(v);
    v->controller->put_ZoomFactor(v->zoom);
    v->ready = true;
    ApplyBounds(v);
    ApplyVisibility(v);
    std::vector<std::wstring> pending;
    pending.swap(v->pending);
    for (const auto& raw : pending) {
        try { RunOp(JsonObject::Parse(raw), raw); } catch (...) {}
    }
    PushHostState();
}

static void CreateController(View* v)
{
    ComPtr<ICoreWebView2Environment10> env10;
    const int id = v->id;
    auto completed = Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
        [id](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
            auto it = g_views.find(id);
            if (it == g_views.end() || it->second->destroyed || g_closing) { if (controller) controller->Close(); return S_OK; }
            View* v = it->second.get();
            if (FAILED(result) || !controller) {
                Json j; j.str(L"ev", L"crashed").num(L"view", id);
                Emit(j);
                return S_OK;
            }
            v->controller = controller;
            controller->get_CoreWebView2(&v->webview);
            ControllerReady(v);
            return S_OK;
        });
    if (SUCCEEDED(g_env.As(&env10))) {
        ComPtr<ICoreWebView2ControllerOptions> options;
        if (SUCCEEDED(env10->CreateCoreWebView2ControllerOptions(&options)) && options) {
            options->put_ProfileName(v->profile.c_str());
            options->put_IsInPrivateModeEnabled(v->inPrivate ? TRUE : FALSE);
            env10->CreateCoreWebView2ControllerWithOptions(v->host, options.Get(), completed.Get());
            return;
        }
    }
    g_env->CreateCoreWebView2Controller(v->host, completed.Get());
}

static void EnsureEnvironment()
{
    if (g_env || g_envStarting) return;
    g_envStarting = true;
    auto options = Make<CoreWebView2EnvironmentOptions>();
    options->put_AdditionalBrowserArguments(L"--autoplay-policy=no-user-gesture-required --enable-gpu-rasterization");
    auto scheme = Make<CoreWebView2CustomSchemeRegistration>(L"zaalis");
    scheme->put_TreatAsSecure(TRUE);
    scheme->put_HasAuthorityComponent(TRUE);
    ICoreWebView2CustomSchemeRegistration* registrations[1] = { scheme.Get() };
    ComPtr<ICoreWebView2EnvironmentOptions4> options4;
    if (SUCCEEDED(options.As(&options4))) options4->SetCustomSchemeRegistrations(1, registrations);
    std::wstring folder = WebViewDataFolder();
    CreateCoreWebView2EnvironmentWithOptions(nullptr, folder.c_str(), options.Get(),
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                g_envStarting = false;
                if (g_closing) return S_OK;
                if (FAILED(result) || !env) { PushHostState(); return S_OK; }
                g_env = env;
                for (auto& entry : g_views) if (!entry.second->destroyed && !entry.second->controller) CreateController(entry.second.get());
                return S_OK;
            }).Get());
}

// ----- Fenetres ----------------------------------------------------------------------------
static LRESULT CALLBACK ViewWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
        case WM_ERASEBKGND: {
            RECT rc; GetClientRect(hwnd, &rc);
            if (g_panelBrush) FillRect(reinterpret_cast<HDC>(wParam), &rc, g_panelBrush);
            return 1;
        }
        case WM_SIZE: {
            for (auto& entry : g_views) {
                View* v = entry.second.get();
                if (v->host == hwnd && v->controller) { RECT rc; GetClientRect(hwnd, &rc); v->controller->put_Bounds(rc); }
            }
            return 0;
        }
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static void SetPanelColor(COREWEBVIEW2_COLOR color)
{
    g_panelColor = color;
    if (g_panelBrush) DeleteObject(g_panelBrush);
    g_panelBrush = CreateSolidBrush(RGB(color.R, color.G, color.B));
    if (g_hwnd) InvalidateRect(g_hwnd, nullptr, TRUE);
}

// ----- Operations natives (dialogues, fichiers, images) -----------------------------------------
static int ShowMessage(const JsonObject& o)
{
    std::wstring title = GetString(o, L"title"), message = GetString(o, L"message"), detail = GetString(o, L"detail");
    std::vector<std::wstring> labels;
    try { for (auto const& value : o.GetNamedArray(L"buttons")) labels.push_back(std::wstring(value.GetString())); } catch (...) {}
    if (labels.empty()) labels.push_back(L"OK");
    const int defaultId = (int)GetNumber(o, L"defaultId", 0), cancelId = (int)GetNumber(o, L"cancelId", 0);
    std::vector<TASKDIALOG_BUTTON> buttons;
    for (size_t i = 0; i < labels.size(); ++i) buttons.push_back({ (int)(100 + i), labels[i].c_str() });
    TASKDIALOGCONFIG config{ sizeof(config) };
    config.hwndParent = GetAncestor(g_hwnd, GA_ROOT);
    config.dwFlags = TDF_POSITION_RELATIVE_TO_WINDOW | TDF_ALLOW_DIALOG_CANCELLATION;
    config.pszWindowTitle = title.empty() ? L"zaalis browser" : title.c_str();
    config.pszMainInstruction = message.c_str();
    config.pszContent = detail.empty() ? nullptr : detail.c_str();
    config.cButtons = (UINT)buttons.size();
    config.pButtons = buttons.data();
    config.nDefaultButton = 100 + std::clamp(defaultId, 0, (int)buttons.size() - 1);
    std::wstring type = GetString(o, L"type");
    config.pszMainIcon = type == L"warning" || type == L"question" ? TD_WARNING_ICON : type == L"error" ? TD_ERROR_ICON : TD_INFORMATION_ICON;
    int pressed = 0;
    if (FAILED(TaskDialogIndirect(&config, &pressed, nullptr, nullptr))) return cancelId;
    if (pressed == IDCANCEL) return cancelId;
    const int index = pressed - 100;
    return index >= 0 && index < (int)labels.size() ? index : cancelId;
}

static std::wstring PickFile(const JsonObject& o)
{
    ComPtr<IFileOpenDialog> dialog;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) return L"";
    std::wstring title = GetString(o, L"title");
    if (!title.empty()) dialog->SetTitle(title.c_str());
    std::vector<std::wstring> names, specs;
    try {
        for (auto const& value : o.GetNamedArray(L"filters")) {
            JsonObject filter = value.GetObject();
            std::wstring spec;
            for (auto const& ext : filter.GetNamedArray(L"extensions")) { if (!spec.empty()) spec += L";"; spec += L"*." + std::wstring(ext.GetString()); }
            names.push_back(std::wstring(filter.GetNamedString(L"name", L"")));
            specs.push_back(spec);
        }
    } catch (...) {}
    std::vector<COMDLG_FILTERSPEC> filters;
    for (size_t i = 0; i < names.size(); ++i) filters.push_back({ names[i].c_str(), specs[i].c_str() });
    if (!filters.empty()) dialog->SetFileTypes((UINT)filters.size(), filters.data());
    if (FAILED(dialog->Show(GetAncestor(g_hwnd, GA_ROOT)))) return L"";
    ComPtr<IShellItem> item;
    if (FAILED(dialog->GetResult(&item))) return L"";
    PWSTR path = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) return L"";
    return TakeString(path);
}

static ComPtr<IWICImagingFactory> Wic()
{
    ComPtr<IWICImagingFactory> factory;
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
    return factory;
}

static bool EncodePng(IWICImagingFactory* factory, IWICBitmapSource* source, IStream* stream)
{
    ComPtr<IWICBitmapEncoder> encoder;
    ComPtr<IWICBitmapFrameEncode> frame;
    if (FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder))) return false;
    if (FAILED(encoder->Initialize(stream, WICBitmapEncoderNoCache))) return false;
    if (FAILED(encoder->CreateNewFrame(&frame, nullptr)) || FAILED(frame->Initialize(nullptr))) return false;
    UINT w = 0, h = 0; source->GetSize(&w, &h);
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    frame->SetSize(w, h);
    frame->SetPixelFormat(&format);
    ComPtr<IWICFormatConverter> converter;
    factory->CreateFormatConverter(&converter);
    if (FAILED(converter->Initialize(source, GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom))) return false;
    if (FAILED(frame->WriteSource(converter.Get(), nullptr))) return false;
    return SUCCEEDED(frame->Commit()) && SUCCEEDED(encoder->Commit());
}

// Photo de profil : recadrage carre centre puis mise a l'echelle, en PNG.
static bool SquareImage(const std::wstring& source, const std::wstring& target, UINT size)
{
    auto factory = Wic();
    if (!factory) return false;
    ComPtr<IWICBitmapDecoder> decoder;
    ComPtr<IWICBitmapFrameDecode> frame;
    if (FAILED(factory->CreateDecoderFromFilename(source.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand, &decoder))) return false;
    if (FAILED(decoder->GetFrame(0, &frame))) return false;
    UINT w = 0, h = 0; frame->GetSize(&w, &h);
    const UINT side = std::min(w, h);
    if (!side) return false;
    WICRect crop{ (INT)((w - side) / 2), (INT)((h - side) / 2), (INT)side, (INT)side };
    ComPtr<IWICBitmapClipper> clipper;
    ComPtr<IWICBitmapScaler> scaler;
    if (FAILED(factory->CreateBitmapClipper(&clipper)) || FAILED(clipper->Initialize(frame.Get(), &crop))) return false;
    if (FAILED(factory->CreateBitmapScaler(&scaler)) || FAILED(scaler->Initialize(clipper.Get(), size, size, WICBitmapInterpolationModeFant))) return false;
    ComPtr<IStream> stream;
    if (FAILED(SHCreateStreamOnFileEx(target.c_str(), STGM_CREATE | STGM_WRITE, FILE_ATTRIBUTE_NORMAL, TRUE, nullptr, &stream))) return false;
    return EncodePng(factory.Get(), scaler.Get(), stream.Get());
}

// Icone systeme d'un fichier telecharge, en data URL PNG.
static std::wstring FileIconDataUrl(const std::wstring& path)
{
    SHFILEINFOW info{};
    if (!SHGetFileInfoW(path.c_str(), 0, &info, sizeof(info), SHGFI_ICON | SHGFI_LARGEICON) || !info.hIcon) return L"";
    std::wstring out;
    auto factory = Wic();
    ComPtr<IWICBitmap> bitmap;
    if (factory && SUCCEEDED(factory->CreateBitmapFromHICON(info.hIcon, &bitmap))) {
        ComPtr<IStream> stream = SHCreateMemStream(nullptr, 0);
        if (stream && EncodePng(factory.Get(), bitmap.Get(), stream.Get())) {
            STATSTG stat{}; stream->Stat(&stat, STATFLAG_NONAME);
            std::vector<BYTE> bytes((size_t)stat.cbSize.QuadPart);
            LARGE_INTEGER zero{}; stream->Seek(zero, STREAM_SEEK_SET, nullptr);
            ULONG read = 0; stream->Read(bytes.data(), (ULONG)bytes.size(), &read);
            out = L"data:image/png;base64," + Base64(bytes.data(), read);
        }
    }
    DestroyIcon(info.hIcon);
    return out;
}

static int ShowMenu(const JsonObject& o)
{
    HMENU menu = CreatePopupMenu();
    int index = 0;
    try {
        for (auto const& value : o.GetNamedArray(L"items")) {
            JsonObject item = value.GetObject();
            if (GetBool(item, L"separator")) AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
            else AppendMenuW(menu, MF_STRING | (GetBool(item, L"enabled", true) ? 0 : MF_GRAYED), 1000 + index, GetString(item, L"label").c_str());
            ++index;
        }
    } catch (...) {}
    POINT at; GetCursorPos(&at);
    HWND owner = GetAncestor(g_hwnd, GA_ROOT);
    SetForegroundWindow(owner);
    int chosen = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, at.x, at.y, owner, nullptr);
    DestroyMenu(menu);
    return chosen >= 1000 ? chosen - 1000 : -1;
}

static void SetClipboardText(const std::wstring& text)
{
    if (!OpenClipboard(g_hwnd)) return;
    EmptyClipboard();
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, (text.size() + 1) * sizeof(wchar_t));
    if (memory) {
        memcpy(GlobalLock(memory), text.c_str(), (text.size() + 1) * sizeof(wchar_t));
        GlobalUnlock(memory);
        if (!SetClipboardData(CF_UNICODETEXT, memory)) GlobalFree(memory);
    }
    CloseClipboard();
}

static void RunShell(const JsonObject& o)
{
    std::wstring action = GetString(o, L"action"), path = GetString(o, L"path");
    if (path.empty()) return;
    if (action == L"showItemInFolder") {
        PIDLIST_ABSOLUTE pidl = ILCreateFromPathW(path.c_str());
        if (pidl) { SHOpenFolderAndSelectItems(pidl, 0, nullptr, 0); ILFree(pidl); }
    } else if (action == L"openPath") {
        if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES)
            ShellExecuteW(nullptr, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    } else if (action == L"openExternal") {
        if (StartsWith(path, L"http://") || StartsWith(path, L"https://"))
            ShellExecuteW(nullptr, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    }
}

static std::wstring CookieList(ICoreWebView2CookieList* list)
{
    std::wstring json = L"[";
    UINT count = 0;
    if (list) list->get_Count(&count);
    for (UINT i = 0; i < count; ++i) {
        ComPtr<ICoreWebView2Cookie> cookie;
        if (FAILED(list->GetValueAtIndex(i, &cookie))) continue;
        LPWSTR name = nullptr, domain = nullptr, path = nullptr;
        cookie->get_Name(&name); cookie->get_Domain(&domain); cookie->get_Path(&path);
        BOOL secure = FALSE, httpOnly = FALSE, session = FALSE;
        cookie->get_IsSecure(&secure); cookie->get_IsHttpOnly(&httpOnly); cookie->get_IsSession(&session);
        COREWEBVIEW2_COOKIE_SAME_SITE_KIND same = COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX;
        cookie->get_SameSite(&same);
        Json j; j.str(L"name", TakeString(name)).str(L"domain", TakeString(domain)).str(L"path", TakeString(path))
            .boolean(L"secure", secure != FALSE).boolean(L"httpOnly", httpOnly != FALSE).boolean(L"session", session != FALSE)
            .str(L"sameSite", same == COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT ? L"strict" : same == COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE ? L"no_restriction" : L"lax");
        if (json.size() > 1) json += L",";
        json += j.done();
    }
    return json + L"]";
}

// ----- Execution des operations ----------------------------------------------------------------
static void CreateView(const JsonObject& o)
{
    const int id = (int)GetNumber(o, L"view");
    if (id <= 0 || g_views.count(id) || !g_hwnd) return;
    auto v = std::make_unique<View>();
    v->id = id;
    v->kind = GetString(o, L"kind");
    v->profile = GetString(o, L"profile");
    if (v->profile.empty()) v->profile = L"zaalis-ui";
    v->inPrivate = GetBool(o, L"inPrivate");
    v->background = v->kind == L"tab" ? g_panelColor : COREWEBVIEW2_COLOR{ 0, 0, 0, 0 };
    v->host = CreateWindowExW(0, kViewClass, L"", WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_VISIBLE,
        0, 0, 0, 0, g_hwnd, nullptr, GetModuleHandleW(nullptr), nullptr);
    View* raw = v.get();
    g_views[id] = std::move(v);
    if (g_env) CreateController(raw); else EnsureEnvironment();
}

static void DestroyView(int id)
{
    auto it = g_views.find(id);
    if (it == g_views.end()) return;
    View* v = it->second.get();
    v->destroyed = true;
    if (v->controller) v->controller->Close();
    if (v->host) DestroyWindow(v->host);
    g_views.erase(it);
}

static void RunViewOp(View* v, const std::wstring& op, const JsonObject& o, int id)
{
    if (op == L"navigate") {
        std::wstring url = GetString(o, L"url");
        if (url.empty() || url.size() > 2 * 1024 * 1024) return;
        // chrome.webview n'existe que pour les pages du navigateur : un site
        // externe ne doit meme pas pouvoir detecter l'API.
        ComPtr<ICoreWebView2Settings> settings;
        if (SUCCEEDED(v->webview->get_Settings(&settings)))
            settings->put_IsWebMessageEnabled(StartsWith(url, L"zaalis://") ? TRUE : FALSE);
        v->selfNavigations++;
        if (FAILED(v->webview->Navigate(url.c_str()))) v->selfNavigations--;
    } else if (op == L"goBack") v->webview->GoBack();
    else if (op == L"goForward") v->webview->GoForward();
    else if (op == L"reload") v->webview->Reload();
    else if (op == L"stop") v->webview->Stop();
    else if (op == L"focus") v->controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    else if (op == L"post") {
        // Les messages d'etat ne partent que vers les pages internes : un onglet
        // qui vient de quitter l'accueil ne les recoit plus.
        if (v->kind == L"tab" && !StartsWith(ViewSource(v), L"zaalis://")) return;
        v->webview->PostWebMessageAsJson(GetString(o, L"json").c_str());
    } else if (op == L"setZoom") {
        v->zoom = std::clamp(GetNumber(o, L"factor", 1.0), 0.25, 5.0);
        v->controller->put_ZoomFactor(v->zoom);
    } else if (op == L"setMuted") {
        ComPtr<ICoreWebView2_8> wv8;
        if (SUCCEEDED(v->webview.As(&wv8))) wv8->put_IsMuted(GetBool(o, L"muted") ? TRUE : FALSE);
    } else if (op == L"openDevTools") v->webview->OpenDevToolsWindow();
    else if (op == L"cdp") {
        std::wstring method = GetString(o, L"method");
        std::wstring params = L"{}";
        try { if (o.HasKey(L"params")) params = std::wstring(o.GetNamedValue(L"params").Stringify()); } catch (...) {}
        v->webview->CallDevToolsProtocolMethod(method.c_str(), params.c_str(),
            Callback<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler>(
                [id](HRESULT result, LPCWSTR json) -> HRESULT {
                    std::wstring text = json ? json : L"";
                    if (FAILED(result)) ReplyError(id, text.empty() ? L"Echec DevTools" : text);
                    else Reply(id, text.empty() ? L"{}" : text);
                    return S_OK;
                }).Get());
        return;
    } else if (op == L"cookies") {
        ComPtr<ICoreWebView2_2> wv2;
        ComPtr<ICoreWebView2CookieManager> manager;
        if (FAILED(v->webview.As(&wv2)) || FAILED(wv2->get_CookieManager(&manager))) { Reply(id, L"{\"cookies\":[]}"); return; }
        manager->GetCookies(GetString(o, L"url").c_str(), Callback<ICoreWebView2GetCookiesCompletedHandler>(
            [id](HRESULT, ICoreWebView2CookieList* list) -> HRESULT {
                Reply(id, L"{\"cookies\":" + CookieList(list) + L"}");
                return S_OK;
            }).Get());
        return;
    }
    if (id > 0) Reply(id, L"{}");
}

static void RunOp(const JsonObject& o, const std::wstring& raw)
{
    std::wstring op = GetString(o, L"op");
    const int id = (int)GetNumber(o, L"id", 0);
    const int viewId = (int)GetNumber(o, L"view", 0);

    if (op == L"createView") { CreateView(o); return; }
    if (op == L"destroyView") { DestroyView(viewId); return; }

    if (viewId > 0) {
        auto it = g_views.find(viewId);
        if (it == g_views.end() || it->second->destroyed) { ReplyError(id, L"vue inconnue"); return; }
        View* v = it->second.get();
        if (op == L"setBounds") {
            v->dip = { (LONG)GetNumber(o, L"x"), (LONG)GetNumber(o, L"y"), (LONG)GetNumber(o, L"width"), (LONG)GetNumber(o, L"height") };
            ApplyBounds(v);
            return;
        }
        if (op == L"setVisible") { v->visible = GetBool(o, L"visible", true); ApplyVisibility(v); return; }
        if (op == L"raise") { if (v->host) SetWindowPos(v->host, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); return; }
        if (op == L"setBackground") {
            v->background = ParseColor(GetString(o, L"color"), v->background);
            ComPtr<ICoreWebView2Controller2> c2;
            if (v->controller && SUCCEEDED(v->controller.As(&c2))) c2->put_DefaultBackgroundColor(v->background);
            return;
        }
        if (op == L"chromeRegion") {
            v->regionTop = (int)GetNumber(o, L"top");
            v->hasOverlay = false;
            try {
                if (o.HasKey(L"overlay") && o.GetNamedValue(L"overlay").ValueType() == JsonValueType::Object) {
                    JsonObject r = o.GetNamedObject(L"overlay");
                    v->overlay = { (LONG)GetNumber(r, L"left"), (LONG)GetNumber(r, L"top"), (LONG)GetNumber(r, L"right"), (LONG)GetNumber(r, L"bottom") };
                    v->hasOverlay = true;
                }
            } catch (...) {}
            v->region = true;
            ApplyRegion(v);
            return;
        }
        if (!v->ready) { if (v->pending.size() < 512) v->pending.push_back(raw); return; }
        RunViewOp(v, op, o, id);
        return;
    }

    if (op == L"permissionReply") {
        auto it = g_permissions.find((int)GetNumber(o, L"req"));
        if (it == g_permissions.end()) return;
        it->second.first->put_State(GetBool(o, L"allow") ? COREWEBVIEW2_PERMISSION_STATE_ALLOW : COREWEBVIEW2_PERMISSION_STATE_DENY);
        it->second.second->Complete();
        g_permissions.erase(it);
    } else if (op == L"resourceReply") {
        auto it = g_resources.find((int)GetNumber(o, L"req"));
        if (it == g_resources.end()) return;
        std::vector<BYTE> body = FromBase64(GetString(o, L"body"));
        std::wstring headers;
        try {
            JsonObject h = o.GetNamedObject(L"headers");
            for (auto const& entry : h) headers += std::wstring(entry.Key()) + L": " + std::wstring(entry.Value().GetString()) + L"\r\n";
        } catch (...) {}
        ComPtr<IStream> stream = SHCreateMemStream(body.empty() ? nullptr : body.data(), (UINT)body.size());
        ComPtr<ICoreWebView2WebResourceResponse> response;
        const int status = (int)GetNumber(o, L"status", 200);
        if (g_env && SUCCEEDED(g_env->CreateWebResourceResponse(stream.Get(), status, status == 200 ? L"OK" : L"Error", headers.c_str(), &response)))
            it->second.first->put_Response(response.Get());
        it->second.second->Complete();
        g_resources.erase(it);
    } else if (op == L"downloadReply") {
        const int req = (int)GetNumber(o, L"req");
        auto it = g_downloads.find(req);
        if (it == g_downloads.end()) return;
        std::wstring path = GetString(o, L"path");
        if (!path.empty()) it->second.args->put_ResultFilePath(path.c_str());
        it->second.args->put_Handled(TRUE);   // pas de volet de telechargement natif
        ComPtr<ICoreWebView2DownloadOperation> operation = it->second.operation;
        it->second.deferral->Complete();
        it->second.args = nullptr;
        it->second.deferral = nullptr;
        if (!operation) return;
        auto report = [req](ICoreWebView2DownloadOperation* d) {
            INT64 received = 0, total = 0;
            d->get_BytesReceived(&received); d->get_TotalBytesToReceive(&total);
            COREWEBVIEW2_DOWNLOAD_STATE state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
            d->get_State(&state);
            std::wstring name = L"progressing";
            if (state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED) name = L"completed";
            else if (state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED) {
                COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NONE;
                d->get_InterruptReason(&reason);
                name = reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED ? L"cancelled" : L"interrupted";
            }
            Json j; j.str(L"ev", L"download").num(L"req", req).str(L"state", name).num(L"received", (double)received).num(L"total", (double)total);
            Emit(j);
            if (name != L"progressing") g_downloads.erase(req);
        };
        EventRegistrationToken token;
        operation->add_BytesReceivedChanged(Callback<ICoreWebView2BytesReceivedChangedEventHandler>(
            [report](ICoreWebView2DownloadOperation* d, IUnknown*) -> HRESULT { report(d); return S_OK; }).Get(), &token);
        operation->add_StateChanged(Callback<ICoreWebView2StateChangedEventHandler>(
            [report](ICoreWebView2DownloadOperation* d, IUnknown*) -> HRESULT { report(d); return S_OK; }).Get(), &token);
    } else if (op == L"downloadCancel") {
        auto it = g_downloads.find((int)GetNumber(o, L"req"));
        if (it != g_downloads.end() && it->second.operation) it->second.operation->Cancel();
    } else if (op == L"accelerators") {
        g_accelerators.clear();
        try {
            for (auto const& value : o.GetNamedArray(L"keys")) {
                JsonObject k = value.GetObject();
                g_accelerators.push_back({ GetBool(k, L"ctrl"), GetBool(k, L"shift"), GetBool(k, L"alt"), GetString(k, L"key") });
            }
        } catch (...) {}
    } else if (op == L"setPanelBackground") {
        SetPanelColor(ParseColor(GetString(o, L"color"), g_panelColor));
    } else if (op == L"reveal") {
        if (g_stateCallback) g_stateCallback(L"{\"type\":\"browserReveal\"}");
    } else if (op == L"ideState") {
        try { g_lastTabs = std::wstring(o.GetNamedArray(L"tabs").Stringify()); } catch (...) {}
        PushHostState();
    } else if (op == L"menu") {
        const int chosen = ShowMenu(o);
        Reply(id, L"{\"index\":" + std::to_wstring(chosen) + L"}");
    } else if (op == L"messageBox") {
        const int response = ShowMessage(o);
        Reply(id, L"{\"response\":" + std::to_wstring(response) + L"}");
    } else if (op == L"openFile") {
        std::wstring path = PickFile(o);
        Json j; if (!path.empty()) j.str(L"path", path);
        Reply(id, j.done());
    } else if (op == L"squareImage") {
        if (SquareImage(GetString(o, L"source"), GetString(o, L"target"), (UINT)std::clamp(GetNumber(o, L"size", 256), 16.0, 1024.0))) Reply(id, L"{}");
        else ReplyError(id, L"image illisible");
    } else if (op == L"fileIcon") {
        Json j; j.str(L"dataUrl", FileIconDataUrl(GetString(o, L"path")));
        Reply(id, j.done());
    } else if (op == L"shell") {
        RunShell(o);
    } else if (op == L"clipboard") {
        SetClipboardText(GetString(o, L"text"));
    } else if (id > 0) {
        ReplyError(id, L"operation inconnue");
    }
}

static void HandleLine(const std::string& line)
{
    if (line == "\x01disconnected") {
        g_authenticated = false;
        PushHostState();
        return;
    }
    JsonObject message;
    try { message = JsonObject::Parse(FromUtf8(line)); } catch (...) { return; }
    if (!g_authenticated) {
        // Premier message obligatoire : le jeton a usage unique.
        if (GetString(message, L"op") != L"hello" || ToUtf8(GetString(message, L"token")) != g_token || g_token.empty()) return;
        g_authenticated = true;
        RECT rc{}; if (g_hwnd) GetClientRect(g_hwnd, &rc);
        const double scale = DpiScale();
        Json folders;
        folders.str(L"downloads", KnownFolder(FOLDERID_Downloads)).str(L"desktop", KnownFolder(FOLDERID_Desktop))
            .str(L"appData", KnownFolder(FOLDERID_RoamingAppData));
        Json j; j.str(L"ev", L"welcome").raw(L"folders", folders.done())
            .num(L"width", std::lround(rc.right / scale)).num(L"height", std::lround(rc.bottom / scale)).boolean(L"visible", g_visible);
        Emit(j);
        if (g_visible) { Json p; p.str(L"ev", L"panel").boolean(L"visible", true); Emit(p); }
        PushHostState();
        return;
    }
    std::wstring raw = FromUtf8(line);
    try { RunOp(message, raw); } catch (...) {}
}

// ----- Panneau (enfant de la fenetre de l'IDE) ------------------------------------------------------
static LRESULT CALLBACK PanelWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
        case WM_ZB_LINE: {
            std::unique_ptr<std::string> line(reinterpret_cast<std::string*>(lParam));
            if (!g_closing) HandleLine(*line);
            return 0;
        }
        case WM_ERASEBKGND: {
            RECT rc; GetClientRect(hwnd, &rc);
            if (g_panelBrush) FillRect(reinterpret_cast<HDC>(wParam), &rc, g_panelBrush);
            return 1;
        }
        case WM_SIZE:
            EmitResize();
            return 0;
        case WM_DESTROY:
            g_closing = true;
            for (auto& entry : g_views) { if (entry.second->controller) entry.second->controller->Close(); }
            g_views.clear();
            g_hwnd = nullptr;
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static void PushHostState()
{
    if (!g_stateCallback || g_closing) return;
    bool ready = false;
    for (auto& entry : g_views) if (entry.second->ready && entry.second->kind == L"tab") { ready = true; break; }
    Json j;
    j.str(L"type", L"browserState").boolean(L"available", true).str(L"engine", L"zaalis-browser")
        .boolean(L"connected", g_authenticated).boolean(L"visible", g_visible).boolean(L"ready", ready)
        .raw(L"tabs", g_lastTabs).str(L"error", L"");
    g_stateCallback(j.done());
}

bool Initialize(HWND parent, StateCallback stateCallback)
{
    if (g_hwnd) return true;
    g_closing = false;
    g_stateCallback = std::move(stateCallback);
    SetPanelColor(g_panelColor);
    HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSW panel{};
    panel.lpfnWndProc = PanelWndProc;
    panel.hInstance = instance;
    panel.hCursor = LoadCursor(nullptr, IDC_ARROW);
    panel.lpszClassName = kPanelClass;
    RegisterClassW(&panel);
    WNDCLASSW view{};
    view.lpfnWndProc = ViewWndProc;
    view.hInstance = instance;
    view.hCursor = LoadCursor(nullptr, IDC_ARROW);
    view.lpszClassName = kViewClass;
    RegisterClassW(&view);
    g_hwnd = CreateWindowExW(0, kPanelClass, L"zaalis browser", WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
        0, 0, 0, 0, parent, nullptr, instance, nullptr);
    if (!g_hwnd) return false;
    if (g_pipe != INVALID_HANDLE_VALUE && !g_reader.joinable()) {
        g_stopping = false;
        g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        g_writer = std::thread(WriterLoop);
        g_reader = std::thread(ReaderLoop);
    }
    return true;
}

void Dispatch(const std::wstring& json)
{
    if (g_closing || !g_hwnd || json.size() > 65536) return;
    try {
        JsonObject message = JsonObject::Parse(json);
        if (GetString(message, L"type") != L"browser") return;
        std::wstring action = GetString(message, L"action");
        if (action == L"bounds" || action == L"show") {
            if (message.HasKey(L"bounds")) {
                JsonObject bounds = message.GetNamedObject(L"bounds");
                const double scale = GetNumber(message, L"devicePixelRatio", DpiScale());
                if (!std::isfinite(scale) || scale < 0.25 || scale > 8) return;
                auto coordinate = [&](const wchar_t* name) {
                    double value = GetNumber(bounds, name) * scale;
                    return (LONG)std::clamp(value, -32768.0, 32768.0);
                };
                RECT parent{}; GetClientRect(GetParent(g_hwnd), &parent);
                LONG x = coordinate(L"x"), y = coordinate(L"y");
                LONG right = std::clamp(x + std::max<LONG>(0, coordinate(L"width")), 0L, parent.right);
                LONG bottom = std::clamp(y + std::max<LONG>(0, coordinate(L"height")), 0L, parent.bottom);
                x = std::clamp(x, 0L, parent.right); y = std::clamp(y, 0L, parent.bottom);
                SetWindowPos(g_hwnd, HWND_TOP, x, y, std::max<LONG>(0, right - x), std::max<LONG>(0, bottom - y), SWP_NOACTIVATE);
            }
            if (action == L"show" && !g_visible) {
                g_visible = true;
                ShowWindow(g_hwnd, SW_SHOWNOACTIVATE);
                for (auto& entry : g_views) ApplyVisibility(entry.second.get());
                Json j; j.str(L"ev", L"panel").boolean(L"visible", true);
                Emit(j);
            }
            PushHostState();
            return;
        }
        if (action == L"hide") {
            if (g_visible) {
                g_visible = false;
                ShowWindow(g_hwnd, SW_HIDE);
                for (auto& entry : g_views) ApplyVisibility(entry.second.get());
                Json j; j.str(L"ev", L"panel").boolean(L"visible", false);
                Emit(j);
            }
            PushHostState();
            return;
        }
        if (action == L"state") { PushHostState(); return; }
        // Commandes de l'IDE (ouvrir une adresse...) : traitees par le navigateur.
        Json j; j.str(L"ev", L"ideCommand").str(L"action", action).str(L"url", GetString(message, L"url"))
            .num(L"tabId", GetNumber(message, L"tabId", -1));
        Emit(j);
    } catch (...) {}
}

void UpdateDpi()
{
    if (!g_hwnd) return;
    for (auto& entry : g_views) { ApplyScale(entry.second.get()); ApplyBounds(entry.second.get()); }
    EmitResize();
}

void Shutdown()
{
    g_stateCallback = nullptr;
    g_stopping = true;
    if (g_stopEvent) SetEvent(g_stopEvent);
    g_writeSignal.notify_all();
    if (g_pipe != INVALID_HANDLE_VALUE) CancelIoEx(g_pipe, nullptr);
    if (g_reader.joinable()) g_reader.join();
    if (g_writer.joinable()) g_writer.join();
    if (g_hwnd) DestroyWindow(g_hwnd);
    g_env = nullptr;
    if (g_pipe != INVALID_HANDLE_VALUE) { CloseHandle(g_pipe); g_pipe = INVALID_HANDLE_VALUE; }
    if (g_stopEvent) { CloseHandle(g_stopEvent); g_stopEvent = nullptr; }
    if (g_panelBrush) { DeleteObject(g_panelBrush); g_panelBrush = nullptr; }
}

} // namespace ZaalisBrowser
