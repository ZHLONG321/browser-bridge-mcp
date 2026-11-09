#define UNICODE
#define _UNICODE
#include <windows.h>

#define READY_MESSAGE_TOKEN ((WPARAM)0xB04B)
#define EXISTING_PROPERTY L"BrowserBridgeFocusGuardExistingWindow"

__declspec(dllexport) LRESULT CALLBACK CbtGuardProc(int code, WPARAM wp, LPARAM lp) {
    if (code == HCBT_ACTIVATE) {
        HWND window = (HWND)wp;
        wchar_t class_name[64];
        if (GetClassNameW(window, class_name, 64) &&
            (lstrcmpW(class_name, L"MozillaWindowClass") == 0 ||
             lstrcmpW(class_name, L"Chrome_WidgetWin_1") == 0) &&
            !GetPropW(window, EXISTING_PROPERTY)) {
            return 1;
        }
    }
    return CallNextHookEx(NULL, code, wp, lp);
}

__declspec(dllexport) LRESULT CALLBACK ReadyProc(int code, WPARAM wp, LPARAM lp) {
    if (code == HC_ACTION && wp == PM_REMOVE) {
        const MSG *message = (const MSG *)lp;
        if (message->message == WM_NULL && message->wParam == READY_MESSAGE_TOKEN) {
            wchar_t event_name[128];
            wsprintfW(event_name, L"Local\\BrowserBridgeFocusGuardReady_%lu", GetCurrentThreadId());
            HANDLE ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, event_name);
            if (ready) {
                SetEvent(ready);
                CloseHandle(ready);
            }
        }
    }
    return CallNextHookEx(NULL, code, wp, lp);
}
