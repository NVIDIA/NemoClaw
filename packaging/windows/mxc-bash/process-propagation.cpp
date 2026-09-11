// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "process-propagation.h"
#include <detours.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

namespace {
WCHAR moduleDirectory[MAX_PATH] = {};
alignas(SID) BYTE containerSid[SECURITY_MAX_SID_SIZE] = {};
BOOL initialized = FALSE;
__declspec(thread) BOOL withinCreate = FALSE;
decltype(&CreateProcessW) realCreateW = CreateProcessW;
decltype(&CreateProcessA) realCreateA = CreateProcessA;
decltype(&CreateProcessAsUserW) realCreateAsUserW = CreateProcessAsUserW;
decltype(&CreateProcessAsUserA) realCreateAsUserA = CreateProcessAsUserA;

BOOL processContainerSid(HANDLE process, BYTE* output) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return FALSE;
    DWORD appContainer = 0, needed = 0;
    alignas(TOKEN_APPCONTAINER_INFORMATION) BYTE buffer[sizeof(TOKEN_APPCONTAINER_INFORMATION) + SECURITY_MAX_SID_SIZE] = {};
    BOOL result = GetTokenInformation(token, TokenIsAppContainer, &appContainer,
                                     sizeof(appContainer), &needed);
    if (result && appContainer) {
        result = GetTokenInformation(token, TokenAppContainerSid, buffer, sizeof(buffer), &needed);
        if (result) {
            const auto info = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(buffer);
            result = info->TokenAppContainer && IsValidSid(info->TokenAppContainer)
                && GetLengthSid(info->TokenAppContainer) <= SECURITY_MAX_SID_SIZE
                && CopySid(SECURITY_MAX_SID_SIZE, output, info->TokenAppContainer);
        }
    } else {
        result = FALSE;
        SetLastError(ERROR_ACCESS_DENIED);
    }
    DWORD error = result ? ERROR_SUCCESS : GetLastError();
    if (!result && !error) error = ERROR_INVALID_SID;
    CloseHandle(token);
    SetLastError(error);
    return result;
}

void logPropagation(DWORD pid, USHORT machine, BOOL sameSid, BOOL inJob, BOOL injected, DWORD error) {
    char line[512];
    const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_PROPAGATION={\"schemaVersion\":1,\"parentPid\":%lu,\"childPid\":%lu,\"machine\":%u,\"sameAppContainer\":%s,\"inJob\":%s,\"injected\":%s,\"error\":%lu}\n",
        GetCurrentProcessId(), pid, static_cast<unsigned>(machine), sameSid ? "true" : "false",
        inJob ? "true" : "false", injected ? "true" : "false", error);
    DWORD written = 0;
    if (length > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
}

BOOL inject(HANDLE child) {
    alignas(SID) BYTE actualSid[SECURITY_MAX_SID_SIZE] = {};
    USHORT processMachine = 0, nativeMachine = 0;
    BOOL sameSid = initialized && processContainerSid(child, actualSid)
        && EqualSid(containerSid, actualSid);
    BOOL inJob = FALSE;
    BOOL jobKnown = IsProcessInJob(child, nullptr, &inJob);
    DWORD error = ERROR_ACCESS_DENIED;
    if (!sameSid || !jobKnown || !inJob) {
        logPropagation(GetProcessId(child), 0, sameSid, inJob, FALSE, error);
        SetLastError(error);
        return FALSE;
    }
    if (!IsWow64Process2(child, &processMachine, &nativeMachine)) return FALSE;
    USHORT machine = processMachine ? processMachine : nativeMachine;
    const WCHAR* file = machine == IMAGE_FILE_MACHINE_ARM64 ? L"NemoClawMsysCompat-arm64.dll"
        : machine == IMAGE_FILE_MACHINE_AMD64 ? L"NemoClawMsysCompat-x64.dll" : nullptr;
    if (!file) { SetLastError(ERROR_NOT_SUPPORTED); return FALSE; }
    WCHAR wide[MAX_PATH] = {};
    if (swprintf_s(wide, L"%s\\%s", moduleDirectory, file) < 0) {
        SetLastError(ERROR_BUFFER_OVERFLOW); return FALSE;
    }
    // PE import names are ANSI. The CI-owned compatibility directory is
    // deliberately bounded ASCII, so no locale-dependent path substitution.
    char dll[MAX_PATH] = {};
    size_t index = 0;
    for (; wide[index]; ++index) {
        if (wide[index] > 127 || wide[index] < 32) { SetLastError(ERROR_INVALID_NAME); return FALSE; }
        dll[index] = static_cast<char>(wide[index]);
    }
    DWORD attributes = GetFileAttributesW(wide);
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
        SetLastError(ERROR_INVALID_DATA); return FALSE;
    }
    const char* dlls[] = {dll};
    BOOL ok = DetourUpdateProcessWithDll(child, dlls, 1);
    error = ok ? ERROR_SUCCESS : GetLastError();
    if (!ok && !error) error = ERROR_DLL_INIT_FAILED;
    logPropagation(GetProcessId(child), machine, TRUE, TRUE, ok, error);
    SetLastError(error);
    return ok;
}

BOOL failedChild(PROCESS_INFORMATION* child, DWORD error) {
    if (!error) error = ERROR_DLL_INIT_FAILED;
    BOOL terminated = TerminateProcess(child->hProcess, error);
    DWORD terminationError = terminated ? 0 : GetLastError();
    DWORD waited = WaitForSingleObject(child->hProcess, 5000);
    char line[512];
    int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_FAILED_CHILD={\"schemaVersion\":1,\"childPid\":%lu,\"terminationRequested\":%s,\"terminationError\":%lu,\"waitResult\":%lu,\"closed\":%s}\n",
        child->dwProcessId, terminated ? "true" : "false", terminationError, waited,
        waited == WAIT_OBJECT_0 ? "true" : "false");
    DWORD written = 0;
    if (length > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
    if (waited == WAIT_OBJECT_0) {
        CloseHandle(child->hThread);
        CloseHandle(child->hProcess);
        ZeroMemory(child, sizeof(*child));
    }
    // An unconfirmed child is never resumed. Keep its handles until this
    // process/existing MXC job ends; the receipt makes that proof fail.
    SetLastError(error);
    return FALSE;
}

struct CreationScope {
    CreationScope() { withinCreate = TRUE; }
    ~CreationScope() { withinCreate = FALSE; }
};

BOOL allowed(LPPROCESS_INFORMATION output, DWORD flags) {
    if (!output) { SetLastError(ERROR_INVALID_PARAMETER); return FALSE; }
    if (flags & CREATE_BREAKAWAY_FROM_JOB) { SetLastError(ERROR_ACCESS_DENIED); return FALSE; }
    return TRUE;
}

BOOL WINAPI hookedCreateW(LPCWSTR app, LPWSTR args, LPSECURITY_ATTRIBUTES processAttributes,
    LPSECURITY_ATTRIBUTES threadAttributes, BOOL inherit, DWORD flags, LPVOID environment,
    LPCWSTR directory, LPSTARTUPINFOW startup, LPPROCESS_INFORMATION output) {
    if (withinCreate) return realCreateW(app,args,processAttributes,threadAttributes,inherit,flags,environment,directory,startup,output);
    if (!allowed(output, flags)) return FALSE;
    CreationScope scope;
    PROCESS_INFORMATION child = {};
    if (!realCreateW(app,args,processAttributes,threadAttributes,inherit,flags|CREATE_SUSPENDED,environment,directory,startup,&child)) return FALSE;
    if (!NemoClawCompleteSuspendedChild(&child, flags)) return FALSE;
    *output = child;
    return TRUE;
}

BOOL WINAPI hookedCreateA(LPCSTR app, LPSTR args, LPSECURITY_ATTRIBUTES processAttributes,
    LPSECURITY_ATTRIBUTES threadAttributes, BOOL inherit, DWORD flags, LPVOID environment,
    LPCSTR directory, LPSTARTUPINFOA startup, LPPROCESS_INFORMATION output) {
    if (withinCreate) return realCreateA(app,args,processAttributes,threadAttributes,inherit,flags,environment,directory,startup,output);
    if (!allowed(output, flags)) return FALSE;
    CreationScope scope;
    PROCESS_INFORMATION child = {};
    if (!realCreateA(app,args,processAttributes,threadAttributes,inherit,flags|CREATE_SUSPENDED,environment,directory,startup,&child)) return FALSE;
    if (!NemoClawCompleteSuspendedChild(&child, flags)) return FALSE;
    *output = child;
    return TRUE;
}

BOOL WINAPI hookedAsUserW(HANDLE token, LPCWSTR app, LPWSTR args, LPSECURITY_ATTRIBUTES processAttributes,
    LPSECURITY_ATTRIBUTES threadAttributes, BOOL inherit, DWORD flags, LPVOID environment,
    LPCWSTR directory, LPSTARTUPINFOW startup, LPPROCESS_INFORMATION output) {
    if (withinCreate) return realCreateAsUserW(token,app,args,processAttributes,threadAttributes,inherit,flags,environment,directory,startup,output);
    if (!allowed(output, flags)) return FALSE;
    CreationScope scope;
    PROCESS_INFORMATION child = {};
    if (!realCreateAsUserW(token,app,args,processAttributes,threadAttributes,inherit,flags|CREATE_SUSPENDED,environment,directory,startup,&child)) return FALSE;
    if (!NemoClawCompleteSuspendedChild(&child, flags)) return FALSE;
    *output = child;
    return TRUE;
}

BOOL WINAPI hookedAsUserA(HANDLE token, LPCSTR app, LPSTR args, LPSECURITY_ATTRIBUTES processAttributes,
    LPSECURITY_ATTRIBUTES threadAttributes, BOOL inherit, DWORD flags, LPVOID environment,
    LPCSTR directory, LPSTARTUPINFOA startup, LPPROCESS_INFORMATION output) {
    if (withinCreate) return realCreateAsUserA(token,app,args,processAttributes,threadAttributes,inherit,flags,environment,directory,startup,output);
    if (!allowed(output, flags)) return FALSE;
    CreationScope scope;
    PROCESS_INFORMATION child = {};
    if (!realCreateAsUserA(token,app,args,processAttributes,threadAttributes,inherit,flags|CREATE_SUSPENDED,environment,directory,startup,&child)) return FALSE;
    if (!NemoClawCompleteSuspendedChild(&child, flags)) return FALSE;
    *output = child;
    return TRUE;
}
}

extern "C" BOOL NemoClawInitializeProcessContext(HMODULE self) {
    if (initialized) return TRUE;
    if (!processContainerSid(GetCurrentProcess(), containerSid)) return FALSE;
    BOOL inJob = FALSE;
    if (!IsProcessInJob(GetCurrentProcess(), nullptr, &inJob) || !inJob) {
        SetLastError(ERROR_ACCESS_DENIED); return FALSE;
    }
    DWORD count = GetModuleFileNameW(self, moduleDirectory, MAX_PATH);
    if (!count || count >= MAX_PATH) { SetLastError(ERROR_BUFFER_OVERFLOW); return FALSE; }
    WCHAR* separator = wcsrchr(moduleDirectory, L'\\');
    if (!separator || moduleDirectory[1] != L':') { SetLastError(ERROR_INVALID_NAME); return FALSE; }
    *separator = 0;
    initialized = TRUE;
    return TRUE;
}

extern "C" BOOL NemoClawCompleteSuspendedChild(PROCESS_INFORMATION* child, DWORD callerFlags) {
    if (!inject(child->hProcess)) return failedChild(child, GetLastError());
    if (!(callerFlags & CREATE_SUSPENDED) && ResumeThread(child->hThread) == static_cast<DWORD>(-1))
        return failedChild(child, GetLastError());
    return TRUE;
}

extern "C" LONG NemoClawStageProcessPropagation() {
    if (!initialized) return ERROR_INVALID_STATE;
    LONG error = DetourAttach(reinterpret_cast<PVOID*>(&realCreateW), reinterpret_cast<PVOID>(hookedCreateW));
    if (!error) error = DetourAttach(reinterpret_cast<PVOID*>(&realCreateA), reinterpret_cast<PVOID>(hookedCreateA));
    if (!error) error = DetourAttach(reinterpret_cast<PVOID*>(&realCreateAsUserW), reinterpret_cast<PVOID>(hookedAsUserW));
    if (!error) error = DetourAttach(reinterpret_cast<PVOID*>(&realCreateAsUserA), reinterpret_cast<PVOID>(hookedAsUserA));
    return error;
}

extern "C" void NemoClawLogLaunch(DWORD childPid, DWORD exitCode, BOOL exited, DWORD error) {
    char line[512];
    int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_LAUNCH={\"schemaVersion\":1,\"parentPid\":%lu,\"childPid\":%lu,\"childExited\":%s,\"exitCode\":%lu,\"error\":%lu}\n",
        GetCurrentProcessId(), childPid, exited ? "true" : "false", exitCode, error);
    DWORD written = 0;
    if (length > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
}
