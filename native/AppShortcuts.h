#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
// Browser tabs keep Ctrl+W for their own tab; other app commands are shared.
inline const wchar_t* AppCommand(UINT key, bool ctrl, bool shift, bool alt, bool browser = false) {
    if (!ctrl || alt) return nullptr;
    if (shift) {
        if (key == 'P') return L"palette";
        if (key == 'E') return L"mode";
        return nullptr;
    }
    switch (key) {
        case VK_OEM_COMMA: return L"settings";
        case 'N': return L"new-chat";
        case 'O': return L"open-folder";
        case 'B': return L"sidebar";
        case 'W': return browser ? nullptr : L"close-tab";
        default: return nullptr;
    }
}
