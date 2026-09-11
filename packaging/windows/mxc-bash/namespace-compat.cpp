// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <securityappcontainer.h>
#include <detours.h>
#include <stdio.h>
#include "namespace-path.h"
#include "namespace-security.h"
#include "process-propagation.h"

namespace {
using namespace nemoclaw_msys;
using DirectoryCall = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES);
DirectoryCall realCreate = nullptr;
DirectoryCall realOpen = nullptr;
WCHAR privateRoot[maximum_root_characters] = {};
size_t privateRootLength = 0;
DWORD ownSession = 0;
alignas(void*) BYTE worldSid[SECURITY_MAX_SID_SIZE] = {};
ScopedDescriptor privateDescriptor = {};
LONG emitted = 0;

// Fixed-size startup state, derived solely from the actual process token.
// This DLL intentionally fails to initialize outside an AppContainer.
bool initialize_namespace() {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    alignas(void*) BYTE containerBuffer[sizeof(TOKEN_APPCONTAINER_INFORMATION) + SECURITY_MAX_SID_SIZE] = {};
    alignas(void*) BYTE userBuffer[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE] = {};
    DWORD isContainer = 0, needed = 0;
    ULONG rootNeeded = 0;
    DWORD worldSize = sizeof(worldSid);
    bool success = GetTokenInformation(token, TokenIsAppContainer, &isContainer, sizeof(isContainer), &needed) &&
        isContainer == 1 &&
        GetTokenInformation(token, TokenAppContainerSid, containerBuffer, sizeof(containerBuffer), &needed) &&
        GetTokenInformation(token, TokenUser, userBuffer, sizeof(userBuffer), &needed) &&
        GetTokenInformation(token, TokenSessionId, &ownSession, sizeof(ownSession), &needed) &&
        GetAppContainerNamedObjectPath(token, nullptr, static_cast<ULONG>(maximum_root_characters), privateRoot, &rootNeeded) &&
        CreateWellKnownSid(WinWorldSid, nullptr, worldSid, &worldSize);
    if (success) {
        auto container = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(containerBuffer)->TokenAppContainer;
        auto user = reinterpret_cast<TOKEN_USER*>(userBuffer)->User.Sid;
        success = container && user && make_scoped_descriptor(user, container, privateDescriptor);
        while (privateRootLength < maximum_root_characters && privateRoot[privateRootLength]) ++privateRootLength;
        success = success && privateRootLength > 1 && privateRootLength < maximum_root_characters &&
            privateRoot[0] == L'\\' && privateRoot[privateRootLength - 1] != L'\\';
    }
    const DWORD error = GetLastError();
    CloseHandle(token);
    SetLastError(success ? ERROR_SUCCESS : (error ? error : ERROR_ACCESS_DENIED));
    if (!success) return false;
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) return false;
    realCreate = reinterpret_cast<DirectoryCall>(GetProcAddress(ntdll, "NtCreateDirectoryObject"));
    realOpen = reinterpret_cast<DirectoryCall>(GetProcAddress(ntdll, "NtOpenDirectoryObject"));
    return realCreate && realOpen;
}

bool not_impersonating() {
    HANDLE threadToken = nullptr;
    if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &threadToken))
        return GetLastError() == ERROR_NO_TOKEN;
    CloseHandle(threadToken);
    return false;
}

// Copy every caller-owned field while protected by SEH. Unsupported inputs go
// to the original API unchanged, including its ordinary parameter validation.
bool prepare(POBJECT_ATTRIBUTES input, ACCESS_MASK access, bool create,
             OBJECT_ATTRIBUTES& attributes, UNICODE_STRING& targetName,
             WCHAR* target, Match& match) {
    __try {
        if (!input || input->Length != sizeof(OBJECT_ATTRIBUTES) || input->RootDirectory ||
            !input->ObjectName || !input->ObjectName->Buffer ||
            input->ObjectName->Length % sizeof(WCHAR) ||
            input->ObjectName->Length > input->ObjectName->MaximumLength ||
            input->ObjectName->Length > maximum_source_characters * sizeof(WCHAR)) return false;
        attributes = *input;
        const size_t count = input->ObjectName->Length / sizeof(WCHAR);
        WCHAR source[maximum_source_characters] = {};
        for (size_t n = 0; n < count; ++n) source[n] = input->ObjectName->Buffer[n];
        match = match_name(source, count, ownSession);
        if (match.family == Family::none) return false;
        if (create && (access != directory_access || attributes.Attributes != OBJ_OPENIF ||
                       !is_msys_directory_descriptor(attributes.SecurityDescriptor, worldSid))) return false;
        const size_t size = mapped_name(match, ownSession, privateRoot, privateRootLength,
                                        target, maximum_target_characters);
        if (!size) return false;
        targetName.Buffer = target;
        targetName.Length = static_cast<USHORT>(size * sizeof(WCHAR));
        targetName.MaximumLength = static_cast<USHORT>((size + 1) * sizeof(WCHAR));
        attributes.ObjectName = &targetName;
        if (create) attributes.SecurityDescriptor = &privateDescriptor.descriptor;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

void log_result(const Match& match, bool create, NTSTATUS status) {
    if (InterlockedIncrement(&emitted) > 16) return;
    char key[17] = {};
    for (size_t n = 0; n < 16; ++n) key[n] = static_cast<char>(match.key[n]);
    char line[384];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_NAMESPACE={\"schemaVersion\":1,\"pid\":%lu,\"sessionId\":%lu,\"operation\":\"%s\",\"family\":\"%s\",\"key\":\"%s\",\"scopedDirectoryDacl\":%s,\"status\":\"0x%08lx\"}\n",
        GetCurrentProcessId(), ownSession, create ? "create" : "open",
        match.family == Family::global ? "global" : "session", key,
        create ? "true" : "false", static_cast<ULONG>(status));
    DWORD written = 0;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
}

BOOL initialization_result(const char* stage, DWORD error) {
    char line[320];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_INIT={\"schemaVersion\":1,\"pid\":%lu,\"stage\":\"%s\",\"error\":%lu}\n",
        GetCurrentProcessId(), stage, error);
    DWORD written = 0;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    SetLastError(error);
    return error == ERROR_SUCCESS;
}

NTSTATUS call(DirectoryCall original, PHANDLE output, ACCESS_MASK access,
              POBJECT_ATTRIBUTES input, bool create) {
    const DWORD before = GetLastError();
    OBJECT_ATTRIBUTES attributes = {};
    UNICODE_STRING name = {};
    WCHAR target[maximum_target_characters] = {};
    Match match = {};
    // Check the cheap name/descriptor conditions before querying thread state.
    const bool redirect = prepare(input, access, create, attributes, name, target, match) && not_impersonating();
    SetLastError(before);
    const NTSTATUS status = original(output, access, redirect ? &attributes : input);
    if (redirect) {
        const DWORD after = GetLastError();
        log_result(match, create, status);
        SetLastError(after);
    }
    return status;
}

NTSTATUS NTAPI create_directory(PHANDLE output, ACCESS_MASK access, POBJECT_ATTRIBUTES input) {
    return call(realCreate, output, access, input, true);
}
NTSTATUS NTAPI open_directory(PHANDLE output, ACCESS_MASK access, POBJECT_ATTRIBUTES input) {
    return call(realOpen, output, access, input, false);
}

} // namespace

BOOL WINAPI DllMain(HINSTANCE self, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (DetourIsHelperProcess()) return TRUE;
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    DetourRestoreAfterWith();
    if (!initialize_namespace()) return initialization_result("namespace-context", GetLastError() ? GetLastError() : ERROR_DLL_INIT_FAILED);
    if (!NemoClawInitializeProcessContext(self)) return initialization_result("process-context", GetLastError() ? GetLastError() : ERROR_DLL_INIT_FAILED);
    LONG error = DetourTransactionBegin();
    if (error) return initialization_result("transaction-begin", error);
    error = DetourUpdateThread(GetCurrentThread());
    if (!error) error = NemoClawStageProcessPropagation();
    if (!error) error = DetourAttach(&realCreate, create_directory);
    if (!error) error = DetourAttach(&realOpen, open_directory);
    if (error) {
        DetourTransactionAbort();
        return initialization_result("hook-staging", error);
    }
    error = DetourTransactionCommit();
    return initialization_result(error ? "transaction-commit" : "attached", error);
}
