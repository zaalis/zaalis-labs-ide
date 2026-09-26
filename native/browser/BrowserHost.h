#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <functional>
#include <string>

// All calls and callbacks run on the shell's WebView2 STA thread.
namespace ZaalisBrowser {
using StateCallback = std::function<void(const std::wstring&)>;
bool Initialize(HWND parent, StateCallback stateCallback);
void Dispatch(const std::wstring& json);
void UpdateDpi();
void Shutdown();
}
