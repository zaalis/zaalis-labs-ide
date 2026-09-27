#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <functional>
#include <string>

// Native half of the integrated zaalis Browser.
//
// The browser's logic is the vendored zaalis Browser main process running in
// zaalis-server (zaalis-browser/host.js). This side owns the WebView2 views and
// executes what that process asks for, over a private named pipe created by
// PrepareChannel() before the server starts.
//
// All calls and callbacks run on the shell's WebView2 STA thread.
namespace ZaalisBrowser {
using StateCallback = std::function<void(const std::wstring&)>;
// Creates the owner-only pipe and publishes its name and one-time token in the
// environment inherited by zaalis-server. Call before launching the server.
bool PrepareChannel();
bool Initialize(HWND parent, StateCallback stateCallback);
void Dispatch(const std::wstring& json);
void UpdateDpi();
void Shutdown();
}
