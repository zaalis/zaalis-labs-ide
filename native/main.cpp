// =====================================================================
//  zaalis IDE — native Windows shell (C++ + WebView2)
//  - Launches the bundled Node server (zaalis-server.exe) in a Job Object
//    so it is killed automatically when this app closes (even on crash).
//  - Waits for the server to be ready, then shows the UI in a WebView2.
// =====================================================================
#define WIN32_LEAN_AND_MEAN   // prevent windows.h from pulling in winsock 1
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <dwmapi.h>
#include <shlobj.h>
#include <wrl.h>
#include "WebView2.h"
#include <string>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "dwmapi.lib")

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif
#ifndef DWMWA_CAPTION_COLOR
#define DWMWA_CAPTION_COLOR 35
#endif
#ifndef DWMWA_TEXT_COLOR
#define DWMWA_TEXT_COLOR 36
#endif

using namespace Microsoft::WRL;

static const wchar_t* APP_URL      = L"http://localhost:3000";
static const wchar_t* WINDOW_TITLE = L"zaalis IDE";
static const wchar_t* SERVER_EXE   = L"zaalis-server.exe";
static const int      SERVER_PORT  = 3000;

static ComPtr<ICoreWebView2Controller> g_controller;
static ComPtr<ICoreWebView2>           g_webview;
static HANDLE                          g_job = nullptr;

// Folder containing this executable.
static std::wstring ExeDir() {
    wchar_t buf[MAX_PATH];
    GetModuleFileNameW(nullptr, buf, MAX_PATH);
    std::wstring p(buf);
    size_t pos = p.find_last_of(L"\\/");
    return (pos == std::wstring::npos) ? L"." : p.substr(0, pos);
}

// Stable per-user WebView2 profile folder (%LOCALAPPDATA%\zaalis\WebView2).
// Without an explicit folder, WebView2 stores cookies/localStorage next to the
// exe, which is wiped on every update — logging the user out each time.
static std::wstring WebViewDataDir() {
    std::wstring dir;
    PWSTR localAppData = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &localAppData))) {
        dir = localAppData;
        CoTaskMemFree(localAppData);
    } else {
        dir = ExeDir();
    }
    dir += L"\\zaalis\\WebView2";
    SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
    return dir;
}

// Launch the Node server inside a Job Object marked KILL_ON_JOB_CLOSE.
static bool LaunchServer() {
    g_job = CreateJobObjectW(nullptr, nullptr);
    if (g_job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = {};
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
            JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &info, sizeof(info));
    }

    std::wstring exe = ExeDir() + L"\\" + SERVER_EXE;
    std::wstring cmd = L"\"" + exe + L"\"";

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {};
    // Create suspended so the child can be assigned to the job before it runs.
    BOOL ok = CreateProcessW(
        exe.c_str(), &cmd[0],
        nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED,
        nullptr, ExeDir().c_str(),
        &si, &pi);
    if (!ok) return false;

    if (g_job) AssignProcessToJobObject(g_job, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return true;
}

// Poll the server port until it accepts connections (or timeout).
static bool WaitForServer(int timeoutMs) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;

    bool up = false;
    int waited = 0;
    while (waited < timeoutMs) {
        SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (s != INVALID_SOCKET) {
            sockaddr_in addr = {};
            addr.sin_family = AF_INET;
            addr.sin_port = htons((u_short)SERVER_PORT);
            InetPtonW(AF_INET, L"127.0.0.1", &addr.sin_addr);
            if (connect(s, (sockaddr*)&addr, sizeof(addr)) == 0) {
                up = true;
                closesocket(s);
                break;
            }
            closesocket(s);
        }
        Sleep(200);
        waited += 200;
    }
    WSACleanup();
    return up;
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM w, LPARAM l) {
    switch (msg) {
    case WM_SIZE:
        if (g_controller) {
            RECT rc; GetClientRect(hwnd, &rc);
            g_controller->put_Bounds(rc);
        }
        return 0;
    case WM_DPICHANGED: {
        // Windows suggests a new window rect when DPI changes (e.g. moved to a 4K screen).
        RECT* prc = reinterpret_cast<RECT*>(l);
        SetWindowPos(hwnd, nullptr, prc->left, prc->top,
                     prc->right - prc->left, prc->bottom - prc->top,
                     SWP_NOZORDER | SWP_NOACTIVATE);
        return 0;
    }
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, w, l);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR, int) {
    // 0) Crisp rendering on high-DPI / 4K screens (must be set before any window).
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    // 1) Start the bundled server and wait until it answers.
    LaunchServer();
    if (!WaitForServer(20000)) {
        MessageBoxW(nullptr,
            L"Le serveur zaalis n'a pas demarre.\nVerifiez que zaalis-server.exe est present a cote de l'application.",
            L"zaalis IDE", MB_ICONERROR | MB_OK);
        if (g_job) CloseHandle(g_job);
        return 1;
    }

    // 2) Create the main window.
    HICON appIcon = LoadIconW(hInst, MAKEINTRESOURCEW(1)); // icon embedded via app.rc

    WNDCLASSW wc = {};
    wc.lpfnWndProc   = WndProc;
    wc.hInstance     = hInst;
    wc.lpszClassName = L"zaalisWindow";
    wc.hCursor       = LoadCursor(nullptr, IDC_ARROW);
    wc.hIcon         = appIcon;
    RegisterClassW(&wc);

    HWND hwnd = CreateWindowExW(
        0, wc.lpszClassName, WINDOW_TITLE, WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 1280, 800,
        nullptr, nullptr, hInst, nullptr);

    // Match the title bar to the IDE's dark background (Windows 10 2004+/11).
    BOOL dark = TRUE;
    DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
    COLORREF caption = RGB(0x0f, 0x0f, 0x12); // IDE background
    COLORREF textcol = RGB(0xe5, 0xe5, 0xe5);
    DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, &caption, sizeof(caption));
    DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, &textcol, sizeof(textcol));

    ShowWindow(hwnd, SW_SHOWMAXIMIZED);

    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    // 3) Create the WebView2 and navigate to the local app.
    std::wstring userDataDir = WebViewDataDir();
    CreateCoreWebView2EnvironmentWithOptions(nullptr, userDataDir.c_str(), nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [hwnd](HRESULT, ICoreWebView2Environment* env) -> HRESULT {
                if (!env) return S_OK;
                env->CreateCoreWebView2Controller(hwnd,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [hwnd](HRESULT, ICoreWebView2Controller* controller) -> HRESULT {
                            if (!controller) return S_OK;
                            g_controller = controller;
                            g_controller->get_CoreWebView2(&g_webview);
                            RECT rc; GetClientRect(hwnd, &rc);
                            g_controller->put_Bounds(rc);
                            g_webview->Navigate(APP_URL);
                            return S_OK;
                        }).Get());
                return S_OK;
            }).Get());

    // 4) Message loop.
    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    // 5) Closing the job kills the server (also happens on process exit).
    if (g_job) CloseHandle(g_job);
    CoUninitialize();
    return 0;
}
