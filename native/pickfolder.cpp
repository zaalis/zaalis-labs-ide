// Modern Windows folder picker (IFileOpenDialog) — prints the chosen
// folder path (UTF-8) to stdout, or nothing if the user cancels.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shobjidl.h>
#include <string>
#include <cstdio>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "uuid.lib")

int wmain() {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    IFileOpenDialog* dlg = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_FileOpenDialog, nullptr,
                                  CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg));
    if (SUCCEEDED(hr)) {
        DWORD opts = 0;
        dlg->GetOptions(&opts);
        dlg->SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
        // Show the dialog in front of the app window (otherwise it can open behind it).
        HWND owner = FindWindowW(L"zaalisWindow", nullptr);
        if (SUCCEEDED(dlg->Show(owner))) {
            IShellItem* item = nullptr;
            if (SUCCEEDED(dlg->GetResult(&item))) {
                PWSTR path = nullptr;
                if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) {
                    int len = WideCharToMultiByte(CP_UTF8, 0, path, -1, nullptr, 0, nullptr, nullptr);
                    if (len > 0) {
                        std::string out(len, '\0');
                        WideCharToMultiByte(CP_UTF8, 0, path, -1, &out[0], len, nullptr, nullptr);
                        fputs(out.c_str(), stdout);
                    }
                    CoTaskMemFree(path);
                }
                item->Release();
            }
        }
        dlg->Release();
    }
    CoUninitialize();
    return 0;
}
