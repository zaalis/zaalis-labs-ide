// =============================================================================
//  zaalis browser  -  Navigateur natif Windows (C++ / Win32 / WebView2)
// -----------------------------------------------------------------------------
//  Architecture :
//   - Une fenetre Win32 native, icone = logo zaalis.
//   - Une "chrome" (onglets + barre d'adresse + favoris) rendue dans un WebView2
//     dedie, entierement themable (sombre = noir, clair = gris adouci).
//   - Un WebView2 de contenu par onglet (seul l'onglet actif est visible).
//   - Page d'accueil "zaalis search" (HomePage.h) comme nouvel onglet.
//   - Barre de recherche / loupe : recherche Google ou navigation directe.
//   - Favoris persistants (%APPDATA%\zaalis browser).
//
//  La chrome communique avec le natif via postMessage("action\x1farg"), le natif
//  renvoie l'etat complet via PostWebMessageAsJson.
// =============================================================================

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef UNICODE
#define UNICODE
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <wrl.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <dwmapi.h>
#include <string>
#include <vector>
#include <fstream>
#include <atomic>
#include <thread>
#include "WebView2.h"
#include "BrowserHost.h"
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <algorithm>
#include <cmath>
#include <functional>

#pragma comment(lib, "dwmapi.lib")

using namespace Microsoft::WRL;

// Attributs DWM non exposes par les en-tetes SDK plus anciens (Windows 11 22H2+).
#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif
#ifndef DWMWA_CAPTION_COLOR
#define DWMWA_CAPTION_COLOR 35
#endif
#ifndef DWMWA_TEXT_COLOR
#define DWMWA_TEXT_COLOR 36
#endif

#include "HomePage.h"
#include "ChromePage.h"
#include "PanelPage.h"
#include "LogoData.h"

namespace ZaalisBrowser {

// ----- Constantes -----------------------------------------------------------
static const wchar_t* kWindowClass = L"zaalisIdeBrowserPanel";
// Vide : la marque "zaalis" est deja affichee dans la barre d'onglets, pas
// besoin de la repeter en toutes lettres dans le bandeau natif.
static const wchar_t* kWindowTitle = L"";
static const wchar_t* kHomeUrl     = L"https://zaalis.home/index.html";
static const wchar_t* kChromeUrl   = L"https://zaalis.home/chrome.html";
static const wchar_t  SEP          = L'\x1f';
static const int      kPanelTopDip = 94; // aligne avec le debut du popup media

// ----- Structures -----------------------------------------------------------
struct Tab {
    int id = 0;
    bool loading = false;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2>           view;
};

struct Bookmark { std::wstring url; std::wstring title; };
struct Shortcut { std::wstring url; std::wstring title; };
struct HistoryEntry { std::wstring url; std::wstring title; };


// ----- Etat global ----------------------------------------------------------
static HWND                            g_hwnd = nullptr;
static ComPtr<ICoreWebView2Environment> g_env;
static ComPtr<ICoreWebView2Controller>  g_chromeController;
static ComPtr<ICoreWebView2>            g_chromeView;

static std::vector<Tab>      g_tabs;
static int                   g_active = -1;
static int                   g_nextId = 1;
static int                   g_chromeHeightDip = 128;
static int                   g_contentTopDip = 128;
static bool                  g_chromeOverlay = false;
static RECT                  g_chromeOverlayDip = { 0, 0, 0, 0 };

static std::wstring          g_theme = L"dark";
static std::wstring          g_searchEngine = L"google";
static bool                  g_showBookmarks = true;
static bool                  g_historyEnabled = true;
static bool                  g_blockPopups = false;
static bool                  g_contextMenus = true;
static bool                  g_devTools = true;
static bool                  g_statusBar = true;
static bool                  g_zoomControls = true;
static bool                  g_safeSearch = false;
static int                   g_zoomPct = 100;
static std::vector<Bookmark> g_bookmarks;
static std::vector<Shortcut> g_shortcuts;    // raccourcis de la page d'accueil
static std::wstring          g_homeFolder;   // dossier temporaire servi
static std::wstring          g_dataFolder;   // %APPDATA%\zaalis browser
static std::wstring          g_webViewDataFolder; // %LOCALAPPDATA%\zaalis browser\WebView2
static StateCallback g_stateCallback;
static bool g_visible = false;
static bool g_closing = false;
static std::wstring g_error;
static std::vector<std::wstring> g_pendingMessages;
static void PushHostState();
// L'API locale peut recevoir une requete avant que l'environnement WebView2
// (async) ne soit pret : on met en attente plutot que de perdre la commande.
static bool                       g_webviewReady = false;


// Panneau lateral (Parametres / Historique)
static ComPtr<ICoreWebView2Controller> g_panelController;
static ComPtr<ICoreWebView2>           g_panelView;
static bool        g_panelOpen = false;          // etat desire (ouvert/ferme)
static double      g_panelP = 0.0;               // progression d'animation 0..1
static double      g_panelAnimFrom = 0.0;
static double      g_panelAnimTo = 0.0;
static ULONGLONG   g_panelAnimStart = 0;   // GetTickCount64() au depart de l'anim
static bool        g_pendingPanelHistory = false;
static const int   kPanelWidthDip = 340;
static const UINT_PTR kPanelTimer = 1;
static const int   kPanelAnimDurationMs = 190;
// Dernieres bornes appliquees au contenu : evite de re-poser les memes bounds a
// chaque frame (ce qui faisait "trembler"/reflow la page pendant les animations).
// On memorise le controleur actif (et pas seulement l'index) car fermer un
// onglet peut reutiliser un index pour un controleur different.
static RECT        g_lastBody = { 0, 0, 0, 0 };
static ICoreWebView2Controller* g_lastActiveLaid = nullptr;

// Mode local securise + historique
static bool                      g_offline = false;
static std::vector<HistoryEntry> g_history;

// ----- Utilitaires fichiers -------------------------------------------------

static void WriteBytes(const std::wstring& path, const void* data, size_t len, bool bom = false)
{
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    if (bom) { const unsigned char b[3] = {0xEF,0xBB,0xBF}; WriteFile(h, b, 3, &written, nullptr); }
    WriteFile(h, data, (DWORD)len, &written, nullptr);
    CloseHandle(h);
}

// Ecrit les pages embarquees (index.html, chrome.html, logo) dans %TEMP%.
static std::wstring WriteServedFiles()
{
    wchar_t tmp[MAX_PATH] = {0};
    if (GetTempPathW(MAX_PATH, tmp) == 0) return L"";
    std::wstring folder = std::wstring(tmp) + L"zaalis-ide-browser\\";
    CreateDirectoryW(folder.c_str(), nullptr);

    WriteBytes(folder + L"index.html",  zaalis_HOME_PAGE,   strlen(zaalis_HOME_PAGE),   true);
    WriteBytes(folder + L"chrome.html", zaalis_CHROME_PAGE, strlen(zaalis_CHROME_PAGE), true);
    WriteBytes(folder + L"panel.html",  zaalis_PANEL_PAGE,  strlen(zaalis_PANEL_PAGE),  true);
    WriteBytes(folder + L"logo-zaalis.png", LOGO_PNG, LOGO_PNG_LEN, false);
    return folder;
}

// %APPDATA%\zaalis browser\  (cree si besoin)
static std::wstring DataFolder()
{
    wchar_t* appdata = nullptr;
    std::wstring folder;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &appdata)))
    {
        folder = std::wstring(appdata) + L"\\zaalis\\Browser\\";
        CoTaskMemFree(appdata);
        SHCreateDirectoryExW(nullptr, folder.c_str(), nullptr);
    }
    return folder;
}

// Profil WebView2 stable, separe du dossier d'installation.
static std::wstring WebViewDataFolder()
{
    wchar_t* local = nullptr;
    std::wstring folder;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local)))
    {
        folder = std::wstring(local) + L"\\zaalis\\Browser\\WebView2\\";
        CoTaskMemFree(local);
        SHCreateDirectoryExW(nullptr, folder.c_str(), nullptr);
    }
    return folder;
}

static void LoadSettings()
{
    std::wifstream s((g_dataFolder + L"settings.txt").c_str());
    std::wstring line;
    while (std::getline(s, line))
    {
        if      (line.rfind(L"theme=", 0) == 0)          g_theme = line.substr(6);
        else if (line.rfind(L"offline=", 0) == 0)        g_offline = (line.substr(8) == L"1");
        else if (line.rfind(L"searchEngine=", 0) == 0)   g_searchEngine = line.substr(13);
        else if (line.rfind(L"showBookmarks=", 0) == 0)  g_showBookmarks = (line.substr(14) != L"0");
        else if (line.rfind(L"historyEnabled=", 0) == 0) g_historyEnabled = (line.substr(15) != L"0");
        else if (line.rfind(L"blockPopups=", 0) == 0)    g_blockPopups = (line.substr(12) == L"1");
        else if (line.rfind(L"contextMenus=", 0) == 0)   g_contextMenus = (line.substr(13) != L"0");
        else if (line.rfind(L"devTools=", 0) == 0)       g_devTools = (line.substr(9) != L"0");
        else if (line.rfind(L"statusBar=", 0) == 0)      g_statusBar = (line.substr(10) != L"0");
        else if (line.rfind(L"zoomControls=", 0) == 0)   g_zoomControls = (line.substr(13) != L"0");
        else if (line.rfind(L"safeSearch=", 0) == 0)     g_safeSearch = (line.substr(11) == L"1");
        else if (line.rfind(L"zoomPct=", 0) == 0)        g_zoomPct = _wtoi(line.substr(8).c_str());
    }
    if (g_theme != L"dark") g_theme = L"light";
    if (g_searchEngine != L"google" && g_searchEngine != L"bing" &&
        g_searchEngine != L"duckduckgo" && g_searchEngine != L"brave")
        g_searchEngine = L"google";
    if (g_zoomPct < 67) g_zoomPct = 67;
    if (g_zoomPct > 200) g_zoomPct = 200;

    std::wifstream b((g_dataFolder + L"bookmarks.tsv").c_str());
    while (std::getline(b, line))
    {
        size_t tab = line.find(L'\t');
        if (tab == std::wstring::npos) continue;
        Bookmark bm; bm.url = line.substr(0, tab); bm.title = line.substr(tab + 1);
        if (!bm.url.empty()) g_bookmarks.push_back(bm);
    }

    std::wifstream sc((g_dataFolder + L"shortcuts.tsv").c_str());
    while (std::getline(sc, line))
    {
        size_t tab = line.find(L'\t');
        if (tab == std::wstring::npos) continue;
        Shortcut sh; sh.url = line.substr(0, tab); sh.title = line.substr(tab + 1);
        if (!sh.url.empty()) g_shortcuts.push_back(sh);
    }

    std::wifstream h((g_dataFolder + L"history.tsv").c_str());
    while (std::getline(h, line))
    {
        size_t tab = line.find(L'\t');
        if (tab == std::wstring::npos) continue;
        HistoryEntry e; e.url = line.substr(0, tab); e.title = line.substr(tab + 1);
        if (!e.url.empty()) g_history.push_back(e);
    }
}

static void SaveSettings()
{
    std::wofstream s((g_dataFolder + L"settings.txt").c_str());
    s << L"theme=" << g_theme << L"\n";
    s << L"offline=" << (g_offline ? L"1" : L"0") << L"\n";
    s << L"searchEngine=" << g_searchEngine << L"\n";
    s << L"showBookmarks=" << (g_showBookmarks ? L"1" : L"0") << L"\n";
    s << L"historyEnabled=" << (g_historyEnabled ? L"1" : L"0") << L"\n";
    s << L"blockPopups=" << (g_blockPopups ? L"1" : L"0") << L"\n";
    s << L"contextMenus=" << (g_contextMenus ? L"1" : L"0") << L"\n";
    s << L"devTools=" << (g_devTools ? L"1" : L"0") << L"\n";
    s << L"statusBar=" << (g_statusBar ? L"1" : L"0") << L"\n";
    s << L"zoomControls=" << (g_zoomControls ? L"1" : L"0") << L"\n";
    s << L"safeSearch=" << (g_safeSearch ? L"1" : L"0") << L"\n";
    s << L"zoomPct=" << g_zoomPct << L"\n";
}

static void SaveBookmarks()
{
    std::wofstream b((g_dataFolder + L"bookmarks.tsv").c_str());
    for (auto& bm : g_bookmarks) b << bm.url << L"\t" << bm.title << L"\n";
}

static void SaveHistory()
{
    std::wofstream h((g_dataFolder + L"history.tsv").c_str());
    for (auto& e : g_history) h << e.url << L"\t" << e.title << L"\n";
}

static void SaveShortcuts()
{
    std::wofstream s((g_dataFolder + L"shortcuts.tsv").c_str());
    for (auto& sh : g_shortcuts) s << sh.url << L"\t" << sh.title << L"\n";
}

// ----- Utilitaires chaines --------------------------------------------------

static std::wstring Trim(const std::wstring& s)
{
    size_t a = s.find_first_not_of(L" \t\r\n");
    if (a == std::wstring::npos) return L"";
    size_t b = s.find_last_not_of(L" \t\r\n");
    return s.substr(a, b - a + 1);
}

static std::wstring JsonEscape(const std::wstring& s)
{
    std::wstring o; o.reserve(s.size() + 8);
    for (wchar_t c : s)
    {
        switch (c)
        {
            case L'"':  o += L"\\\""; break;
            case L'\\': o += L"\\\\"; break;
            case L'\n': o += L"\\n";  break;
            case L'\r': o += L"\\r";  break;
            case L'\t': o += L"\\t";  break;
            default:
                if (c < 0x20) { wchar_t buf[8]; swprintf(buf, 8, L"\\u%04x", c); o += buf; }
                else o += c;
        }
    }
    return o;
}

// Encodage pourcent (sur l'UTF-8) pour une requete de recherche.
static std::wstring UrlEncode(const std::wstring& s)
{
    int n = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0, nullptr, nullptr);
    std::string utf8(n, 0);
    WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), &utf8[0], n, nullptr, nullptr);

    const char* hex = "0123456789ABCDEF";
    std::wstring o;
    for (unsigned char c : utf8)
    {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~')
            o += (wchar_t)c;
        else if (c == ' ')
            o += L'+';
        else { o += L'%'; o += (wchar_t)hex[c >> 4]; o += (wchar_t)hex[c & 0xF]; }
    }
    return o;
}

static bool StartsWith(const std::wstring& s, const wchar_t* p)
{
    return s.rfind(p, 0) == 0;
}

static std::wstring Utf8ToWide(const std::string& s)
{
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    if (n <= 0) return L"";
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
    return w;
}

static std::wstring SearchUrl(const std::wstring& query)
{
    std::wstring q = UrlEncode(query);
    if (g_searchEngine == L"bing")
        return L"https://www.bing.com/search?q=" + q + (g_safeSearch ? L"&adlt=strict" : L"");
    if (g_searchEngine == L"duckduckgo")
        return L"https://duckduckgo.com/?q=" + q + (g_safeSearch ? L"&kp=1" : L"");
    if (g_searchEngine == L"brave")
        return L"https://search.brave.com/search?q=" + q + (g_safeSearch ? L"&safesearch=strict" : L"");
    return L"https://www.google.com/search?q=" + q + (g_safeSearch ? L"&safe=active" : L"");
}

// Decide : navigation directe (URL) ou recherche Google.
static std::wstring ResolveQuery(const std::wstring& raw)
{
    std::wstring t = Trim(raw);
    if (t.empty()) return kHomeUrl;

    if (StartsWith(t, L"http://") || StartsWith(t, L"https://") ||
        StartsWith(t, L"about:blank"))
        return t;

    bool hasSpace = t.find_first_of(L" \t") != std::wstring::npos;
    size_t dot = t.find(L'.');
    bool hasDot = dot != std::wstring::npos && dot + 1 < t.size();
    bool isLocal = StartsWith(t, L"localhost") || StartsWith(t, L"127.0.0.1");

    if (!hasSpace && (hasDot || isLocal))
        return (isLocal ? L"http://" : L"https://") + t;

    return SearchUrl(t);
}

// Recupere une propriete chaine d'un WebView2 (Source / DocumentTitle).
static std::wstring GetViewString(ICoreWebView2* view, bool source)
{
    if (!view) return L"";
    LPWSTR p = nullptr;
    if (source) view->get_Source(&p); else view->get_DocumentTitle(&p);
    std::wstring r = p ? p : L"";
    if (p) CoTaskMemFree(p);
    return r;
}

static bool IsInternal(const std::wstring& u)
{
    return u.empty() || StartsWith(u, L"https://zaalis.home/") || u == L"about:blank";
}

// URL "locale" (autorisee en mode local securise) : pas de reseau externe.
static bool IsLocalUrl(const std::wstring& u)
{
    if (StartsWith(u, L"file:") || StartsWith(u, L"about:") || StartsWith(u, L"data:") ||
        StartsWith(u, L"edge:") || StartsWith(u, L"devtools:"))
        return true;
    // Extrait l'hote.
    size_t p = u.find(L"://");
    std::wstring rest = (p == std::wstring::npos) ? u : u.substr(p + 3);
    size_t slash = rest.find_first_of(L"/?#");
    std::wstring host = (slash == std::wstring::npos) ? rest : rest.substr(0, slash);
    size_t colon = host.find(L':');
    if (colon != std::wstring::npos) host = host.substr(0, colon);
    return host == L"localhost" || host == L"127.0.0.1" || host == L"[::1]" ||
           host == L"::1" || host == L"zaalis.home" || host == L"zaalis.home" || StartsWith(host, L"192.168.") ||
           StartsWith(host, L"10.") || StartsWith(host, L"172.16.");
}

// ----- Mise en page (DPI) ---------------------------------------------------

static double DpiScale() { UINT d = GetDpiForWindow(g_hwnd); return d ? d / 96.0 : 1.0; }

static void ApplyScaleTo(ICoreWebView2Controller* c)
{
    ComPtr<ICoreWebView2Controller3> c3;
    if (c && SUCCEEDED(c->QueryInterface(IID_PPV_ARGS(&c3))))
    {
        c3->put_ShouldDetectMonitorScaleChanges(FALSE);
        c3->put_BoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS);
        c3->put_RasterizationScale(DpiScale());
    }
}

// Couleur de fond par defaut de la WebView = couleur du theme (evite le flash blanc).
static void ApplyBackground(ICoreWebView2Controller* c, bool transparent = false)
{
    ComPtr<ICoreWebView2Controller2> c2;
    if (c && SUCCEEDED(c->QueryInterface(IID_PPV_ARGS(&c2))))
    {
        COREWEBVIEW2_COLOR col = transparent
            ? COREWEBVIEW2_COLOR{ 0, 0, 0, 0 }
            : (g_theme == L"dark")
                ? COREWEBVIEW2_COLOR{ 255, 32, 33, 36 }      // #202124
                : COREWEBVIEW2_COLOR{ 255, 233, 234, 237 };  // #e9eaed
        c2->put_DefaultBackgroundColor(col);
    }
}

static void ApplyWebSettings(ICoreWebView2* view)
{
    if (!view) return;
    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(view->get_Settings(&settings)) && settings)
    {
        settings->put_AreDefaultContextMenusEnabled(g_contextMenus ? TRUE : FALSE);
        settings->put_AreDevToolsEnabled(g_devTools ? TRUE : FALSE);
        settings->put_IsStatusBarEnabled(g_statusBar ? TRUE : FALSE);
        settings->put_IsZoomControlEnabled(g_zoomControls ? TRUE : FALSE);
    }
}

static void ApplyZoomTo(ICoreWebView2Controller* c)
{
    if (!c) return;
    double z = (double)g_zoomPct / 100.0;
    c->put_ZoomFactor(z);
}

// Bandeau natif (icone + min/max/fermer) : suit le theme au lieu de rester
// blanc fixe en mode sombre. Sans effet sur Windows < 11 22H2 (echec silencieux).
static void ApplyTitleBarTheme()
{
    if (!g_hwnd) return;
    BOOL dark = (g_theme == L"dark") ? TRUE : FALSE;
    DwmSetWindowAttribute(g_hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));

    COLORREF caption = dark ? RGB(32, 33, 36) : RGB(255, 255, 255);
    DwmSetWindowAttribute(g_hwnd, DWMWA_CAPTION_COLOR, &caption, sizeof(caption));
    COLORREF text = dark ? RGB(232, 234, 237) : RGB(32, 33, 36);
    DwmSetWindowAttribute(g_hwnd, DWMWA_TEXT_COLOR, &text, sizeof(text));
}

static Tab* ActiveTab() { return (g_active >= 0 && g_active < (int)g_tabs.size()) ? &g_tabs[g_active] : nullptr; }

static Tab* FindTabById(int id)
{
    for (auto& t : g_tabs)
        if (t.id == id) return &t;
    return nullptr;
}

static void ApplyAllWebSettings()
{
    ApplyWebSettings(g_chromeView.Get());
    ApplyWebSettings(g_panelView.Get());
    for (auto& t : g_tabs) ApplyWebSettings(t.view.Get());
}

static void ApplyAllZoom()
{
    for (auto& t : g_tabs) ApplyZoomTo(t.controller.Get());
}

static bool NearPx(int a, int b)
{
    int d = a - b;
    if (d < 0) d = -d;
    return d <= 3;
}

struct ChildBoundsMatch
{
    RECT target{};
    HWND found = nullptr;
};

static BOOL CALLBACK FindChildByBounds(HWND child, LPARAM param)
{
    ChildBoundsMatch* match = reinterpret_cast<ChildBoundsMatch*>(param);
    RECT r{};
    if (!GetWindowRect(child, &r)) return TRUE;
    MapWindowPoints(HWND_DESKTOP, g_hwnd, reinterpret_cast<POINT*>(&r), 2);

    if (NearPx(r.left, match->target.left) &&
        NearPx(r.top, match->target.top) &&
        NearPx(r.right, match->target.right) &&
        NearPx(r.bottom, match->target.bottom))
    {
        match->found = child;
        return FALSE;
    }
    return TRUE;
}

static void BringChildAtBoundsToFront(const RECT& bounds)
{
    ChildBoundsMatch match{};
    match.target = bounds;
    EnumChildWindows(g_hwnd, FindChildByBounds, reinterpret_cast<LPARAM>(&match));
    if (match.found)
        SetWindowPos(match.found, HWND_TOP, 0, 0, 0, 0,
                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

static HWND ChildAtBounds(const RECT& bounds)
{
    ChildBoundsMatch match{};
    match.target = bounds;
    EnumChildWindows(g_hwnd, FindChildByBounds, reinterpret_cast<LPARAM>(&match));
    return match.found;
}

static void ApplyChromeRegion(const RECT& bounds, int contentTop, int chromeH, int width, double scale)
{
    HWND child = ChildAtBounds(bounds);
    if (!child) return;

    if (chromeH <= contentTop + 2 || !g_chromeOverlay)
    {
        SetWindowRgn(child, nullptr, TRUE);
        return;
    }

    HRGN keep = CreateRectRgn(0, 0, width, contentTop);

    int left = (int)(g_chromeOverlayDip.left * scale + 0.5);
    int top = (int)(g_chromeOverlayDip.top * scale + 0.5);
    int right = (int)(g_chromeOverlayDip.right * scale + 0.5);
    int bottom = (int)(g_chromeOverlayDip.bottom * scale + 0.5);
    if (left < 0) left = 0;
    if (top < contentTop) top = contentTop;
    if (right > width) right = width;
    if (bottom > chromeH) bottom = chromeH;
    int pad = (int)(1 * scale + 0.5);
    left -= pad;
    top -= pad;
    right += pad;
    bottom += pad;
    if (left < 0) left = 0;
    if (top < contentTop) top = contentTop;
    if (right > width) right = width;
    if (bottom > chromeH) bottom = chromeH;
    if (right <= left || bottom <= top)
    {
        SetWindowRgn(child, keep, TRUE);
        return;
    }

    int radius = (int)(16 * scale + 0.5);
    HRGN popup = CreateRoundRectRgn(left, top, right + 1, bottom + 1, radius * 2, radius * 2);
    // Le sommet du popup est jointif avec la barre d'outils : on carre les deux
    // coins superieurs pour supprimer l'encoche/decoupe visible a la jonction.
    HRGN topSquare = CreateRectRgn(left, top, right + 1, top + radius + 1);
    CombineRgn(popup, popup, topSquare, RGN_OR);
    DeleteObject(topSquare);
    CombineRgn(keep, keep, popup, RGN_OR);
    DeleteObject(popup);

    SetWindowRgn(child, keep, TRUE); // Windows possede keep apres cet appel.
}

static void LayoutAll()
{
    if (!g_hwnd) return;
    RECT rc; GetClientRect(g_hwnd, &rc);
    double scale = DpiScale();
    int W = rc.right - rc.left, H = rc.bottom - rc.top;
    int chromeH = (int)(g_chromeHeightDip * scale + 0.5);
    int contentTop = (int)(g_contentTopDip * scale + 0.5);
    if (chromeH > H) chromeH = H;
    if (contentTop > H) contentTop = H;

    // Largeur pleine du panneau et portion visible (animee : il glisse).
    int pw = (int)(kPanelWidthDip * scale + 0.5);
    if (pw > W) pw = W;
    int visible = (int)(g_panelP * pw + 0.5);
    bool panelVisible = g_panelController && visible > 0;

    RECT chromeBounds = { 0, 0, W, chromeH };
    if (g_chromeController)
        g_chromeController->put_Bounds(chromeBounds);

    RECT body = { 0, contentTop, W, H };
    ICoreWebView2Controller* activeCtrl =
        (g_active >= 0 && g_active < (int)g_tabs.size()) ? g_tabs[g_active].controller.Get() : nullptr;
    bool bodyChanged = !EqualRect(&body, &g_lastBody) || activeCtrl != g_lastActiveLaid;
    for (int i = 0; i < (int)g_tabs.size(); ++i)
    {
        if (!g_tabs[i].controller) continue;
        bool active = (i == g_active);
        g_tabs[i].controller->put_IsVisible(active);
        if (active && bodyChanged) g_tabs[i].controller->put_Bounds(body);
    }
    g_lastBody = body;
    g_lastActiveLaid = activeCtrl;

    if (g_chromeController)
    {
        ApplyChromeRegion(chromeBounds, contentTop, chromeH, W, scale);
        BringChildAtBoundsToFront(chromeBounds);
    }

    // Panneau lateral droit en overlay : place apres les onglets pour rester au-dessus.
    if (g_panelController)
    {
        g_panelController->put_IsVisible(panelVisible);
        if (panelVisible)
        {
            int panelTop = (int)(kPanelTopDip * scale + 0.5);
            if (panelTop > H) panelTop = H;
            RECT pb = { W - visible, panelTop, W - visible + pw, H };
            g_panelController->put_Bounds(pb);
            BringChildAtBoundsToFront(pb);
        }
    }
}

// Met a jour uniquement le panneau lateral (utilise pendant l'animation de
// glissement) : on ne touche ni au contenu ni a la region de la chrome, ce qui
// supprime le tremblement de la page pendant l'ouverture/fermeture du panneau.
static void UpdatePanelBounds()
{
    if (!g_hwnd || !g_panelController) return;
    RECT rc; GetClientRect(g_hwnd, &rc);
    double scale = DpiScale();
    int W = rc.right - rc.left, H = rc.bottom - rc.top;
    int pw = (int)(kPanelWidthDip * scale + 0.5);
    if (pw > W) pw = W;
    int visible = (int)(g_panelP * pw + 0.5);
    bool panelVisible = visible > 0;

    g_panelController->put_IsVisible(panelVisible);
    if (panelVisible)
    {
        int panelTop = (int)(kPanelTopDip * scale + 0.5);
        if (panelTop > H) panelTop = H;
        RECT pb = { W - visible, panelTop, W - visible + pw, H };
        g_panelController->put_Bounds(pb);
        BringChildAtBoundsToFront(pb);
    }
}

// Donne le focus clavier/souris a la WebView de l'onglet actif. Sans cela, le
// premier clic sur une page ne sert qu'a lui donner le focus (d'ou le besoin de
// "cliquer deux fois") ; on le force apres chaque action de navigation.
static void FocusActiveTab()
{
    Tab* a = ActiveTab();
    if (a && a->controller)
        a->controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
}

// ----- Etat -> chrome -------------------------------------------------------

static void PushState()
{
    PushHostState();
    if (!g_chromeView) return;
    Tab* a = ActiveTab();
    std::wstring activeUrl   = a ? GetViewString(a->view.Get(), true)  : L"";
    std::wstring activeTitle = a ? GetViewString(a->view.Get(), false) : L"";

    BOOL back = FALSE, fwd = FALSE;
    if (a && a->view) { a->view->get_CanGoBack(&back); a->view->get_CanGoForward(&fwd); }

    bool marked = false;
    for (auto& b : g_bookmarks) if (b.url == activeUrl && !IsInternal(activeUrl)) { marked = true; break; }

    std::wstring j = L"{\"type\":\"state\",\"theme\":\"" + g_theme +
                     L"\",\"searchEngine\":\"" + g_searchEngine + L"\"" +
                     L",\"offline\":" + (g_offline ? L"true" : L"false") +
                     L",\"showBookmarks\":" + (g_showBookmarks ? L"true" : L"false") + L",\"tabs\":[";
    for (size_t i = 0; i < g_tabs.size(); ++i)
    {
        std::wstring url   = GetViewString(g_tabs[i].view.Get(), true);
        std::wstring title = GetViewString(g_tabs[i].view.Get(), false);
        if (i) j += L",";
        j += L"{\"id\":" + std::to_wstring(g_tabs[i].id) +
             L",\"title\":\"" + JsonEscape(title) + L"\"" +
             L",\"url\":\""   + JsonEscape(url)   + L"\"" +
             L",\"active\":"  + ((int)i == g_active ? L"true" : L"false") + L"}";
    }
    j += L"],\"active\":{\"url\":\"" + JsonEscape(activeUrl) + L"\",\"title\":\"" + JsonEscape(activeTitle) +
         L"\",\"canBack\":"   + (back ? L"true" : L"false") +
         L",\"canForward\":"  + (fwd  ? L"true" : L"false") +
         L",\"loading\":"     + ((a && a->loading) ? L"true" : L"false") +
         L",\"isBookmarked\":"+ (marked ? L"true" : L"false") + L"},\"bookmarks\":[";
    for (size_t i = 0; i < g_bookmarks.size(); ++i)
    {
        if (i) j += L",";
        j += L"{\"title\":\"" + JsonEscape(g_bookmarks[i].title) + L"\",\"url\":\"" + JsonEscape(g_bookmarks[i].url) + L"\"}";
    }
    j += L"]}";

    g_chromeView->PostWebMessageAsJson(j.c_str());
}

// Etat des reglages -> panneau.
static void PushPanelState()
{
    if (!g_panelView) return;
    std::wstring j = L"{\"type\":\"state\",\"theme\":\"" + g_theme +
                     L"\",\"searchEngine\":\"" + g_searchEngine + L"\"" +
                     L",\"offline\":" + (g_offline ? L"true" : L"false") +
                     L",\"showBookmarks\":" + (g_showBookmarks ? L"true" : L"false") +
                     L",\"historyEnabled\":" + (g_historyEnabled ? L"true" : L"false") +
                     L",\"blockPopups\":" + (g_blockPopups ? L"true" : L"false") +
                     L",\"contextMenus\":" + (g_contextMenus ? L"true" : L"false") +
                     L",\"devTools\":" + (g_devTools ? L"true" : L"false") +
                     L",\"statusBar\":" + (g_statusBar ? L"true" : L"false") +
                     L",\"zoomControls\":" + (g_zoomControls ? L"true" : L"false") +
                     L",\"safeSearch\":" + (g_safeSearch ? L"true" : L"false") +
                     L",\"zoomPct\":" + std::to_wstring(g_zoomPct) +
                     L",\"historyCount\":" + std::to_wstring(g_history.size()) +
                     L",\"bookmarkCount\":" + std::to_wstring(g_bookmarks.size()) + L"}";
    g_panelView->PostWebMessageAsJson(j.c_str());
}

// Raccourcis -> pages d'accueil actuellement ouvertes (nouvel onglet).
static void PushShortcuts()
{
    std::wstring j = L"{\"type\":\"shortcuts\",\"items\":[";
    for (size_t i = 0; i < g_shortcuts.size(); ++i)
    {
        if (i) j += L",";
        j += L"{\"title\":\"" + JsonEscape(g_shortcuts[i].title) + L"\",\"url\":\"" + JsonEscape(g_shortcuts[i].url) + L"\"}";
    }
    j += L"]}";
    for (auto& t : g_tabs)
    {
        if (!t.view) continue;
        std::wstring url = GetViewString(t.view.Get(), true);
        if (IsInternal(url)) t.view->PostWebMessageAsJson(j.c_str());
    }
}

// Historique -> panneau (plus recent en premier).
static void SendPanelHistory()
{
    if (!g_panelView) return;
    std::wstring j = L"{\"type\":\"history\",\"items\":[";
    bool first = true;
    for (size_t i = g_history.size(); i-- > 0; )
    {
        if (!first) j += L",";
        first = false;
        j += L"{\"title\":\"" + JsonEscape(g_history[i].title) +
             L"\",\"url\":\"" + JsonEscape(g_history[i].url) + L"\"}";
    }
    j += L"]}";
    g_panelView->PostWebMessageAsJson(j.c_str());
}

static void RemoveHistoryUrl(const std::wstring& url)
{
    for (size_t i = 0; i < g_history.size(); ++i)
    {
        if (g_history[i].url == url)
        {
            g_history.erase(g_history.begin() + i);
            SaveHistory();
            SendPanelHistory();
            PushPanelState();
            return;
        }
    }
}

// Ajoute une entree d'historique (en ignorant les doublons consecutifs et l'interne).
static void RecordHistory(const std::wstring& url, const std::wstring& title)
{
    if (!g_historyEnabled) return;
    if (IsInternal(url)) return;
    if (!g_history.empty() && g_history.back().url == url) { g_history.back().title = title; }
    else g_history.push_back({ url, title });
    if (g_history.size() > 1000) g_history.erase(g_history.begin(), g_history.begin() + (g_history.size() - 1000));
    SaveHistory();
}

// ----- Actions onglets ------------------------------------------------------

static std::wstring ThemeInjectScript()
{
    return L"try{localStorage.setItem('zaalis_theme','" + g_theme + L"');}catch(e){}";
}

static void NavigateActive(const std::wstring& url)
{
    Tab* a = ActiveTab();
    if (a && a->view) a->view->Navigate(url.c_str());
}

// Forward declarations
static void HandleMessage(const std::wstring& msg);
static void SetupVirtualHost(ICoreWebView2* view);
static std::vector<std::wstring> Split(const std::wstring& s, wchar_t sep);
static void RegisterAccelerators(ICoreWebView2Controller* c);
static void OpenPanel(bool showHistory);
static void StartPanelAnim();
static void FlushPendingMessages();

static void RegisterViewEvents(ICoreWebView2* view)
{
    EventRegistrationToken tok;
    // Pilote la barre de progression (facon Google) affichee dans la chrome :
    // demarre au lancement de la navigation, s'acheve a la fin du chargement.
    view->add_NavigationStarting(
        Callback<ICoreWebView2NavigationStartingEventHandler>(
            [](ICoreWebView2* sender, ICoreWebView2NavigationStartingEventArgs*) -> HRESULT {
                for (auto& t : g_tabs) if (t.view.Get() == sender) { t.loading = true; break; }
                PushState();
                return S_OK;
            }).Get(), &tok);
    view->add_NavigationCompleted(
        Callback<ICoreWebView2NavigationCompletedEventHandler>(
            [](ICoreWebView2* sender, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                BOOL ok = FALSE; if (args) args->get_IsSuccess(&ok);
                if (ok) RecordHistory(GetViewString(sender, true), GetViewString(sender, false));
                for (auto& t : g_tabs) if (t.view.Get() == sender) { t.loading = false; break; }
                PushState();
                if (ok && IsInternal(GetViewString(sender, true))) PushShortcuts();
                return S_OK;
            }).Get(), &tok);

    // Mode local securise : blocage de tout le reseau externe.
    view->AddWebResourceRequestedFilter(L"*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    view->add_WebResourceRequested(
        Callback<ICoreWebView2WebResourceRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                if (!g_offline || !g_env) return S_OK;
                ComPtr<ICoreWebView2WebResourceRequest> req;
                args->get_Request(&req);
                LPWSTR uri = nullptr; if (req) req->get_Uri(&uri);
                std::wstring u = uri ? uri : L""; if (uri) CoTaskMemFree(uri);
                if (IsLocalUrl(u)) return S_OK; // autorise

                COREWEBVIEW2_WEB_RESOURCE_CONTEXT ctx = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                args->get_ResourceContext(&ctx);
                ComPtr<ICoreWebView2WebResourceResponse> resp;
                if (ctx == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT)
                {
                    static const char* BLOCKED =
                        u8"<!doctype html><meta charset='utf-8'><body style=\"margin:0;height:100vh;"
                        u8"display:flex;flex-direction:column;align-items:center;justify-content:center;"
                        u8"font-family:Segoe UI,Arial,sans-serif;background:#202124;color:#e8eaed\">"
                        u8"<div style=\"font-size:54px\">&#128274;</div>"
                        u8"<h2>Mode local securise actif</h2>"
                        u8"<p style=\"color:#9aa0a6\">Le reseau est coupe. Seules les URL locales "
                        u8"(localhost, 127.0.0.1, reseau prive) sont autorisees.</p></body>";
                    IStream* s = SHCreateMemStream((const BYTE*)BLOCKED, (UINT)strlen(BLOCKED));
                    g_env->CreateWebResourceResponse(s, 200, L"OK", L"Content-Type: text/html; charset=utf-8", &resp);
                    if (s) s->Release();
                }
                else
                {
                    g_env->CreateWebResourceResponse(nullptr, 403, L"Blocked", L"", &resp);
                }
                if (resp) args->put_Response(resp.Get());
                return S_OK;
            }).Get(), &tok);
    view->add_SourceChanged(
        Callback<ICoreWebView2SourceChangedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2SourceChangedEventArgs*) -> HRESULT { PushState(); return S_OK; }).Get(), &tok);
    view->add_DocumentTitleChanged(
        Callback<ICoreWebView2DocumentTitleChangedEventHandler>(
            [](ICoreWebView2*, IUnknown*) -> HRESULT { PushState(); return S_OK; }).Get(), &tok);
    view->add_HistoryChanged(
        Callback<ICoreWebView2HistoryChangedEventHandler>(
            [](ICoreWebView2*, IUnknown*) -> HRESULT { PushState(); return S_OK; }).Get(), &tok);
    // Liens cible _blank -> nouvel onglet
    view->add_NewWindowRequested(
        Callback<ICoreWebView2NewWindowRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                LPWSTR uri = nullptr; args->get_Uri(&uri);
                std::wstring u = uri ? uri : L""; if (uri) CoTaskMemFree(uri);
                args->put_Handled(TRUE);
                if (g_blockPopups) return S_OK;
                HandleMessage(std::wstring(L"openInNewTab") + SEP + u);
                return S_OK;
            }).Get(), &tok);
    // Messages venant de la page (page d'accueil : recherche)
    view->add_WebMessageReceived(
        Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [](ICoreWebView2* sender, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                if (!StartsWith(GetViewString(sender, true), L"https://zaalis.home/")) return S_OK;
                LPWSTR m = nullptr;
                if (SUCCEEDED(args->TryGetWebMessageAsString(&m)) && m) { HandleMessage(m); CoTaskMemFree(m); }
                return S_OK;
            }).Get(), &tok);
}

// Cree un onglet ; navigue vers 'url' (vide => accueil). makeActive => onglet courant.
static void CreateTab(const std::wstring& url, bool makeActive)
{
    if (!g_env || g_closing || g_tabs.size() >= 32) return;
    std::wstring target = url.empty() ? kHomeUrl : url;

    g_env->CreateCoreWebView2Controller(
        g_hwnd,
        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
            [target, makeActive](HRESULT res, ICoreWebView2Controller* controller) -> HRESULT
            {
                if (g_closing) { if (controller) controller->Close(); return S_OK; }
                if (FAILED(res) || !controller) { g_error = L"Creation WebView2 impossible"; PushHostState(); return res; }
                ApplyScaleTo(controller);
                ApplyBackground(controller);
                RegisterAccelerators(controller);

                Tab tab;
                tab.id = g_nextId++;
                tab.controller = controller;
                controller->get_CoreWebView2(&tab.view);

                SetupVirtualHost(tab.view.Get());
                ApplyWebSettings(tab.view.Get());
                ApplyZoomTo(controller);
                RegisterViewEvents(tab.view.Get());
                tab.view->AddScriptToExecuteOnDocumentCreated(ThemeInjectScript().c_str(), nullptr);

                g_tabs.push_back(tab);
                if (makeActive) g_active = (int)g_tabs.size() - 1;

                tab.view->Navigate(target.c_str());
                LayoutAll();
                PushState();
                if (makeActive) FocusActiveTab();
                // Le premier onglet pret = signal que l'API locale peut agir
                // en toute securite (onglet actif + WebView2 exploitables).
                if (!g_webviewReady) FlushPendingMessages();
                return S_OK;
            }).Get());
}

static void CloseTab(int id)
{
    for (size_t i = 0; i < g_tabs.size(); ++i)
    {
        if (g_tabs[i].id != id) continue;
        if (g_tabs[i].controller) g_tabs[i].controller->Close();
        g_tabs.erase(g_tabs.begin() + i);
        if (g_active >= (int)i) g_active--;
        break;
    }
    if (g_tabs.empty()) { CreateTab(L"", true); return; }
    if (g_active < 0) g_active = 0;
    LayoutAll();
    PushState();
}

static void SelectTab(int id)
{
    for (size_t i = 0; i < g_tabs.size(); ++i)
        if (g_tabs[i].id == id) { g_active = (int)i; break; }
    LayoutAll();
    PushState();
    FocusActiveTab();
}

// Reordonne les onglets selon la liste d'ids (csv) fournie par la chrome.
static void ReorderTabs(const std::wstring& csv)
{
    int activeId = ActiveTab() ? ActiveTab()->id : -1;

    std::vector<Tab> ordered;
    auto ids = Split(csv, L',');
    for (auto& s : ids)
    {
        int id = _wtoi(s.c_str());
        for (size_t i = 0; i < g_tabs.size(); ++i)
            if (g_tabs[i].id == id) { ordered.push_back(g_tabs[i]); g_tabs[i].id = -1; break; }
    }
    // Securite : onglets non listes conserves a la fin.
    for (auto& t : g_tabs) if (t.id != -1) ordered.push_back(t);

    if (ordered.size() != g_tabs.size()) return; // incoherent : on ne touche pas
    g_tabs = ordered;

    g_active = 0;
    for (size_t i = 0; i < g_tabs.size(); ++i) if (g_tabs[i].id == activeId) { g_active = (int)i; break; }
    PushState();
}

static void ToggleBookmark()
{
    Tab* a = ActiveTab(); if (!a) return;
    std::wstring url = GetViewString(a->view.Get(), true);
    if (IsInternal(url)) return;
    std::wstring title = GetViewString(a->view.Get(), false);
    for (size_t i = 0; i < g_bookmarks.size(); ++i)
        if (g_bookmarks[i].url == url) { g_bookmarks.erase(g_bookmarks.begin() + i); SaveBookmarks(); PushState(); return; }
    g_bookmarks.push_back({ url, title });
    SaveBookmarks();
    PushState();
}

// Ajoute un raccourci depuis la page d'accueil (URL saisie par l'utilisateur).
static void AddShortcut(const std::wstring& rawUrl, const std::wstring& title)
{
    std::wstring url = Trim(rawUrl);
    if (url.empty()) return;
    url = ResolveQuery(url);
    if (IsInternal(url)) return;
    for (auto& sh : g_shortcuts) if (sh.url == url) return; // deja present
    g_shortcuts.push_back({ url, Trim(title) });
    SaveShortcuts();
    PushShortcuts();
}

static void RemoveShortcut(const std::wstring& url)
{
    for (size_t i = 0; i < g_shortcuts.size(); ++i)
        if (g_shortcuts[i].url == url) { g_shortcuts.erase(g_shortcuts.begin() + i); SaveShortcuts(); PushShortcuts(); return; }
}

static void SetTheme(const std::wstring& theme)
{
    g_theme = (theme == L"dark") ? L"dark" : L"light";
    SaveSettings();
    ApplyTitleBarTheme();
    // Applique en direct a toutes les pages de contenu.
    std::wstring js = L"(function(){try{localStorage.setItem('zaalis_theme','" + g_theme +
        L"');}catch(e){} if(document.body){document.body.classList.toggle('dark-mode'," +
        (g_theme == L"dark" ? L"true" : L"false") + L");}})()";
    for (auto& t : g_tabs) if (t.view) t.view->ExecuteScript(js.c_str(), nullptr);
    // Met a jour la couleur de fond (anti-flash) sur tous les WebView.
    ApplyBackground(g_chromeController.Get(), true);
    ApplyBackground(g_panelController.Get());
    for (auto& t : g_tabs) ApplyBackground(t.controller.Get());
    PushState();
    PushPanelState();
}

static void SetSearchEngine(const std::wstring& engine)
{
    if (engine == L"bing" || engine == L"duckduckgo" || engine == L"brave")
        g_searchEngine = engine;
    else
        g_searchEngine = L"google";
    SaveSettings();
    PushState();
    PushPanelState();
}

static void SetZoomPct(int pct)
{
    if (pct < 67) pct = 67;
    if (pct > 200) pct = 200;
    g_zoomPct = pct;
    SaveSettings();
    ApplyAllZoom();
    PushPanelState();
}

static void ResetSettings()
{
    g_theme = L"light";
    g_searchEngine = L"google";
    g_showBookmarks = true;
    g_historyEnabled = true;
    g_blockPopups = false;
    g_contextMenus = true;
    g_devTools = true;
    g_statusBar = true;
    g_zoomControls = true;
    g_safeSearch = false;
    g_zoomPct = 100;
    SaveSettings();
    ApplyAllWebSettings();
    ApplyAllZoom();
    SetTheme(g_theme);
    PushState();
    PushPanelState();
}

// ----- Panneau lateral (Parametres / Historique) ----------------------------

static void CreatePanel()
{
    if (!g_env || g_panelView) return;
    g_env->CreateCoreWebView2Controller(g_hwnd,
        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
            [](HRESULT res, ICoreWebView2Controller* controller) -> HRESULT
            {
                if (g_closing) { if (controller) controller->Close(); return S_OK; }
                if (FAILED(res) || !controller) { g_error = L"Creation WebView2 impossible"; PushHostState(); return res; }
                g_panelController = controller;
                g_panelController->get_CoreWebView2(&g_panelView);
                ApplyScaleTo(controller);
                ApplyBackground(controller);
                RegisterAccelerators(controller);
                SetupVirtualHost(g_panelView.Get());
                ApplyWebSettings(g_panelView.Get());

                EventRegistrationToken tok;
                g_panelView->add_WebMessageReceived(
                    Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                        [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                            LPWSTR m = nullptr;
                            if (SUCCEEDED(args->TryGetWebMessageAsString(&m)) && m) { HandleMessage(m); CoTaskMemFree(m); }
                            return S_OK;
                        }).Get(), &tok);

                g_panelView->Navigate(L"https://zaalis.home/panel.html");
                g_panelP = g_panelOpen ? 0.90 : 0.0;
                LayoutAll();
                if (g_panelOpen) StartPanelAnim();
                return S_OK;
            }).Get());
}

static void StartPanelAnim()
{
    if (!g_hwnd) return;
    KillTimer(g_hwnd, kPanelTimer);
    g_panelAnimFrom = g_panelP;
    g_panelAnimTo = g_panelOpen ? 1.0 : 0.0;
    g_panelAnimStart = GetTickCount64();
    // Interval court : la progression se calcule sur le temps ecoule reel (et
    // non sur un compteur de ticks), donc un WM_TIMER retarde/regroupe par le
    // systeme ne fait plus "sauter"/trembler le panneau, juste rattraper l'anim.
    SetTimer(g_hwnd, kPanelTimer, 10, nullptr);
}

static void OpenPanel(bool showHistory)
{
    g_panelOpen = true;
    g_pendingPanelHistory = showHistory;
    if (g_panelP <= 0.01) g_panelP = 0.90;
    if (!g_panelView) { CreatePanel(); return; }
    LayoutAll();
    StartPanelAnim();
    PushPanelState();
    if (showHistory) SendPanelHistory();
}

static void ClosePanel()
{
    g_panelOpen = false;
    StartPanelAnim();
}

static void TogglePanel()
{
    if (g_panelOpen) ClosePanel();
    else OpenPanel(false);
}

static std::wstring MediaStateScript(int tabId, bool active)
{
    std::wstring script = LR"JS(
(function(tabId, active){
  function pickMedia(){
    const all = Array.from(document.querySelectorAll("video,audio"))
      .filter(m => !Number.isNaN(m.duration) && m.duration > 0);
    return all.find(m => !m.paused) || all[0] || null;
  }
  const media = pickMedia();
  const meta = navigator.mediaSession && navigator.mediaSession.metadata;
  const host = location.hostname.replace(/^www\./,"");
  let data = { type:"mediaState", available:false, host:host, tabId:tabId, active:active };
  if (media) {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogImage = document.querySelector('meta[property="og:image"]');
    const title = (meta && meta.title) || (ogTitle && ogTitle.content) || document.title || host;
    const artist = (meta && meta.artist) || (document.querySelector("#owner #channel-name a") || {}).textContent || host;
    const artwork = (meta && meta.artwork && meta.artwork.length ? meta.artwork[meta.artwork.length - 1].src : "") ||
                    (ogImage && ogImage.content) || "";
    data = {
      type:"mediaState",
      available:true,
      tabId:tabId,
      active:active,
      title:String(title || "").replace(/\s+-\s+YouTube$/,""),
      artist:String(artist || "").trim(),
      host:host,
      artwork:artwork,
      paused:!!media.paused,
      current:Number(media.currentTime || 0),
      duration:Number(media.duration || 0),
      muted:!!media.muted,
      hasCaptions:!!document.querySelector(".ytp-subtitles-button,[aria-label*='subtitles' i],[aria-label*='captions' i],[aria-label*='sous-titres' i]"),
      captionsOn:(function(){
        const b = document.querySelector(".ytp-subtitles-button,[aria-label*='subtitles' i],[aria-label*='captions' i],[aria-label*='sous-titres' i]");
        if (!b) return false;
        return b.classList.contains("ytp-button-active") ||
               b.getAttribute("aria-pressed") === "true" ||
               /désactiver|desactiver|off/i.test(b.getAttribute("aria-label") || "");
      })()
    };
  }
  chrome.webview.postMessage("mediaState\x1f" + JSON.stringify(data));
})
)JS";
    script += L"(" + std::to_wstring(tabId) + L"," + (active ? L"true" : L"false") + L")";
    return script;
}

static void QueryMediaState()
{
    if (!g_chromeView) return;
    bool sent = false;
    int activeId = ActiveTab() ? ActiveTab()->id : -1;
    for (auto& t : g_tabs)
    {
        if (!t.view) continue;
        std::wstring script = MediaStateScript(t.id, t.id == activeId);
        t.view->ExecuteScript(script.c_str(), nullptr);
        sent = true;
    }
    if (!sent)
        g_chromeView->PostWebMessageAsJson(L"{\"type\":\"mediaState\",\"available\":false}");
}

static void SendDevToolsKey(ICoreWebView2* view, const wchar_t* key, const wchar_t* code, int vk)
{
    if (!view) return;
    std::wstring down = L"{\"type\":\"keyDown\",\"key\":\"";
    down += key;
    down += L"\",\"code\":\"";
    down += code;
    down += L"\",\"windowsVirtualKeyCode\":";
    down += std::to_wstring(vk);
    down += L",\"nativeVirtualKeyCode\":";
    down += std::to_wstring(vk);
    if (wcslen(key) == 1)
    {
        down += L",\"text\":\"";
        down += key;
        down += L"\",\"unmodifiedText\":\"";
        down += key;
        down += L"\"";
    }
    down += L"}";

    std::wstring up = L"{\"type\":\"keyUp\",\"key\":\"";
    up += key;
    up += L"\",\"code\":\"";
    up += code;
    up += L"\",\"windowsVirtualKeyCode\":";
    up += std::to_wstring(vk);
    up += L",\"nativeVirtualKeyCode\":";
    up += std::to_wstring(vk);
    up += L"}";

    view->CallDevToolsProtocolMethod(L"Input.dispatchKeyEvent", down.c_str(), nullptr);
    view->CallDevToolsProtocolMethod(L"Input.dispatchKeyEvent", up.c_str(), nullptr);
}

static void RunMediaCommand(const std::wstring& command, int tabId)
{
    Tab* a = tabId > 0 ? FindTabById(tabId) : ActiveTab();
    if (!a || !a->view) return;

    if (command == L"playPause") SendDevToolsKey(a->view.Get(), L"k", L"KeyK", 75);
    else if (command == L"seekBack") SendDevToolsKey(a->view.Get(), L"j", L"KeyJ", 74);
    else if (command == L"seekForward") SendDevToolsKey(a->view.Get(), L"l", L"KeyL", 76);
    else if (command == L"captions") SendDevToolsKey(a->view.Get(), L"c", L"KeyC", 67);

    std::wstring cmd = command;
    std::wstring script = LR"JS(
(function(cmd){
  function media(){
    const all = Array.from(document.querySelectorAll("video,audio"))
      .filter(m => !Number.isNaN(m.duration) && m.duration > 0);
    return all.find(m => !m.paused) ||
      all.sort((a,b)=>(b.clientWidth*b.clientHeight)-(a.clientWidth*a.clientHeight))[0] ||
      null;
  }
  function visible(el){
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function click(sel){
    const all = Array.from(document.querySelectorAll(sel));
    const el = all.find(visible) || all[0];
    if (el) {
      el.dispatchEvent(new MouseEvent("mouseover", {bubbles:true, cancelable:true, view:window}));
      el.dispatchEvent(new MouseEvent("mousedown", {bubbles:true, cancelable:true, view:window}));
      el.dispatchEvent(new MouseEvent("mouseup", {bubbles:true, cancelable:true, view:window}));
      el.click();
      return true;
    }
    return false;
  }
  function yt(sel){ return click(sel); }
  const m = media();
  if (cmd === "playPause") {
    if (!yt(".ytp-play-button,[aria-label='Play'],[aria-label='Pause'],[aria-label='Lire'],[aria-label='Mettre en pause']") && m) {
      if (m.paused) { const p = m.play(); if (p && p.catch) p.catch(()=>{}); }
      else m.pause();
    }
  }
  else if (cmd === "seekBack" && m) {
    m.currentTime = Math.max(0, (m.currentTime || 0) - 10);
    m.dispatchEvent(new Event("timeupdate", { bubbles:true }));
  }
  else if (cmd === "seekForward" && m) {
    m.currentTime = Math.min(m.duration || 0, (m.currentTime || 0) + 10);
    m.dispatchEvent(new Event("timeupdate", { bubbles:true }));
  }
  else if (cmd === "next") { yt(".ytp-next-button,[aria-label='Next'],[aria-label='Suivant']"); }
  else if (cmd === "prev") { yt(".ytp-prev-button,[aria-label='Previous'],[aria-label='Précédent'],[aria-label='Precedent']"); }
  else if (cmd === "captions") {
    yt(".ytp-subtitles-button,[aria-label*='subtitles' i],[aria-label*='captions' i],[aria-label*='sous-titres' i]");
  }
  else if (cmd === "captionSettings") {
    yt(".ytp-settings-button,[aria-label*='Settings' i],[aria-label*='Paramètres' i],[aria-label*='Parametres' i]");
  }
})(")JS";
    script += L"\"" + JsonEscape(cmd) + L"\")";
    a->view->ExecuteScript(script.c_str(), nullptr);
}

// ----- Raccourcis clavier ---------------------------------------------------

static bool HandleAccelerator(UINT vk)
{
    bool ctrl  = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
    bool shift = (GetKeyState(VK_SHIFT)   & 0x8000) != 0;
    bool alt   = (GetKeyState(VK_MENU)    & 0x8000) != 0;

    if (ctrl && !alt)
    {
        switch (vk)
        {
            case 'T': CreateTab(L"", true); return true;
            case 'W': { Tab* a = ActiveTab(); if (a) CloseTab(a->id); return true; }
            case 'L': if (g_chromeView) g_chromeView->PostWebMessageAsJson(L"{\"type\":\"focusOmni\"}"); return true;
            case 'R': { Tab* a = ActiveTab(); if (a && a->view) a->view->Reload(); return true; }
            case 'H': OpenPanel(true); return true;
            case VK_TAB:
                if (!g_tabs.empty()) { int n = (int)g_tabs.size(); g_active = ((g_active + (shift ? -1 : 1)) % n + n) % n; LayoutAll(); PushState(); }
                return true;
        }
    }
    if (vk == VK_F5) { Tab* a = ActiveTab(); if (a && a->view) a->view->Reload(); return true; }
    if (alt && vk == VK_HOME) { NavigateActive(kHomeUrl); return true; }
    return false;
}

static void RegisterAccelerators(ICoreWebView2Controller* c)
{
    if (!c) return;
    EventRegistrationToken tok;
    c->add_AcceleratorKeyPressed(
        Callback<ICoreWebView2AcceleratorKeyPressedEventHandler>(
            [](ICoreWebView2Controller*, ICoreWebView2AcceleratorKeyPressedEventArgs* args) -> HRESULT {
                COREWEBVIEW2_KEY_EVENT_KIND kind; args->get_KeyEventKind(&kind);
                if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN &&
                    kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) return S_OK;
                UINT vk = 0; args->get_VirtualKey(&vk);
                if (HandleAccelerator(vk)) args->put_Handled(TRUE);
                return S_OK;
            }).Get(), &tok);
}

// ----- Routeur de messages --------------------------------------------------

static std::vector<std::wstring> Split(const std::wstring& s, wchar_t sep)
{
    std::vector<std::wstring> out; size_t start = 0, p;
    while ((p = s.find(sep, start)) != std::wstring::npos) { out.push_back(s.substr(start, p - start)); start = p + 1; }
    out.push_back(s.substr(start));
    return out;
}

static void HandleMessage(const std::wstring& msg)
{
    auto p = Split(msg, SEP);
    const std::wstring& a = p[0];
    auto arg = [&](size_t i){ return i < p.size() ? p[i] : std::wstring(); };

    if      (a == L"ready")          PushState();
    else if (a == L"chromeHeight")   {
        int h = _wtoi(arg(1).c_str());
        int top = p.size() > 2 ? _wtoi(arg(2).c_str()) : h;
        g_chromeOverlay = p.size() > 6;
        if (g_chromeOverlay)
        {
            g_chromeOverlayDip.left = _wtoi(arg(3).c_str());
            g_chromeOverlayDip.top = _wtoi(arg(4).c_str());
            g_chromeOverlayDip.right = _wtoi(arg(5).c_str());
            g_chromeOverlayDip.bottom = _wtoi(arg(6).c_str());
        }
        else
        {
            g_chromeOverlayDip = { 0, 0, 0, 0 };
        }
        if (h > 40 && h < 620 && top > 40 && top < 220) { g_chromeHeightDip = h; g_contentTopDip = top; LayoutAll(); }
    }
    else if (a == L"newTab")         CreateTab(L"", true);
    else if (a == L"openInNewTab")   CreateTab(arg(1), true);
    else if (a == L"closeTab")       CloseTab(_wtoi(arg(1).c_str()));
    else if (a == L"selectTab")      SelectTab(_wtoi(arg(1).c_str()));
    else if (a == L"reorderTabs")    ReorderTabs(arg(1));
    else if (a == L"navigate")       { NavigateActive(ResolveQuery(arg(1))); FocusActiveTab(); }
    else if (a == L"openBookmark")   { NavigateActive(arg(1)); FocusActiveTab(); }
    else if (a == L"removeBookmark") { for (size_t i = 0; i < g_bookmarks.size(); ++i) if (g_bookmarks[i].url == arg(1)) { g_bookmarks.erase(g_bookmarks.begin()+i); SaveBookmarks(); PushState(); break; } }
    else if (a == L"bookmarkToggle") ToggleBookmark();
    else if (a == L"addShortcut")    AddShortcut(arg(1), arg(2));
    else if (a == L"removeShortcut") RemoveShortcut(arg(1));
    else if (a == L"setTheme")       SetTheme(arg(1));
    else if (a == L"back")           { Tab* t = ActiveTab(); if (t && t->view) t->view->GoBack(); FocusActiveTab(); }
    else if (a == L"forward")        { Tab* t = ActiveTab(); if (t && t->view) t->view->GoForward(); FocusActiveTab(); }
    else if (a == L"reload")         { Tab* t = ActiveTab(); if (t && t->view) t->view->Reload(); FocusActiveTab(); }
    else if (a == L"home")           { NavigateActive(kHomeUrl); FocusActiveTab(); }
    else if (a == L"toggleMaximize") { if (g_stateCallback) g_stateCallback(L"{\"type\":\"browserExpand\"}"); }
    // ----- Panneau / Parametres -----
    else if (a == L"togglePanel")    TogglePanel();
    else if (a == L"closePanel")     ClosePanel();
    else if (a == L"panelReady")     { PushPanelState(); if (g_pendingPanelHistory) { SendPanelHistory(); g_pendingPanelHistory = false; } }
    else if (a == L"getHistory")     SendPanelHistory();
    else if (a == L"openHistory")    { ClosePanel(); NavigateActive(arg(1)); }
    else if (a == L"removeHistory")  RemoveHistoryUrl(arg(1));
    else if (a == L"clearHistory")   { g_history.clear(); SaveHistory(); SendPanelHistory(); PushPanelState(); }
    else if (a == L"clearBookmarks") { g_bookmarks.clear(); SaveBookmarks(); PushState(); PushPanelState(); }
    else if (a == L"setOffline")     { g_offline = (arg(1) == L"1"); SaveSettings(); PushState(); PushPanelState(); }
    else if (a == L"setShowBookmarks") { g_showBookmarks = (arg(1) == L"1"); SaveSettings(); PushState(); PushPanelState(); }
    else if (a == L"setHistoryEnabled") { g_historyEnabled = (arg(1) == L"1"); SaveSettings(); PushPanelState(); }
    else if (a == L"setBlockPopups") { g_blockPopups = (arg(1) == L"1"); SaveSettings(); PushPanelState(); }
    else if (a == L"setContextMenus") { g_contextMenus = (arg(1) == L"1"); SaveSettings(); ApplyAllWebSettings(); PushPanelState(); }
    else if (a == L"setDevTools")    { g_devTools = (arg(1) == L"1"); SaveSettings(); ApplyAllWebSettings(); PushPanelState(); }
    else if (a == L"setStatusBar")   { g_statusBar = (arg(1) == L"1"); SaveSettings(); ApplyAllWebSettings(); PushPanelState(); }
    else if (a == L"setZoomControls") { g_zoomControls = (arg(1) == L"1"); SaveSettings(); ApplyAllWebSettings(); PushPanelState(); }
    else if (a == L"setSafeSearch")  { g_safeSearch = (arg(1) == L"1"); SaveSettings(); PushPanelState(); }
    else if (a == L"setSearchEngine") SetSearchEngine(arg(1));
    else if (a == L"setZoomPct")     SetZoomPct(_wtoi(arg(1).c_str()));
    else if (a == L"resetSettings")  ResetSettings();
    else if (a == L"getMediaState")  QueryMediaState();
    else if (a == L"mediaCommand")   { RunMediaCommand(arg(1), _wtoi(arg(2).c_str())); QueryMediaState(); }
    else if (a == L"mediaState")     { if (g_chromeView) g_chromeView->PostWebMessageAsJson(arg(1).c_str()); }
}

// ----- Initialisation WebView2 ----------------------------------------------

static void SetupVirtualHost(ICoreWebView2* view)
{
    ComPtr<ICoreWebView2_3> v3;
    if (SUCCEEDED(view->QueryInterface(IID_PPV_ARGS(&v3))) && !g_homeFolder.empty())
        v3->SetVirtualHostNameToFolderMapping(L"zaalis.home", g_homeFolder.c_str(),
            COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
}

static void InitializeWebView()
{
    const wchar_t* userDataDir = g_webViewDataFolder.empty() ? nullptr : g_webViewDataFolder.c_str();
    CreateCoreWebView2EnvironmentWithOptions(nullptr, userDataDir, nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [](HRESULT result, ICoreWebView2Environment* env) -> HRESULT
            {
                if (g_closing) return S_OK;
                if (FAILED(result) || !env) { g_error = L"Initialisation WebView2 impossible"; PushHostState(); return result; }
                g_env = env;

                // 1) Controleur de la chrome (barre du haut).
                g_env->CreateCoreWebView2Controller(g_hwnd,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [](HRESULT res, ICoreWebView2Controller* controller) -> HRESULT
                        {
                            if (g_closing) { if (controller) controller->Close(); return S_OK; }
                if (FAILED(res) || !controller) { g_error = L"Creation WebView2 impossible"; PushHostState(); return res; }
                            g_chromeController = controller;
                            g_chromeController->get_CoreWebView2(&g_chromeView);
                            ApplyScaleTo(controller);
                            ApplyBackground(controller, true);
                            RegisterAccelerators(controller);
                            SetupVirtualHost(g_chromeView.Get());
                            ApplyWebSettings(g_chromeView.Get());

                            EventRegistrationToken tok;
                            g_chromeView->add_WebMessageReceived(
                                Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                                    [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                                        LPWSTR m = nullptr;
                                        if (SUCCEEDED(args->TryGetWebMessageAsString(&m)) && m) { HandleMessage(m); CoTaskMemFree(m); }
                                        return S_OK;
                                    }).Get(), &tok);

                            g_chromeView->Navigate(kChromeUrl);

                            // 2) Premier onglet (page d'accueil).
                            CreateTab(L"", true);
                            LayoutAll();
                            return S_OK;
                        }).Get());
                return S_OK;
            }).Get());
}

// ----- Procedure de fenetre -------------------------------------------------

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg)
    {
        case WM_SIZE:
            LayoutAll();
            return 0;

        case WM_ACTIVATE:
            // Quand la fenetre (re)devient active, on rend le focus au contenu
            // pour qu'un seul clic suffise a interagir avec la page.
            if (LOWORD(wParam) != WA_INACTIVE)
                FocusActiveTab();
            return DefWindowProcW(hwnd, msg, wParam, lParam);

        case WM_TIMER:
            if (wParam == kPanelTimer)
            {
                ULONGLONG elapsed = GetTickCount64() - g_panelAnimStart;
                double t = (double)elapsed / (double)kPanelAnimDurationMs;
                if (t >= 1.0)
                {
                    g_panelP = g_panelAnimTo;
                    KillTimer(hwnd, kPanelTimer);
                }
                else
                {
                    double inv = 1.0 - t;
                    double eased = 1.0 - inv * inv * inv;
                    g_panelP = g_panelAnimFrom + (g_panelAnimTo - g_panelAnimFrom) * eased;
                }
                UpdatePanelBounds();
            }
            return 0;

        case WM_DPICHANGED:
        {
            RECT* s = reinterpret_cast<RECT*>(lParam);
            SetWindowPos(hwnd, nullptr, s->left, s->top, s->right - s->left, s->bottom - s->top,
                         SWP_NOZORDER | SWP_NOACTIVATE);
            ApplyScaleTo(g_chromeController.Get());
            for (auto& t : g_tabs) ApplyScaleTo(t.controller.Get());
            LayoutAll();
            return 0;
        }

        case WM_DESTROY:
            g_closing = true;
            g_pendingMessages.clear();
            for (auto& t : g_tabs) if (t.controller) t.controller->Close();
            g_tabs.clear();
            if (g_panelController) g_panelController->Close();
            g_panelController = nullptr; g_panelView = nullptr;
            if (g_chromeController) g_chromeController->Close();
            g_chromeController = nullptr; g_chromeView = nullptr;
            g_hwnd = nullptr;
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static void PushHostState()
{
    if (!g_stateCallback || g_closing) return;
    Tab* active = ActiveTab();
    BOOL back = FALSE, forward = FALSE;
    if (active && active->view) {
        active->view->get_CanGoBack(&back);
        active->view->get_CanGoForward(&forward);
    }
    std::wstring json = L"{\"type\":\"browserState\",\"available\":true,\"engine\":\"zaalis-webview2\",\"visible\":";
    json += g_visible ? L"true" : L"false";
    json += L",\"ready\":";
    json += g_webviewReady ? L"true" : L"false";
    json += L",\"activeTabId\":" + std::to_wstring(active ? active->id : -1);
    json += L",\"canGoBack\":"; json += back ? L"true" : L"false";
    json += L",\"canGoForward\":"; json += forward ? L"true" : L"false";
    json += L",\"tabs\":[";
    for (size_t i = 0; i < g_tabs.size(); ++i) {
        if (i) json += L",";
        const auto& tab = g_tabs[i];
        json += L"{\"id\":" + std::to_wstring(tab.id) + L",\"title\":\"" +
            JsonEscape(GetViewString(tab.view.Get(), false)) + L"\",\"url\":\"" +
            JsonEscape(GetViewString(tab.view.Get(), true)) + L"\",\"active\":";
        json += active && tab.id == active->id ? L"true" : L"false";
        json += L",\"loading\":"; json += tab.loading ? L"true" : L"false";
        json += L"}";
    }
    json += L"],\"error\":\"" + JsonEscape(g_error) + L"\"}";
    g_stateCallback(json);
}

static void FlushPendingMessages()
{
    g_webviewReady = true;
    std::vector<std::wstring> pending;
    pending.swap(g_pendingMessages);
    for (const auto& message : pending) Dispatch(message);
    PushHostState();
}

bool Initialize(HWND parent, StateCallback stateCallback)
{
    if (g_hwnd) return true;
    g_closing = false;
    g_stateCallback = std::move(stateCallback);
    g_homeFolder = WriteServedFiles();
    g_dataFolder = DataFolder();
    g_webViewDataFolder = WebViewDataFolder();
    LoadSettings();
    WNDCLASSW wc{};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
    wc.lpszClassName = kWindowClass;
    RegisterClassW(&wc);
    g_hwnd = CreateWindowExW(0, kWindowClass, L"zaalis browser", WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
        0, 0, 0, 0, parent, nullptr, wc.hInstance, nullptr);
    if (!g_hwnd) { g_error = L"Creation du panneau navigateur impossible"; PushHostState(); return false; }
    // Lazily initialize WebView2 on the first visible show command.
    return true;
}

void Dispatch(const std::wstring& json)
{
    if (g_closing || !g_hwnd || json.size() > 32768) return;
    using namespace winrt::Windows::Data::Json;
    try {
        JsonObject message = JsonObject::Parse(json);
        if (message.GetNamedString(L"type", L"") != L"browser") return;
        std::wstring action(message.GetNamedString(L"action", L"state"));
        if (action == L"bounds" || action == L"show") {
            if (message.HasKey(L"bounds")) {
                auto bounds = message.GetNamedObject(L"bounds");
                const double scale = message.GetNamedNumber(L"devicePixelRatio", DpiScale());
                if (!std::isfinite(scale) || scale < 0.25 || scale > 8) return;
                auto coordinate = [&](const wchar_t* name) {
                    double value = bounds.GetNamedNumber(name, 0) * scale;
                    if (!std::isfinite(value)) throw std::invalid_argument("bounds");
                    return static_cast<LONG>(std::clamp(value, -32768.0, 32768.0));
                };
                RECT parent{}; GetClientRect(GetParent(g_hwnd), &parent);
                LONG x = coordinate(L"x"), y = coordinate(L"y");
                LONG right = std::clamp(x + std::max<LONG>(0, coordinate(L"width")), 0L, parent.right);
                LONG bottom = std::clamp(y + std::max<LONG>(0, coordinate(L"height")), 0L, parent.bottom);
                x = std::clamp(x, 0L, parent.right); y = std::clamp(y, 0L, parent.bottom);
                SetWindowPos(g_hwnd, HWND_TOP, x, y, std::max<LONG>(0, right-x), std::max<LONG>(0, bottom-y), SWP_NOACTIVATE);
            }
            if (action == L"show") {
                g_visible = true;
                ShowWindow(g_hwnd, SW_SHOWNOACTIVATE);
                static bool started = false;
                if (!started) { started = true; InitializeWebView(); }
                std::wstring url(message.GetNamedString(L"url", L""));
                if (!url.empty()) {
                    JsonObject navigate;
                    navigate.SetNamedValue(L"type", JsonValue::CreateStringValue(L"browser"));
                    navigate.SetNamedValue(L"action", JsonValue::CreateStringValue(L"navigate"));
                    navigate.SetNamedValue(L"url", JsonValue::CreateStringValue(url));
                    Dispatch(std::wstring(navigate.Stringify()));
                }
            }
            PushHostState();
            return;
        }
        if (action == L"hide") { g_visible = false; ShowWindow(g_hwnd, SW_HIDE); PushHostState(); return; }
        if (action == L"state") { PushHostState(); return; }
        if (!g_webviewReady) {
            if (g_pendingMessages.size() < 128) g_pendingMessages.push_back(json);
            return;
        }
        if (action == L"navigate" || action == L"newTab") {
            std::wstring url(message.GetNamedString(L"url", L""));
            if (url.size() > 16384 || url.find(SEP) != std::wstring::npos) return;
            url = ResolveQuery(url);
            if (!(StartsWith(url, L"http://") || StartsWith(url, L"https://") || url == L"about:blank")) return;
            g_error.clear();
            if (action == L"newTab") CreateTab(url, true); else NavigateActive(url);
        } else if (action == L"closeTab" || action == L"close" || action == L"selectTab") {
            int tabId = static_cast<int>(message.GetNamedNumber(L"tabId", -1));
            if (action == L"selectTab") SelectTab(tabId); else CloseTab(tabId);
        } else if (action == L"back" || action == L"forward" || action == L"reload" || action == L"home") {
            HandleMessage(action);
        }
        PushHostState();
    } catch (...) {
        g_error = L"Commande navigateur invalide";
        PushHostState();
    }
}

void UpdateDpi()
{
    if (!g_hwnd) return;
    ApplyScaleTo(g_chromeController.Get());
    ApplyScaleTo(g_panelController.Get());
    for (auto& tab : g_tabs) ApplyScaleTo(tab.controller.Get());
    LayoutAll();
}

void Shutdown()
{
    g_stateCallback = nullptr;
    if (g_hwnd) DestroyWindow(g_hwnd);
    g_env = nullptr;
}
} // namespace ZaalisBrowser
