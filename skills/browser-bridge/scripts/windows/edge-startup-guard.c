#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdint.h>
#include <delayimp.h>

typedef struct {
    DWORD pid, thread, ready, error;
    DWORD slots, restored, blocked, events, mask;
    ULONGLONG deadline;
} State;
typedef struct Patch { void **slot; void *original, *replacement; struct Patch *next; } Patch;
static State *state;
static Patch *patches;
static HHOOK messages, cbt;
static HMODULE own_module;

static BOOL protected_window(HWND hwnd) {
    if (!state || !state->ready || GetTickCount64() >= state->deadline) return FALSE;
    wchar_t name[64];
    HWND root = GetAncestor(hwnd, GA_ROOT);
    DWORD pid = 0;
    GetWindowThreadProcessId(root, &pid);
    return pid == GetCurrentProcessId() && GetClassNameW(root, name, 64) &&
        lstrcmpW(name, L"Chrome_WidgetWin_1") == 0;
}
static HWND behind_foreground(void) {
    HWND foreground = GetForegroundWindow();
    DWORD pid = 0;
    GetWindowThreadProcessId(foreground, &pid);
    return foreground && pid != GetCurrentProcessId() ? foreground : HWND_BOTTOM;
}
static BOOL WINAPI guarded_foreground(HWND hwnd) {
    if (protected_window(hwnd)) { state->blocked++; return TRUE; }
    return SetForegroundWindow(hwnd);
}
static HWND WINAPI guarded_active(HWND hwnd) {
    if (protected_window(hwnd)) { state->blocked++; return GetActiveWindow(); }
    return SetActiveWindow(hwnd);
}
static BOOL WINAPI guarded_position(HWND hwnd, HWND after, int x, int y, int width, int height, UINT flags) {
    if (protected_window(hwnd)) {
        state->blocked++;
        flags |= SWP_NOACTIVATE;
        if (!(flags & SWP_NOZORDER)) after = behind_foreground();
    }
    return SetWindowPos(hwnd, after, x, y, width, height, flags);
}
static int inactive_show(int command) {
    switch (command) {
    case SW_SHOWNORMAL: case SW_SHOWMAXIMIZED: case SW_SHOW: case SW_RESTORE: case SW_SHOWDEFAULT:
        return SW_SHOWNA;
    default: return command;
    }
}
static BOOL WINAPI guarded_show(HWND hwnd, int command) {
    if (protected_window(hwnd)) { state->blocked++; command = inactive_show(command); }
    return ShowWindow(hwnd, command);
}
static BOOL WINAPI guarded_show_async(HWND hwnd, int command) {
    if (protected_window(hwnd)) { state->blocked++; command = inactive_show(command); }
    return ShowWindowAsync(hwnd, command);
}
static BOOL WINAPI guarded_top(HWND hwnd) {
    if (protected_window(hwnd)) {
        state->blocked++;
        return SetWindowPos(hwnd, behind_foreground(), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
    }
    return BringWindowToTop(hwnd);
}
static BOOL WINAPI guarded_placement(HWND hwnd, const WINDOWPLACEMENT *placement) {
    if (protected_window(hwnd) && placement) {
        state->blocked++;
        WINDOWPLACEMENT copy = *placement;
        copy.showCmd = inactive_show(copy.showCmd);
        return SetWindowPlacement(hwnd, &copy);
    }
    return SetWindowPlacement(hwnd, placement);
}
static void WINAPI guarded_switch(HWND hwnd, BOOL alt_tab) {
    if (protected_window(hwnd)) { state->blocked++; return; }
    SwitchToThisWindow(hwnd, alt_tab);
}
typedef struct { const char *name; void *replacement; } Target;
static const Target targets[] = {
    {"SetForegroundWindow", guarded_foreground}, {"SetActiveWindow", guarded_active},
    {"SetWindowPos", guarded_position}, {"ShowWindow", guarded_show},
    {"ShowWindowAsync", guarded_show_async}, {"BringWindowToTop", guarded_top},
    {"SetWindowPlacement", guarded_placement}, {"SwitchToThisWindow", guarded_switch}
};
static BOOL exchange_slot(void **slot, void *value) {
    DWORD old, ignored;
    if (!VirtualProtect(slot, sizeof(void *), PAGE_READWRITE, &old)) return FALSE;
    InterlockedExchangePointer((PVOID volatile *)slot, value);
    return VirtualProtect(slot, sizeof(void *), old, &ignored);
}
static void patch_table(BYTE *base, DWORD names_rva, DWORD slots_rva) {
    IMAGE_THUNK_DATA *names = (IMAGE_THUNK_DATA *)(base + names_rva);
    IMAGE_THUNK_DATA *slots = (IMAGE_THUNK_DATA *)(base + slots_rva);
    for (; names->u1.AddressOfData; names++, slots++) {
        if (IMAGE_SNAP_BY_ORDINAL(names->u1.Ordinal)) continue;
        IMAGE_IMPORT_BY_NAME *import = (IMAGE_IMPORT_BY_NAME *)(base + names->u1.AddressOfData);
        for (SIZE_T i = 0; i < sizeof(targets) / sizeof(targets[0]); i++) {
            if (lstrcmpA((const char *)import->Name, targets[i].name)) continue;
            Patch *entry = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(Patch));
            if (!entry) { state->error = ERROR_NOT_ENOUGH_MEMORY; return; }
            entry->slot = (void **)&slots->u1.Function;
            entry->original = (void *)(uintptr_t)slots->u1.Function;
            entry->replacement = targets[i].replacement;
            entry->next = patches;
            patches = entry;
            if (!exchange_slot(entry->slot, entry->replacement)) { state->error = GetLastError(); return; }
            state->slots++;
            state->mask |= (DWORD)1 << i;
        }
    }
}
static void patch_imports(HMODULE module) {
    if (!module) { state->error = ERROR_MOD_NOT_FOUND; return; }
    BYTE *base = (BYTE *)module;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) { state->error = ERROR_BAD_EXE_FORMAT; return; }
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    DWORD rva = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
    if (rva) {
        IMAGE_IMPORT_DESCRIPTOR *descriptor = (IMAGE_IMPORT_DESCRIPTOR *)(base + rva);
        for (; descriptor->Name; descriptor++) {
            if (descriptor->OriginalFirstThunk) patch_table(base, descriptor->OriginalFirstThunk, descriptor->FirstThunk);
        }
    }
    rva = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT].VirtualAddress;
    if (rva) {
        ImgDelayDescr *descriptor = (ImgDelayDescr *)(base + rva);
        for (; descriptor->rvaDLLName; descriptor++) {
            if (descriptor->grAttrs & dlattrRva) patch_table(base, descriptor->rvaINT, descriptor->rvaIAT);
        }
    }
}
static LRESULT CALLBACK startup_cbt(int code, WPARAM wp, LPARAM lp) {
    if (code == HCBT_ACTIVATE && protected_window((HWND)wp)) {
        state->blocked++;
        return 1;
    }
    if (code == HCBT_CREATEWND && protected_window((HWND)wp)) {
        CBT_CREATEWNDW *create = (CBT_CREATEWNDW *)lp;
        create->hwndInsertAfter = HWND_BOTTOM;
    }
    return CallNextHookEx(NULL, code, wp, lp);
}
static LRESULT CALLBACK startup_messages(int code, WPARAM wp, LPARAM lp) {
    if (code == HC_ACTION && wp == PM_REMOVE) {
        MSG *message = (MSG *)lp;
        if (message->message == WM_NULL && message->wParam == 0xB04C) {
            state->ready = 0;
            for (Patch *entry = patches; entry; entry = entry->next) {
                if (*entry->slot == entry->replacement && exchange_slot(entry->slot, entry->original)) state->restored++;
                else state->error = ERROR_INVALID_DATA;
            }
            if (cbt && !UnhookWindowsHookEx(cbt)) state->error = GetLastError();
            if (messages && !UnhookWindowsHookEx(messages)) state->error = GetLastError();
            wchar_t name[128];
            wsprintfW(name, L"Local\\BrowserBridgeStartupStopped_%lu", GetCurrentProcessId());
            HANDLE stopped = OpenEventW(EVENT_MODIFY_STATE, FALSE, name);
            if (stopped) { SetEvent(stopped); CloseHandle(stopped); }
        }
    }
    return CallNextHookEx(NULL, code, wp, lp);
}
__declspec(dllexport) void CALLBACK StartupEventProc(HWINEVENTHOOK hook, DWORD event, HWND hwnd,
                                                   LONG object, LONG child, DWORD thread, DWORD time) {
    (void)hook; (void)time;
    if (event != EVENT_OBJECT_CREATE || object != OBJID_WINDOW || child != CHILDID_SELF) return;
    wchar_t name[128], class_name[64];
    if (!GetClassNameW(hwnd, class_name, 64) ||
        (lstrcmpW(class_name, L"Chrome_MessageWindow") && lstrcmpW(class_name, L"Chrome_WidgetWin_1"))) return;
    if (!state) {
        wsprintfW(name, L"Local\\BrowserBridgeStartupGuard_%lu", GetCurrentProcessId());
        HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
        if (!mapping) return;
        state = MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(State));
        CloseHandle(mapping);
        if (!state) return;
    }
    state->events++;
    if (state->pid != GetCurrentProcessId() || state->thread || GetTickCount64() >= state->deadline) return;
    state->thread = thread;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                           (LPCWSTR)(uintptr_t)&StartupEventProc, &own_module)) {
        state->error = GetLastError(); return;
    }
    cbt = SetWindowsHookExW(WH_CBT, startup_cbt, own_module, thread);
    messages = SetWindowsHookExW(WH_GETMESSAGE, startup_messages, own_module, thread);
    if (!cbt || !messages) { state->error = GetLastError(); return; }
    patch_imports(GetModuleHandleW(L"msedge.dll"));
    // Chromium's startup Show/Activate path uses these three APIs directly.
    if ((state->mask & 0x0D) != 0x0D && !state->error) state->error = ERROR_PROC_NOT_FOUND;
    state->ready = 1;
}
