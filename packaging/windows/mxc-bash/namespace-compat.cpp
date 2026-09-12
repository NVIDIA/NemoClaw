// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <securityappcontainer.h>
#include <detours.h>
#include <stdio.h>
#include <string.h>
#include <intrin.h>
#include "namespace-path.h"
#include "namespace-security.h"
#include "process-propagation.h"

namespace {
using namespace nemoclaw_msys;
using DirectoryCall = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES);
DirectoryCall realCreate = nullptr;
DirectoryCall realOpen = nullptr;
using SectionCreate = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PLARGE_INTEGER, ULONG, ULONG, HANDLE);
using SectionOpen = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES);
using SectionQuery = NTSTATUS (NTAPI*)(HANDLE, ULONG, PVOID, SIZE_T, PSIZE_T);
SectionCreate realCreateSharedSection = nullptr;
SectionOpen realOpenSharedSection = nullptr;
SectionQuery realQuerySharedSection = nullptr;
using MutantCreate = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, BOOLEAN);
MutantCreate realCreateSharedMutex = nullptr;
SectionOpen realOpenSharedMutex = nullptr;
LONG sharedMutexRecords = 0;
using PidLinkCreate = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PUNICODE_STRING);
using PidLinkQueryCall = NTSTATUS (NTAPI*)(HANDLE, PUNICODE_STRING, PULONG);
PidLinkCreate realCreatePidLink = nullptr;
SectionOpen realOpenPidLink = nullptr;
PidLinkQueryCall realQueryPidLink = nullptr;
LONG pidLinkRecords = 0;
using NativeIoApc = VOID (NTAPI*)(PVOID, PIO_STATUS_BLOCK, ULONG);
using NativeIoWrite = NTSTATUS (NTAPI*)(HANDLE, HANDLE, NativeIoApc, PVOID, PIO_STATUS_BLOCK, PVOID, ULONG, PLARGE_INTEGER, PULONG);
using NativeIoWaitMany = NTSTATUS (NTAPI*)(ULONG, PHANDLE, ULONG, BOOLEAN, PLARGE_INTEGER);
using NativeIoWaitOne = NTSTATUS (NTAPI*)(HANDLE, BOOLEAN, PLARGE_INTEGER);
using NativeIoEvent = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, ULONG, BOOLEAN);
NativeIoWrite realWriteIoFile = nullptr;
NativeIoWrite realReadIoFile = nullptr;
NativeIoWaitMany realWaitIoMany = nullptr;
NativeIoWaitOne realWaitIoOne = nullptr;
NativeIoEvent realCreateIoEvent = nullptr;
LONG ioFailureRecords = 0, ioSuccessRecords = 0, ioReadSuccessRecords = 0, ioRecordSequence = 0;
void observe_failed_private_mutant(POBJECT_ATTRIBUTES, ACCESS_MASK, BOOLEAN, NTSTATUS, DWORD, PVOID);

HANDLE heldSharedDirectory = nullptr;
LONG sharedDirectoryState = 0;
LONG sharedSectionRecords = 0;
WCHAR userSectionName[192] = {};
char userSectionLabel[192] = {};
USHORT userSectionNameBytes = 0;
void bind_shared_directory(PHANDLE output);

using NativePipeCreate = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
    ULONG, ULONG, ULONG, ULONG, ULONG, ULONG, ULONG, ULONG, ULONG, PLARGE_INTEGER);
using NativeFileOpen = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, ULONG, ULONG);
NativePipeCreate realNativePipeCreate = nullptr;
NativeFileOpen realNativeFileOpen = nullptr;
LONG nativePipeRecords = 0;
LONG ordinaryAclRecords = 0;
using CompareHandles = BOOL (WINAPI*)(HANDLE, HANDLE);
CompareHandles sameKernelObject = nullptr;
using QueryObject = NTSTATUS (NTAPI*)(HANDLE, OBJECT_INFORMATION_CLASS, PVOID, ULONG, PULONG);
QueryObject queryKernelObject = nullptr;
LONG npfsBindingState = 0;
HANDLE heldNpfsRoot = nullptr;
DWORD npfsBindingError = 0;
const char* npfsBindingReason = "not-observed";
decltype(&CreateNamedPipeA) realCreateSignalServer = CreateNamedPipeA;
decltype(&CreateFileA) realOpenSignalWriter = CreateFileA;
decltype(&CreatePipe) realCreateTrackerPipe = CreatePipe;
LONG trackerPipeRecords = 0;
LONG pipeRecords = 0;
__declspec(thread) bool writingPipeDiagnostic = false;
WCHAR privateRoot[maximum_root_characters] = {};
WCHAR apiRoot[maximum_root_characters] = {};
size_t privateRootLength = 0;
DWORD ownSession = 0;
alignas(void*) BYTE worldSid[SECURITY_MAX_SID_SIZE] = {};
alignas(void*) BYTE pidLinkContainerSid[SECURITY_MAX_SID_SIZE] = {};
ScopedDescriptor privateDescriptor = {};
ScopedDescriptor sharedSectionDescriptor = {};
ScopedDescriptor sharedMutexDescriptor = {};
LONG emitted = 0;
LONG installationKeyState = 0;
char installationKey[17] = {};

struct ContextDiagnostic {
    DWORD isContainer = 0;
    ULONG apiPathRequired = 0;
    bool apiPathReturned = false;
    bool ntRootOpened = false;
    ULONG ntRootStatus = 0;
    char tokenSid[192] = {};
};
ContextDiagnostic contextDiagnostic = {};

// Token SID formatting is diagnostic only: no allocation, lookup, or identity
// override. The supplied SID has just passed IsValidSid on TokenAppContainerSid.
void describe_token_sid(PSID sid) {
    const auto authority = GetSidIdentifierAuthority(sid);
    unsigned long long identifier = 0;
    for (size_t n = 0; n < 6; ++n) identifier = (identifier << 8) | authority->Value[n];
    int count = _snprintf_s(contextDiagnostic.tokenSid, sizeof(contextDiagnostic.tokenSid), _TRUNCATE,
        "S-%u-%llu", static_cast<unsigned>(SID_REVISION), identifier);
    if (count < 0) { contextDiagnostic.tokenSid[0] = 0; return; }
    size_t at = static_cast<size_t>(count);
    for (DWORD n = 0; n < *GetSidSubAuthorityCount(sid); ++n) {
        count = _snprintf_s(contextDiagnostic.tokenSid + at, sizeof(contextDiagnostic.tokenSid) - at,
            _TRUNCATE, "-%lu", *GetSidSubAuthority(sid, n));
        if (count < 0) { contextDiagnostic.tokenSid[0] = 0; return; }
        at += static_cast<size_t>(count);
    }
}

// Canonical get_windows_id() is the effective SID string. This native
// Personal profile does not impersonate; bind USER_VERSION 1 to TokenUser.
bool initialize_user_section_name(PSID sid) {
    if (!sid || !IsValidSid(sid)) return false;
    const auto authority = GetSidIdentifierAuthority(sid);
    unsigned long long identifier = 0;
    for (size_t n = 0; n < 6; ++n) identifier = (identifier << 8) | authority->Value[n];
    int count = _snprintf_s(userSectionLabel, sizeof(userSectionLabel), _TRUNCATE,
        "S-%u-%llu", static_cast<unsigned>(SID_REVISION), identifier);
    if (count < 0) return false;
    size_t at = static_cast<size_t>(count);
    for (DWORD n = 0; n < *GetSidSubAuthorityCount(sid); ++n) {
        count = _snprintf_s(userSectionLabel + at, sizeof(userSectionLabel) - at,
            _TRUNCATE, "-%lu", *GetSidSubAuthority(sid, n));
        if (count < 0) return false;
        at += static_cast<size_t>(count);
    }
    if (at + 3 > sizeof(userSectionLabel)) return false;
    userSectionLabel[at++] = '.'; userSectionLabel[at++] = '1'; userSectionLabel[at] = 0;
    for (size_t n = 0; n <= at; ++n) userSectionName[n] = static_cast<WCHAR>(userSectionLabel[n]);
    userSectionNameBytes = static_cast<USHORT>(at * sizeof(WCHAR));
    return true;
}

bool root_has_sid_suffix(size_t count) {
    size_t sidLength = 0;
    while (contextDiagnostic.tokenSid[sidLength]) ++sidLength;
    if (!sidLength || count <= sidLength || apiRoot[count - sidLength - 1] != L'\\') return false;
    for (size_t n = 0; n < sidLength; ++n)
        if (apiRoot[count - sidLength + n] != static_cast<WCHAR>(contextDiagnostic.tokenSid[n])) return false;
    return true;
}

bool context_result(const char* stage, const char* kind, DWORD error) {
    // UTF-16 code units retain the trusted API's exact spelling, including a
    // trailing separator, without JSON escaping or unsupported normalization.
    size_t count = 0;
    while (count < maximum_root_characters && apiRoot[count]) ++count;
    char pathHex[maximum_root_characters * 4 + 1] = {};
    constexpr char hex[] = "0123456789abcdef";
    for (size_t n = 0; n < count; ++n) {
        const unsigned value = static_cast<unsigned>(apiRoot[n]);
        for (size_t digit = 0; digit < 4; ++digit)
            pathHex[n * 4 + digit] = hex[(value >> ((3 - digit) * 4)) & 15];
    }
    const bool trailing = count > 0 && apiRoot[count - 1] == L'\\';
    char line[3072];
    const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_CONTEXT={\"schemaVersion\":1,\"pid\":%lu,\"stage\":\"%s\",\"kind\":\"%s\",\"win32Error\":%lu,\"isAppContainer\":%lu,\"sessionId\":%lu,\"tokenAppContainerSid\":\"%s\",\"apiPathReturned\":%s,\"apiPathRequired\":%lu,\"pathCharacters\":%zu,\"pathTerminated\":%s,\"pathLeadingSeparator\":%s,\"pathTrailingSeparator\":%s,\"pathEndsWithTokenSid\":%s,\"pathEndsWithTokenSidAndSeparator\":%s,\"pathUtf16Hex\":\"%s\",\"ntRootOpened\":%s,\"ntRootStatus\":\"0x%08lx\"}\n",
        GetCurrentProcessId(), stage, kind, error, contextDiagnostic.isContainer, ownSession,
        contextDiagnostic.tokenSid, contextDiagnostic.apiPathReturned ? "true" : "false",
        contextDiagnostic.apiPathRequired, count, count < maximum_root_characters ? "true" : "false",
        count && apiRoot[0] == L'\\' ? "true" : "false", trailing ? "true" : "false",
        root_has_sid_suffix(count) ? "true" : "false",
        trailing && root_has_sid_suffix(count - 1) ? "true" : "false", pathHex,
        contextDiagnostic.ntRootOpened ? "true" : "false", contextDiagnostic.ntRootStatus);
    DWORD written = 0;
    if (length > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
    SetLastError(error);
    return false;
}

// Fixed-size startup state, derived solely from the actual process token.
// Every native failure captures GetLastError immediately. Validation failures
// are separately labeled and do not masquerade as native ACCESS_DENIED.
bool initialize_namespace() {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        return context_result("open-process-token", "win32", GetLastError());
    alignas(void*) BYTE containerBuffer[sizeof(TOKEN_APPCONTAINER_INFORMATION) + SECURITY_MAX_SID_SIZE] = {};
    alignas(void*) BYTE userBuffer[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE] = {};
    DWORD needed = 0;
    DWORD worldSize = sizeof(worldSid);
    const char* stage = "token-is-appcontainer";
    const char* kind = "win32";
    DWORD error = ERROR_SUCCESS;
    bool success = false;
    do {
        if (!GetTokenInformation(token, TokenIsAppContainer, &contextDiagnostic.isContainer,
                                 sizeof(contextDiagnostic.isContainer), &needed)) { error = GetLastError(); break; }
        if (contextDiagnostic.isContainer != 1) { stage = "token-appcontainer-validation"; kind = "validation"; break; }
        stage = "token-appcontainer-sid";
        if (!GetTokenInformation(token, TokenAppContainerSid, containerBuffer, sizeof(containerBuffer), &needed)) { error = GetLastError(); break; }
        auto container = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(containerBuffer)->TokenAppContainer;
        if (!container || !IsValidSid(container)) { stage = "token-sid-validation"; kind = "validation"; break; }
        describe_token_sid(container);
        stage = "pid-link-container-copy";
        if (!CopySid(sizeof(pidLinkContainerSid), pidLinkContainerSid, container)) { error = GetLastError(); break; }
        stage = "token-user";
        if (!GetTokenInformation(token, TokenUser, userBuffer, sizeof(userBuffer), &needed)) { error = GetLastError(); break; }
        auto user = reinterpret_cast<TOKEN_USER*>(userBuffer)->User.Sid;
        if (!initialize_user_section_name(user)) { stage = "token-user-section-name"; kind = "validation"; error = 0; break; }
        stage = "token-session";
        if (!GetTokenInformation(token, TokenSessionId, &ownSession, sizeof(ownSession), &needed)) { error = GetLastError(); break; }
        stage = "appcontainer-named-object-path";
        if (!GetAppContainerNamedObjectPath(token, nullptr, static_cast<ULONG>(maximum_root_characters), apiRoot,
                                           &contextDiagnostic.apiPathRequired)) { error = GetLastError(); break; }
        contextDiagnostic.apiPathReturned = true;
        stage = "world-sid";
        if (!CreateWellKnownSid(WinWorldSid, nullptr, worldSid, &worldSize)) { error = GetLastError(); break; }
        if (!make_scoped_descriptor(user, container, privateDescriptor, &stage)) {
            error = GetLastError();
            if (stage && strcmp(stage, "descriptor-identities") == 0) { kind = "validation"; error = 0; }
            break;
        }
        stage = "shared-section-descriptor";
        if (!make_shared_section_descriptor(user, container, sharedSectionDescriptor)) {
            error = GetLastError();
            break;
        }
        stage = "shared-mutex-descriptor";
        if (!make_shared_mutex_descriptor(user, container, sharedMutexDescriptor)) {
            error = GetLastError();
            break;
        }
        size_t apiLength = 0;
        while (apiLength < maximum_root_characters && apiRoot[apiLength]) ++apiLength;
        privateRootLength = private_nt_root(apiRoot, apiLength, contextDiagnostic.tokenSid, ownSession,
                                            privateRoot, maximum_root_characters);
        if (!privateRootLength) { stage = "named-object-path-token-shape"; kind = "validation"; break; }
        success = true;
    } while (false);
    CloseHandle(token);
    if (!success) return context_result(stage, kind, error);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) return context_result("ntdll-module", "win32", GetLastError());
    realCreate = reinterpret_cast<DirectoryCall>(GetProcAddress(ntdll, "NtCreateDirectoryObject"));
    if (!realCreate) return context_result("ntdll-create-export", "win32", GetLastError());
    realOpen = reinterpret_cast<DirectoryCall>(GetProcAddress(ntdll, "NtOpenDirectoryObject"));
    if (!realOpen) return context_result("ntdll-open-export", "win32", GetLastError());
    realCreateSharedSection = reinterpret_cast<SectionCreate>(GetProcAddress(ntdll, "NtCreateSection"));
    realOpenSharedSection = reinterpret_cast<SectionOpen>(GetProcAddress(ntdll, "NtOpenSection"));
    realQuerySharedSection = reinterpret_cast<SectionQuery>(GetProcAddress(ntdll, "NtQuerySection"));
    if (!realCreateSharedSection || !realOpenSharedSection || !realQuerySharedSection)
        return context_result("ntdll-section-exports", "win32", GetLastError());
    realCreateSharedMutex = reinterpret_cast<MutantCreate>(GetProcAddress(ntdll, "NtCreateMutant"));
    realOpenSharedMutex = reinterpret_cast<SectionOpen>(GetProcAddress(ntdll, "NtOpenMutant"));
    if (!realCreateSharedMutex || !realOpenSharedMutex)
        return context_result("ntdll-mutant-exports", "win32", GetLastError());
    realWriteIoFile = reinterpret_cast<NativeIoWrite>(GetProcAddress(ntdll, "NtWriteFile"));
    realReadIoFile = reinterpret_cast<NativeIoWrite>(GetProcAddress(ntdll, "NtReadFile"));
    realWaitIoMany = reinterpret_cast<NativeIoWaitMany>(GetProcAddress(ntdll, "NtWaitForMultipleObjects"));
    realWaitIoOne = reinterpret_cast<NativeIoWaitOne>(GetProcAddress(ntdll, "NtWaitForSingleObject"));
    realCreateIoEvent = reinterpret_cast<NativeIoEvent>(GetProcAddress(ntdll, "NtCreateEvent"));
    if (!realWriteIoFile || !realReadIoFile || !realWaitIoMany || !realWaitIoOne || !realCreateIoEvent)
        return context_result("ntdll-io-observer-exports", "win32", GetLastError());
    realCreatePidLink = reinterpret_cast<PidLinkCreate>(GetProcAddress(ntdll, "NtCreateSymbolicLinkObject"));
    realOpenPidLink = reinterpret_cast<SectionOpen>(GetProcAddress(ntdll, "NtOpenSymbolicLinkObject"));
    realQueryPidLink = reinterpret_cast<PidLinkQueryCall>(GetProcAddress(ntdll, "NtQuerySymbolicLinkObject"));
    if (!realCreatePidLink || !realOpenPidLink || !realQueryPidLink)
        return context_result("ntdll-pid-link-exports", "win32", GetLastError());
    realNativePipeCreate = reinterpret_cast<NativePipeCreate>(GetProcAddress(ntdll, "NtCreateNamedPipeFile"));
    if (!realNativePipeCreate) return context_result("ntdll-pipe-create-export", "win32", GetLastError());
    realNativeFileOpen = reinterpret_cast<NativeFileOpen>(GetProcAddress(ntdll, "NtOpenFile"));
    if (!realNativeFileOpen) return context_result("ntdll-file-open-export", "win32", GetLastError());
    HMODULE kernelBase = GetModuleHandleW(L"kernelbase.dll");
    if (kernelBase) sameKernelObject = reinterpret_cast<CompareHandles>(GetProcAddress(kernelBase, "CompareObjectHandles"));
    if (!sameKernelObject) { npfsBindingError = GetLastError(); npfsBindingReason = "compare-unavailable"; }
    queryKernelObject = reinterpret_cast<QueryObject>(GetProcAddress(ntdll, "NtQueryObject"));
    if (!queryKernelObject) { npfsBindingError = GetLastError(); npfsBindingReason = "name-query-unavailable"; }
    // Validate the converted root through the original native API before any
    // hooks exist, requesting only traversal and creation of our subdirectories.
    UNICODE_STRING rootName = {};
    rootName.Buffer = privateRoot;
    rootName.Length = static_cast<USHORT>(privateRootLength * sizeof(WCHAR));
    rootName.MaximumLength = static_cast<USHORT>((privateRootLength + 1) * sizeof(WCHAR));
    OBJECT_ATTRIBUTES rootAttributes = {};
    rootAttributes.Length = sizeof(rootAttributes);
    rootAttributes.ObjectName = &rootName;
    HANDLE rootHandle = nullptr;
    const NTSTATUS rootStatus = realOpen(&rootHandle, 0x0000000a, &rootAttributes);
    contextDiagnostic.ntRootStatus = static_cast<ULONG>(rootStatus);
    contextDiagnostic.ntRootOpened = rootStatus >= 0;
    if (rootHandle) CloseHandle(rootHandle);
    if (rootStatus < 0) return context_result("private-nt-root-open", "ntstatus", ERROR_SUCCESS);
    context_result("ready", "success", ERROR_SUCCESS);
    return true;
}

bool not_impersonating(const char*& rejected, DWORD& error) {
    HANDLE threadToken = nullptr;
    if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &threadToken)) {
        error = GetLastError();
        if (error == ERROR_NO_TOKEN) { error = 0; return true; }
        rejected = "thread-token-query";
        return false;
    }
    CloseHandle(threadToken);
    rejected = "thread-token-present";
    error = 0;
    return false;
}

// Copy every caller-owned field while protected by SEH. Unsupported inputs go
// to the original API unchanged, including its ordinary parameter validation.
bool prepare(POBJECT_ATTRIBUTES input, ACCESS_MASK access, bool create,
             OBJECT_ATTRIBUTES& attributes, UNICODE_STRING& targetName,
             WCHAR* target, Match& match, const char*& rejected) {
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
        if (create) {
            if (access != directory_access) { rejected = "create-access"; return false; }
            if (attributes.Attributes != OBJ_OPENIF) { rejected = "create-flags"; return false; }
            if (!is_msys_directory_descriptor(attributes.SecurityDescriptor, worldSid)) {
                rejected = "create-descriptor"; return false;
            }
        }
        const size_t size = mapped_name(match, ownSession, privateRoot, privateRootLength,
                                        target, maximum_target_characters);
        if (!size) { rejected = "target-name-bounds"; return false; }
        targetName.Buffer = target;
        targetName.Length = static_cast<USHORT>(size * sizeof(WCHAR));
        targetName.MaximumLength = static_cast<USHORT>((size + 1) * sizeof(WCHAR));
        attributes.ObjectName = &targetName;
        if (create) attributes.SecurityDescriptor = &privateDescriptor.descriptor;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        if (match.family != Family::none) rejected = "parameter-exception";
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

void log_rejected(const Match& match, bool create, ACCESS_MASK access, ULONG flags,
                  const char* reason, DWORD error, NTSTATUS status) {
    if (InterlockedIncrement(&emitted) > 16) return;
    char key[17] = {};
    for (size_t n = 0; n < 16; ++n) key[n] = static_cast<char>(match.key[n]);
    char line[512];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_REJECTED={\"schemaVersion\":1,\"pid\":%lu,\"sessionId\":%lu,\"operation\":\"%s\",\"family\":\"%s\",\"key\":\"%s\",\"reason\":\"%s\",\"requestedAccess\":\"0x%08lx\",\"objectAttributes\":\"0x%08lx\",\"win32Error\":%lu,\"originalStatus\":\"0x%08lx\"}\n",
        GetCurrentProcessId(), ownSession, create ? "create" : "open",
        match.family == Family::global ? "global" : "session", key, reason,
        access, flags, error, static_cast<ULONG>(status));
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
    const char* rejected = nullptr;
    DWORD rejectionError = 0;
    const bool redirect = prepare(input, access, create, attributes, name, target, match, rejected) &&
                          not_impersonating(rejected, rejectionError);
    SetLastError(before);
    const NTSTATUS status = original(output, access, redirect ? &attributes : input);
    if (redirect || rejected) {
        const DWORD after = GetLastError();
        if (redirect) {
            if (create && match.family == Family::global && status >= 0 &&
                InterlockedCompareExchange(&installationKeyState, 1, 0) == 0) {
                for (size_t n = 0; n < 16; ++n) installationKey[n] = static_cast<char>(match.key[n]);
                InterlockedExchange(&installationKeyState, 2);
                bind_shared_directory(output);
            }
            log_result(match, create, status);
        } else log_rejected(match, create, access, attributes.Attributes, rejected, rejectionError, status);
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

// The writer remains observation-only. The server can append a token-bound
// ACE to an exact new signal-pipe request; names, modes and native results stay intact.
bool observed_signal_name(LPCSTR input, char* copied) {
    __try {
        if (!input) return false;
        for (size_t n = 0; n < maximum_signal_pipe_characters; ++n) {
            copied[n] = input[n];
            if (!copied[n]) return signal_pipe_name(copied, n, GetCurrentProcessId());
        }
        return false;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

void log_signal_pipe(const char* name, const char* operation, DWORD access, DWORD mode,
                     DWORD instances, DWORD outBuffer, DWORD inBuffer, DWORD timeout,
                     DWORD share, DWORD disposition, DWORD flags, HANDLE result, DWORD error,
                     const PipeSecurityObservation& security, bool appended = false,
                     const char* adaptation = "not-requested") {
    if (InterlockedIncrement(&pipeRecords) > 8) return;
    char escaped[maximum_signal_pipe_characters * 2 + 1] = {};
    size_t at = 0;
    for (size_t n = 0; name[n]; ++n) {
        if (name[n] == '\\') escaped[at++] = '\\';
        escaped[at++] = name[n];
    }
    char aclHex[sizeof(security.acl) * 2 + 1] = {};
    constexpr char hex[] = "0123456789abcdef";
    for (DWORD n = 0; n < security.capturedAclBytes; ++n) {
        aclHex[n * 2] = hex[security.acl[n] >> 4];
        aclHex[n * 2 + 1] = hex[security.acl[n] & 15];
    }
    char line[2560];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_SIGNAL_PIPE={\"schemaVersion\":1,\"pid\":%lu,\"operation\":\"%s\",\"name\":\"%s\",\"accessOrOpenMode\":\"0x%08lx\",\"pipeMode\":\"0x%08lx\",\"maxInstances\":%lu,\"outBufferBytes\":%lu,\"inBufferBytes\":%lu,\"defaultTimeout\":%lu,\"shareMode\":\"0x%08lx\",\"creationDisposition\":%lu,\"flags\":\"0x%08lx\",\"resultSuccess\":%s,\"win32Error\":%lu,\"securityInspectionComplete\":%s,\"attributesPresent\":%s,\"attributesLength\":%lu,\"inheritHandle\":%d,\"descriptorPresent\":%s,\"descriptorControl\":\"0x%04x\",\"descriptorRevision\":%lu,\"daclPresent\":%s,\"nullDacl\":%s,\"aclBytes\":%lu,\"aceCount\":%lu,\"capturedAclBytes\":%lu,\"aclTruncated\":%s,\"aclHex\":\"%s\",\"requestDescriptorAppended\":%s,\"appendedAccess\":\"0x%08lx\",\"descriptorSource\":\"%s\",\"adaptation\":\"%s\"}\n",
        GetCurrentProcessId(), operation, escaped, access, mode, instances, outBuffer, inBuffer, timeout,
        share, disposition, flags, result && result != INVALID_HANDLE_VALUE ? "true" : "false", error,
        security.complete ? "true" : "false", security.attributesPresent ? "true" : "false",
        security.attributesLength, security.inheritedHandle, security.descriptorPresent ? "true" : "false",
        static_cast<unsigned>(security.control), security.revision, security.daclPresent ? "true" : "false",
        security.nullDacl ? "true" : "false", security.aclBytes, security.aceCount, security.capturedAclBytes,
        security.capturedAclBytes < security.aclBytes ? "true" : "false", aclHex,
        appended ? "true" : "false", appended ? static_cast<ULONG>(signal_writer_access) : 0UL,
        appended ? "adapted-input" : "original-input", adaptation);
    DWORD written = 0;
    writingPipeDiagnostic = true;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    writingPipeDiagnostic = false;
}

HANDLE WINAPI observe_signal_server(LPCSTR name, DWORD openMode, DWORD pipeMode,
    DWORD maxInstances, DWORD outBuffer, DWORD inBuffer, DWORD timeout, LPSECURITY_ATTRIBUTES attributes) {
    if (writingPipeDiagnostic) return realCreateSignalServer(name, openMode, pipeMode, maxInstances, outBuffer, inBuffer, timeout, attributes);
    const DWORD before = GetLastError();
    char copied[maximum_signal_pipe_characters] = {};
    const bool observed = observed_signal_name(name, copied);
    PipeSecurityObservation security = {};
    if (observed) observe_pipe_security(attributes, security);
    SignalPipeDescriptor scoped = {};
    bool appended = false;
    const char* adaptation = "outside-exact-contract";
    if (observed && InterlockedCompareExchange(&installationKeyState, 2, 2) == 2 &&
        owned_signal_pipe(copied, strlen(copied), GetCurrentProcessId(), installationKey,
                          openMode, pipeMode, maxInstances, outBuffer, inBuffer, timeout)) {
        DWORD impersonationError = 0;
        const char* impersonationReason = nullptr;
        if (not_impersonating(impersonationReason, impersonationError)) {
            void* userAce = nullptr;
            void* containerAce = nullptr;
            auto identities = reinterpret_cast<PACL>(privateDescriptor.acl);
            if (GetAce(identities, 0, &userAce) && GetAce(identities, 1, &containerAce))
                appended = append_signal_container_ace(security,
                    &static_cast<ACCESS_ALLOWED_ACE*>(userAce)->SidStart,
                    &static_cast<ACCESS_ALLOWED_ACE*>(containerAce)->SidStart, scoped);
            adaptation = appended ? "new-server-request" : "descriptor-not-admitted";
        } else adaptation = impersonationReason;
    }
    if (appended) {
        security = {};
        observe_pipe_security(&scoped.attributes, security);
    }
    SetLastError(before);
    // Use the validated private name snapshot with the private descriptor so
    // caller mutation cannot redirect the appended ACE to another pipe name.
    // FIRST_PIPE_INSTANCE stays set: a preexisting same-name server is refused.
    HANDLE result = realCreateSignalServer(appended ? copied : name, openMode, pipeMode, maxInstances,
        outBuffer, inBuffer, timeout, appended ? &scoped.attributes : attributes);
    const DWORD error = GetLastError();
    if (observed) log_signal_pipe(copied, "server-create", openMode, pipeMode, maxInstances,
        outBuffer, inBuffer, timeout, 0, 0, 0, result, error, security, appended, adaptation);
    SetLastError(error);
    return result;
}

HANDLE WINAPI observe_signal_writer(LPCSTR name, DWORD access, DWORD share, LPSECURITY_ATTRIBUTES attributes,
    DWORD disposition, DWORD flags, HANDLE templateFile) {
    if (writingPipeDiagnostic) return realOpenSignalWriter(name, access, share, attributes, disposition, flags, templateFile);
    const DWORD before = GetLastError();
    char copied[maximum_signal_pipe_characters] = {};
    const bool observed = observed_signal_name(name, copied);
    PipeSecurityObservation security = {};
    if (observed) observe_pipe_security(attributes, security);
    SetLastError(before);
    HANDLE result = realOpenSignalWriter(name, access, share, attributes, disposition, flags, templateFile);
    const DWORD error = GetLastError();
    if (observed) log_signal_pipe(copied, "writer-open", access, 0, 0, 0, 0, 0,
        share, disposition, flags, result, error, security);
    SetLastError(error);
    return result;
}

struct NativePipeObservation {
    char name[maximum_signal_pipe_characters] = {};
    HANDLE root = nullptr;
    ULONG attributes = 0;
    bool npfsRoot = false;
    PipeSecurityObservation security = {};
    OBJECT_ATTRIBUTES originalAttributes = {};
    bool descriptorAppended = false;
    HANDLE forwardedRoot = nullptr;
    const char* adaptation = "not-requested";
};

bool observe_native_pipe_name(POBJECT_ATTRIBUTES input, NativePipeObservation& result) {
    if (InterlockedCompareExchange(&installationKeyState, 2, 2) != 2) return false;
    __try {
        if (!input || input->Length != sizeof(OBJECT_ATTRIBUTES) || !input->ObjectName) return false;
        const OBJECT_ATTRIBUTES attributes = *input;
        const UNICODE_STRING name = *attributes.ObjectName;
        if (!name.Buffer || name.Length % sizeof(WCHAR) || name.Length > name.MaximumLength ||
            name.Length / sizeof(WCHAR) >= maximum_signal_pipe_characters) return false;
        const size_t count = name.Length / sizeof(WCHAR);
        WCHAR copied[maximum_signal_pipe_characters] = {};
        for (size_t n = 0; n < count; ++n) copied[n] = name.Buffer[n];
        result.npfsRoot = !attributes.RootDirectory && npfs_root_name(copied, count);
        if (!result.npfsRoot && !(attributes.RootDirectory &&
            ordinary_pipe_name(copied, count, installationKey, GetCurrentProcessId()))) return false;
        for (size_t n = 0; n < count; ++n) result.name[n] = static_cast<char>(copied[n]);
        result.root = attributes.RootDirectory;
        result.forwardedRoot = attributes.RootDirectory;
        result.attributes = attributes.Attributes;
        result.originalAttributes = attributes;
        SECURITY_ATTRIBUTES security = {sizeof(SECURITY_ATTRIBUTES), attributes.SecurityDescriptor,
                                       (attributes.Attributes & OBJ_INHERIT) ? TRUE : FALSE};
        observe_pipe_security(&security, result.security);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

unsigned long long observed_native_handle(PHANDLE output, NTSTATUS status) {
    if (status != 0 || !output) return 0;
    __try { return reinterpret_cast<unsigned long long>(*output); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return 0; }
}

void log_native_pipe(const NativePipeObservation& observation, const char* operation, ACCESS_MASK access,
    ULONG share, ULONG disposition, ULONG options, ULONG pipeType, ULONG readMode, ULONG completionMode,
    ULONG instances, ULONG inbound, ULONG outbound, bool timeoutReadable, LONGLONG timeout,
    NTSTATUS status, unsigned long long handle, DWORD lastError) {
    if (InterlockedIncrement(&nativePipeRecords) > 16) return;
    char escaped[maximum_signal_pipe_characters * 2 + 1] = {};
    size_t at = 0;
    for (size_t n = 0; observation.name[n]; ++n) {
        if (observation.name[n] == '\\') escaped[at++] = '\\';
        escaped[at++] = observation.name[n];
    }
    const auto& security = observation.security;
    char aclHex[sizeof(security.acl) * 2 + 1] = {};
    constexpr char hex[] = "0123456789abcdef";
    for (DWORD n = 0; n < security.capturedAclBytes; ++n) {
        aclHex[n * 2] = hex[security.acl[n] >> 4];
        aclHex[n * 2 + 1] = hex[security.acl[n] & 15];
    }
    char line[2560];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_NATIVE_PIPE={\"schemaVersion\":1,\"pid\":%lu,\"operation\":\"%s\",\"name\":\"%s\",\"rootHandle\":\"0x%llx\",\"objectAttributes\":\"0x%08lx\",\"access\":\"0x%08lx\",\"share\":%lu,\"disposition\":%lu,\"options\":\"0x%08lx\",\"pipeType\":%lu,\"readMode\":%lu,\"completionMode\":%lu,\"maxInstances\":%lu,\"inboundQuota\":%lu,\"outboundQuota\":%lu,\"timeoutReadable\":%s,\"timeout100ns\":%lld,\"ntStatus\":\"0x%08lx\",\"resultHandle\":\"0x%llx\",\"lastError\":%lu,\"securitySource\":\"%s\",\"securityInspectionComplete\":%s,\"descriptorPresent\":%s,\"descriptorControl\":\"0x%04x\",\"daclPresent\":%s,\"nullDacl\":%s,\"aclBytes\":%lu,\"aceCount\":%lu,\"capturedAclBytes\":%lu,\"aclTruncated\":%s,\"aclHex\":\"%s\",\"requestDescriptorAppended\":%s,\"appendedAccess\":\"0x%08lx\",\"forwardedRootHandle\":\"0x%llx\",\"npfsRootHeld\":%s,\"npfsBindingError\":%lu,\"npfsBindingReason\":\"%s\",\"adaptation\":\"%s\"}\n",
        GetCurrentProcessId(), operation, escaped, reinterpret_cast<unsigned long long>(observation.root), observation.attributes,
        access, share, disposition, options, pipeType, readMode, completionMode, instances, inbound, outbound,
        timeoutReadable ? "true" : "false", timeout, static_cast<ULONG>(status), handle, lastError,
        observation.descriptorAppended ? "adapted-input" : "OBJECT_ATTRIBUTES-input",
        security.complete ? "true" : "false", security.descriptorPresent ? "true" : "false",
        static_cast<unsigned>(security.control), security.daclPresent ? "true" : "false", security.nullDacl ? "true" : "false",
        security.aclBytes, security.aceCount, security.capturedAclBytes,
        security.capturedAclBytes < security.aclBytes ? "true" : "false", aclHex,
        observation.descriptorAppended ? "true" : "false", observation.descriptorAppended ? static_cast<ULONG>(signal_writer_access) : 0UL,
        reinterpret_cast<unsigned long long>(observation.forwardedRoot),
        InterlockedCompareExchange(&npfsBindingState, 2, 2) == 2 ? "true" : "false",
        npfsBindingError, npfsBindingReason, observation.adaptation);
    DWORD written = 0;
    writingPipeDiagnostic = true;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    writingPipeDiagnostic = false;
}

bool verified_npfs_object_name(HANDLE handle, DWORD& error) {
    alignas(void*) BYTE buffer[512] = {};
    ULONG needed = 0;
    const NTSTATUS status = queryKernelObject(handle, static_cast<OBJECT_INFORMATION_CLASS>(1),
                                              buffer, sizeof(buffer), &needed);
    error = static_cast<DWORD>(status);
    if (status != 0) return false;
    const auto name = reinterpret_cast<const UNICODE_STRING*>(buffer);
    const uintptr_t begin = reinterpret_cast<uintptr_t>(buffer);
    const uintptr_t address = reinterpret_cast<uintptr_t>(name->Buffer);
    if (!name->Buffer || name->Length % sizeof(WCHAR) || name->Length > name->MaximumLength ||
        address < begin + sizeof(UNICODE_STRING) || address > begin + sizeof(buffer) ||
        name->Length > begin + sizeof(buffer) - address) return false;
    return npfs_root_name(name->Buffer, name->Length / sizeof(WCHAR));
}

void retain_npfs_root(HANDLE original) {
    if (!original || original == INVALID_HANDLE_VALUE || !sameKernelObject || !queryKernelObject ||
        InterlockedCompareExchange(&npfsBindingState, 1, 0) != 0) return;
    const char* rejected = nullptr;
    DWORD error = 0;
    HANDLE duplicate = nullptr;
    if (!not_impersonating(rejected, error)) npfsBindingReason = rejected;
    else if (!DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), &duplicate,
                              0, FALSE, DUPLICATE_SAME_ACCESS)) {
        error = GetLastError(); npfsBindingReason = "duplicate-failed";
    } else if (!sameKernelObject(original, duplicate)) {
        error = GetLastError(); npfsBindingReason = "duplicate-not-same-object";
    } else if (!verified_npfs_object_name(duplicate, error)) {
        npfsBindingReason = "npfs-object-name-not-verified";
    } else {
        // Noninheriting, same-access duplicate is owned for this injected
        // process lifetime. Windows closes it on normal exit or job teardown.
        heldNpfsRoot = duplicate;
        npfsBindingReason = "held-same-object";
        npfsBindingError = 0;
        InterlockedExchange(&npfsBindingState, 2);
        return;
    }
    if (duplicate) CloseHandle(duplicate);
    npfsBindingError = error;
    InterlockedExchange(&npfsBindingState, 0);
}

bool current_default_pipe_descriptor(SignalPipeDescriptor& output, ACCESS_MASK containerAccess = signal_writer_access) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    alignas(void*) BYTE data[1024] = {}, containerData[sizeof(TOKEN_APPCONTAINER_INFORMATION) + SECURITY_MAX_SID_SIZE] = {};
    DWORD needed = 0;
    bool result = false;
    void* userAce = nullptr;
    void* containerAce = nullptr;
    auto identities = reinterpret_cast<PACL>(privateDescriptor.acl);
    if (GetAce(identities, 0, &userAce) && GetAce(identities, 1, &containerAce) &&
        GetTokenInformation(token, TokenAppContainerSid, containerData, sizeof(containerData), &needed)) {
        PSID currentContainer = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(containerData)->TokenAppContainer;
        PSID expectedContainer = &static_cast<ACCESS_ALLOWED_ACE*>(containerAce)->SidStart;
        if (currentContainer && IsValidSid(currentContainer) && EqualSid(currentContainer, expectedContainer) &&
            GetTokenInformation(token, TokenDefaultDacl, data, sizeof(data), &needed) &&
            needed >= sizeof(TOKEN_DEFAULT_DACL) && needed <= sizeof(data)) {
            PACL acl = reinterpret_cast<TOKEN_DEFAULT_DACL*>(data)->DefaultDacl;
            const uintptr_t begin = reinterpret_cast<uintptr_t>(data);
            const uintptr_t address = reinterpret_cast<uintptr_t>(acl);
            if (acl && address >= begin + sizeof(TOKEN_DEFAULT_DACL) && address <= begin + needed - sizeof(ACL) &&
                acl->AclSize >= sizeof(ACL) && acl->AclSize <= 512 && acl->AclSize <= begin + needed - address) {
                // Explicit DACL only; owner/group remain unset so Windows
                // selects the same current token defaults as NULL-SD creation.
                SECURITY_DESCRIPTOR descriptor = {};
                SECURITY_ATTRIBUTES attributes = {sizeof(SECURITY_ATTRIBUTES), &descriptor, FALSE};
                if (InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
                    SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE)) {
                    PipeSecurityObservation snapshot = {};
                    observe_pipe_security(&attributes, snapshot);
                    result = append_signal_container_ace(snapshot,
                        &static_cast<ACCESS_ALLOWED_ACE*>(userAce)->SidStart, expectedContainer, output, containerAccess);
                }
            }
        }
    }
    CloseHandle(token);
    return result;
}

NTSTATUS NTAPI observe_native_open(PHANDLE output, ACCESS_MASK access, POBJECT_ATTRIBUTES attributes,
    PIO_STATUS_BLOCK io, ULONG share, ULONG options) {
    if (writingPipeDiagnostic) return realNativeFileOpen(output, access, attributes, io, share, options);
    const DWORD before = GetLastError();
    NativePipeObservation observed = {};
    const bool matched = observe_native_pipe_name(attributes, observed);
    SetLastError(before);
    const NTSTATUS status = realNativeFileOpen(output, access, attributes, io, share, options);
    const DWORD after = GetLastError();
    const unsigned long long openedHandle = matched ? observed_native_handle(output, status) : 0;
    if (matched && observed.npfsRoot && status == 0 && access == 0x00100080 && share == 3 && options == 0 &&
        observed.attributes == 0 && !observed.security.descriptorPresent && !observed.originalAttributes.SecurityQualityOfService)
        retain_npfs_root(reinterpret_cast<HANDLE>(openedHandle));
    if (matched) log_native_pipe(observed, observed.npfsRoot ? "npfs-root-open" : "ordinary-writer-open",
        access, share, 0, options, 0, 0, 0, 0, 0, 0, false, 0, status, openedHandle, after);
    SetLastError(after);
    return status;
}

// Diagnose the first exact new ordinary server's actual security, without
// modifying it or replacing NULL-SD creation with an unproven template.
void observe_ordinary_default_acl(HANDLE server, HANDLE root) {
    if (!server || server == INVALID_HANDLE_VALUE || InterlockedIncrement(&ordinaryAclRecords) > 2) return;
    const DWORD saved = GetLastError();
    DWORD identityError = 0;
    const char* identityReason = "none";
    const bool currentIdentity = not_impersonating(identityReason, identityError);
    alignas(void*) BYTE tokenBytes[1024] = {};
    alignas(void*) BYTE effectiveBytes[1024] = {};
    DWORD tokenRequired = 0, effectiveRequired = 0;
    DWORD tokenError = 0, effectiveError = 0;
    bool tokenQueried = false, tokenNullDacl = false, tokenBounded = false, effectiveQueried = false;
    DWORD tokenAclSize = 0, effectiveCaptured = 0, effectiveDescriptorLength = 0;
    DWORD effectiveRevision = 0, effectiveHeaderError = 0, effectiveValidationException = 0;
    SECURITY_DESCRIPTOR_CONTROL effectiveControl = 0;
    bool effectiveDescriptorValid = false;
    PACL tokenAcl = nullptr;
    HANDLE token = nullptr;
    if (currentIdentity) {
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) tokenError = GetLastError();
        else {
            tokenQueried = GetTokenInformation(token, TokenDefaultDacl, tokenBytes, sizeof(tokenBytes), &tokenRequired) != FALSE;
            if (!tokenQueried) tokenError = GetLastError();
            if (tokenQueried && tokenRequired >= sizeof(TOKEN_DEFAULT_DACL) && tokenRequired <= sizeof(tokenBytes)) {
                tokenAcl = reinterpret_cast<TOKEN_DEFAULT_DACL*>(tokenBytes)->DefaultDacl;
                tokenNullDacl = tokenAcl == nullptr;
                if (tokenAcl) {
                    const uintptr_t begin = reinterpret_cast<uintptr_t>(tokenBytes);
                    const uintptr_t address = reinterpret_cast<uintptr_t>(tokenAcl);
                    if (address >= begin + sizeof(TOKEN_DEFAULT_DACL) && address <= begin + tokenRequired - sizeof(ACL)) {
                        tokenAclSize = tokenAcl->AclSize;
                        tokenBounded = tokenAclSize >= sizeof(ACL) && tokenAclSize <= 512 &&
                            tokenAclSize <= begin + tokenRequired - address;
                    }
                }
            }
            CloseHandle(token);
        }
        effectiveQueried = GetKernelObjectSecurity(server,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            effectiveBytes, sizeof(effectiveBytes), &effectiveRequired) != FALSE;
        if (!effectiveQueried) effectiveError = GetLastError();
        if (effectiveQueried) {
            __try {
                const auto header = reinterpret_cast<const SECURITY_DESCRIPTOR_RELATIVE*>(effectiveBytes);
                effectiveRevision = header->Revision;
                effectiveControl = header->Control;
                SECURITY_DESCRIPTOR_CONTROL checkedControl = 0;
                DWORD checkedRevision = 0;
                const BOOL headerValid = GetSecurityDescriptorControl(effectiveBytes, &checkedControl, &checkedRevision);
                if (!headerValid) effectiveHeaderError = GetLastError();
                if (headerValid && checkedRevision == SECURITY_DESCRIPTOR_REVISION &&
                    checkedRevision == effectiveRevision && checkedControl == effectiveControl &&
                    (checkedControl & SE_SELF_RELATIVE) && IsValidSecurityDescriptor(effectiveBytes)) {
                    effectiveDescriptorLength = GetSecurityDescriptorLength(effectiveBytes);
                    effectiveDescriptorValid = effectiveDescriptorLength >= sizeof(SECURITY_DESCRIPTOR_RELATIVE) &&
                                               effectiveDescriptorLength <= sizeof(effectiveBytes);
                    if (effectiveDescriptorValid) effectiveCaptured = effectiveDescriptorLength;
                }
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                effectiveValidationException = GetExceptionCode();
            }
        }
    }
    char tokenHex[1025] = {}, effectiveHex[2049] = {};
    constexpr char hex[] = "0123456789abcdef";
    if (tokenBounded) {
        const BYTE* bytes = reinterpret_cast<const BYTE*>(tokenAcl);
        for (DWORD n = 0; n < tokenAclSize; ++n) {
            tokenHex[n * 2] = hex[bytes[n] >> 4]; tokenHex[n * 2 + 1] = hex[bytes[n] & 15];
        }
    }
    for (DWORD n = 0; n < effectiveCaptured; ++n) {
        effectiveHex[n * 2] = hex[effectiveBytes[n] >> 4]; effectiveHex[n * 2 + 1] = hex[effectiveBytes[n] & 15];
    }
    char line[4096];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_ORDINARY_ACL={\"schemaVersion\":1,\"pid\":%lu,\"serverHandle\":\"0x%llx\",\"rootHandle\":\"0x%llx\",\"currentProcessIdentity\":%s,\"identityReason\":\"%s\",\"identityError\":%lu,\"tokenQuerySucceeded\":%s,\"tokenError\":%lu,\"tokenRequired\":%lu,\"tokenNullDacl\":%s,\"tokenAclBounded\":%s,\"tokenAclBytes\":%lu,\"tokenAclHex\":\"%s\",\"effectiveQuerySucceeded\":%s,\"effectiveError\":%lu,\"effectiveRequired\":%lu,\"effectiveCaptured\":%lu,\"effectiveDescriptorLength\":%lu,\"effectiveDescriptorValid\":%s,\"effectiveRevision\":%lu,\"effectiveControl\":\"0x%04x\",\"effectiveHeaderError\":%lu,\"effectiveValidationException\":\"0x%08lx\",\"effectiveSecurityInformation\":7,\"effectiveSdHex\":\"%s\"}\n",
        GetCurrentProcessId(), reinterpret_cast<unsigned long long>(server), reinterpret_cast<unsigned long long>(root),
        currentIdentity ? "true" : "false", identityReason, identityError, tokenQueried ? "true" : "false", tokenError,
        tokenRequired, tokenNullDacl ? "true" : "false", tokenBounded ? "true" : "false", tokenAclSize, tokenHex,
        effectiveQueried ? "true" : "false", effectiveError, effectiveRequired, effectiveCaptured,
        effectiveDescriptorLength, effectiveDescriptorValid ? "true" : "false", effectiveRevision,
        static_cast<unsigned>(effectiveControl), effectiveHeaderError, effectiveValidationException, effectiveHex);
    DWORD written = 0;
    writingPipeDiagnostic = true;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    writingPipeDiagnostic = false;
    SetLastError(saved);
}

NTSTATUS NTAPI observe_native_create(PHANDLE output, ACCESS_MASK access, POBJECT_ATTRIBUTES attributes,
    PIO_STATUS_BLOCK io, ULONG share, ULONG disposition, ULONG options, ULONG pipeType, ULONG readMode,
    ULONG completionMode, ULONG instances, ULONG inbound, ULONG outbound, PLARGE_INTEGER timeout) {
    if (writingPipeDiagnostic) return realNativePipeCreate(output, access, attributes, io, share, disposition,
        options, pipeType, readMode, completionMode, instances, inbound, outbound, timeout);
    const DWORD before = GetLastError();
    NativePipeObservation observed = {};
    const bool matched = observe_native_pipe_name(attributes, observed) && !observed.npfsRoot;
    bool timeoutReadable = false;
    LONGLONG timeoutValue = 0;
    if (matched && timeout) {
        __try { timeoutValue = timeout->QuadPart; timeoutReadable = true; }
        __except (EXCEPTION_EXECUTE_HANDLER) { timeoutReadable = false; }
    }
    const bool originalNullDescriptor = matched && !observed.security.descriptorPresent;
    const bool exact = originalNullDescriptor && !observed.originalAttributes.SecurityQualityOfService &&
        ordinary_create_contract(access, share, disposition, options, pipeType, readMode, completionMode,
                                 instances, inbound, outbound, timeoutReadable, timeoutValue, observed.attributes);
    SignalPipeDescriptor descriptor = {};
    OBJECT_ATTRIBUTES forwarded = observed.originalAttributes;
    UNICODE_STRING privateName = {};
    WCHAR wideName[maximum_signal_pipe_characters] = {};
    LARGE_INTEGER privateTimeout = {};
    privateTimeout.QuadPart = timeoutValue;
    if (exact) {
        observed.adaptation = "root-not-verified";
        if (sameKernelObject && InterlockedCompareExchange(&npfsBindingState, 2, 2) == 2 &&
            sameKernelObject(observed.root, heldNpfsRoot)) {
            const char* rejected = nullptr;
            DWORD identityError = 0;
            if (!not_impersonating(rejected, identityError)) observed.adaptation = rejected;
            else if (!current_default_pipe_descriptor(descriptor)) observed.adaptation = "token-default-not-admitted";
            else {
                const size_t count = strlen(observed.name);
                for (size_t n = 0; n < count; ++n) wideName[n] = static_cast<WCHAR>(observed.name[n]);
                privateName.Buffer = wideName;
                privateName.Length = static_cast<USHORT>(count * sizeof(WCHAR));
                privateName.MaximumLength = static_cast<USHORT>((count + 1) * sizeof(WCHAR));
                forwarded.ObjectName = &privateName;
                forwarded.RootDirectory = heldNpfsRoot;
                forwarded.SecurityDescriptor = &descriptor.descriptor;
                observed.forwardedRoot = heldNpfsRoot;
                observed.descriptorAppended = true;
                observed.adaptation = "new-server-default-template";
                observed.security = {};
                observe_pipe_security(&descriptor.attributes, observed.security);
            }
        }
    }
    SetLastError(before);
    const NTSTATUS status = realNativePipeCreate(output, access, observed.descriptorAppended ? &forwarded : attributes,
        io, share, disposition, options, pipeType, readMode, completionMode, instances, inbound, outbound,
        observed.descriptorAppended ? &privateTimeout : timeout);
    const DWORD after = GetLastError();
    const unsigned long long createdHandle = matched ? observed_native_handle(output, status) : 0;
    if (matched) log_native_pipe(observed, "ordinary-server-create", access, share, disposition, options,
        pipeType, readMode, completionMode, instances, inbound, outbound, timeoutReadable, timeoutValue,
        status, createdHandle, after);
    if (exact && status == 0)
        observe_ordinary_default_acl(reinterpret_cast<HANDLE>(createdHandle), observed.root);
    SetLastError(after);
    return status;
}

// Pinned child_info::prefork requests exactly this anonymous 16-byte pipe,
// then separately makes only its writer inheritable. Keep both operations.
BOOL WINAPI create_tracker_pipe(PHANDLE read, PHANDLE write, LPSECURITY_ATTRIBUTES attributes, DWORD size) {
    if (writingPipeDiagnostic) return realCreateTrackerPipe(read, write, attributes, size);
    const DWORD before = GetLastError();
    PipeSecurityObservation security = {};
    const bool context = InterlockedCompareExchange(&installationKeyState, 2, 2) == 2 &&
                         size == 16 && read && write && read != write;
    if (context) observe_pipe_security(attributes, security);
    const bool matched = context && security.complete && security.attributesPresent &&
        security.attributesLength == sizeof(SECURITY_ATTRIBUTES) && !security.inheritedHandle && !security.descriptorPresent;
    SignalPipeDescriptor descriptor = {};
    bool appended = false;
    const char* adaptation = "outside-exact-contract";
    if (matched) {
        const char* rejected = nullptr;
        DWORD identityError = 0;
        if (!not_impersonating(rejected, identityError)) adaptation = rejected;
        else {
            appended = current_default_pipe_descriptor(descriptor);
            adaptation = appended ? "new-anonymous-default-template" : "token-default-not-admitted";
        }
    }
    SetLastError(before);
    const BOOL result = realCreateTrackerPipe(read, write, appended ? &descriptor.attributes : attributes, size);
    const DWORD after = GetLastError();
    if (matched && InterlockedIncrement(&trackerPipeRecords) <= 8) {
        // CreatePipe documents indeterminate outputs on failure. Never read
        // or close them then; successful outputs stay owned by canonical MSYS.
        char readValue[32] = "null", writeValue[32] = "null";
        if (result) {
            _snprintf_s(readValue, sizeof(readValue), _TRUNCATE, "\"0x%llx\"", observed_native_handle(read, 0));
            _snprintf_s(writeValue, sizeof(writeValue), _TRUNCATE, "\"0x%llx\"", observed_native_handle(write, 0));
        }
        char line[640];
        const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
            "NEMOCLAW_MSYS_TRACKER_PIPE={\"schemaVersion\":1,\"pid\":%lu,\"operation\":\"CreatePipe\",\"size\":%lu,\"resultSuccess\":%s,\"win32Error\":%lu,\"outputHandlesObserved\":%s,\"readHandle\":%s,\"writeHandle\":%s,\"requestDescriptorAppended\":%s,\"appendedAccess\":\"0x%08lx\",\"requestInheritHandles\":false,\"adaptation\":\"%s\"}\n",
            GetCurrentProcessId(), size, result ? "true" : "false", after, result ? "true" : "false", readValue, writeValue,
            appended ? "true" : "false", appended ? static_cast<ULONG>(signal_writer_access) : 0UL, adaptation);
        DWORD written = 0;
        writingPipeDiagnostic = true;
        if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
        writingPipeDiagnostic = false;
    }
    SetLastError(after);
    return result;
}

// Canonical shared.5 is a noninheritable, pagefile-backed read/write section.
// Its wrapper requests standard ownership rights even when reopening it. Keep
// that original attempt; only a denied existing-object open may use map rights.
struct SharedSectionRequest {
    bool bound = false;
    bool exact = false;
    bool pinfo = false;
    bool userShared = false;
    DWORD cygpid = 0;
    WCHAR name[192] = L"shared.5";
    char label[192] = "shared.5";
    USHORT nameBytes = 16;
    ULONG attributes = 0;
    LONGLONG size = 0;
    PipeSecurityObservation security = {};
    OBJECT_ATTRIBUTES originalAttributes = {};
};

void bind_shared_directory(PHANDLE output) {
    if (InterlockedCompareExchange(&sharedDirectoryState, 1, 0) != 0) return;
    const DWORD before = GetLastError();
    HANDLE copy = nullptr;
    DWORD error = 0;
    const char* kind = "invalid-output";
    __try {
        if (output && *output) {
            const BOOL duplicated = DuplicateHandle(GetCurrentProcess(), *output, GetCurrentProcess(), &copy, 0, FALSE, DUPLICATE_SAME_ACCESS);
            if (duplicated) kind = "success";
            else { error = GetLastError(); kind = "win32"; copy = nullptr; }
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) { kind = "seh"; error = GetExceptionCode(); copy = nullptr; }
    heldSharedDirectory = copy;
    InterlockedExchange(&sharedDirectoryState, copy ? 2 : 3);
    char line[320];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_SHARED_BIND={\"schemaVersion\":1,\"pid\":%lu,\"bound\":%s,\"kind\":\"%s\",\"error\":%lu}\n",
        GetCurrentProcessId(), copy ? "true" : "false", kind, error);
    DWORD written = 0;
    writingPipeDiagnostic = true;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    writingPipeDiagnostic = false;
    SetLastError(before);
}

bool pid_link_number(PUNICODE_STRING input, const WCHAR* prefix, size_t prefixLength,
                     DWORD minimum, DWORD maximum, DWORD& number, WCHAR* copy, USHORT& bytes);

SharedSectionRequest inspect_shared_section(ACCESS_MASK access, POBJECT_ATTRIBUTES input,
                                            PLARGE_INTEGER size, ULONG protection, ULONG allocation, HANDLE file,
                                            SignalPipeDescriptor* pinfoDescriptor = nullptr) {
    SharedSectionRequest result = {};
    __try {
        if (InterlockedCompareExchange(&sharedDirectoryState, 2, 2) != 2 || !sameKernelObject ||
            !input || input->Length != sizeof(OBJECT_ATTRIBUTES) || !input->RootDirectory ||
            !input->ObjectName || !sameKernelObject(input->RootDirectory, heldSharedDirectory)) return result;
        const bool shared = input->ObjectName->Length == 16 && input->ObjectName->MaximumLength >= 16 &&
            input->ObjectName->Buffer && memcmp(input->ObjectName->Buffer, L"shared.5", 16) == 0;
        if (!shared) {
            if (userSectionNameBytes && input->ObjectName->Length == userSectionNameBytes &&
                input->ObjectName->MaximumLength >= userSectionNameBytes && input->ObjectName->Buffer &&
                memcmp(input->ObjectName->Buffer, userSectionName, userSectionNameBytes) == 0) {
                result.userShared = true;
                result.nameBytes = userSectionNameBytes;
                memcpy(result.name, userSectionName, userSectionNameBytes + sizeof(WCHAR));
                memcpy(result.label, userSectionLabel, userSectionNameBytes / sizeof(WCHAR) + 1);
            } else {
                if (!pid_link_number(input->ObjectName, L"cygpid.", 7, 2, 4194303,
                                     result.cygpid, result.name, result.nameBytes)) return result;
                result.pinfo = true;
                for (USHORT n = 0; n < result.nameBytes / sizeof(WCHAR); ++n) result.label[n] = static_cast<char>(result.name[n]);
                result.label[result.nameBytes / sizeof(WCHAR)] = 0;
            }
        }
        result.bound = true;
        result.attributes = input->Attributes;
        result.originalAttributes = *input;
        if (size) result.size = size->QuadPart;
        SECURITY_ATTRIBUTES attributes = {sizeof(SECURITY_ATTRIBUTES), input->SecurityDescriptor,
                                           (input->Attributes & OBJ_INHERIT) != 0};
        observe_pipe_security(&attributes, result.security);
        const auto& sd = result.security;
        const char* rejected = nullptr;
        DWORD identityError = 0;
        ULONG expectedAttributes = OBJ_OPENIF | OBJ_CASE_INSENSITIVE;
        if (result.userShared) expectedAttributes |= OBJ_INHERIT;
        result.exact = access == 0x000f0007 && input->Attributes == expectedAttributes &&
            !input->SecurityQualityOfService && size && result.size > 0 && result.size <= MAXDWORD &&
            protection == PAGE_READWRITE && allocation == SEC_COMMIT && !file &&
            sd.complete && not_impersonating(rejected, identityError);
        if (result.userShared) {
            // sec_none has a NULL descriptor and inherit=TRUE. Snapshot and
            // preserve the admitted canonical token default, not a NULL DACL.
            result.exact = result.exact && !sd.descriptorPresent && pinfoDescriptor &&
                current_default_pipe_descriptor(*pinfoDescriptor, shared_section_container_access);
        } else result.exact = result.exact && sd.descriptorPresent && sd.control == SE_DACL_PRESENT &&
            sd.revision == SECURITY_DESCRIPTOR_REVISION && !sd.ownerPresent && !sd.groupPresent &&
            !sd.ownerDefaulted && !sd.groupDefaulted;
        if (result.pinfo) {
            // The pinned _pinfo is explicitly kept below one 64 KiB allocation.
            // Preserve the requested size; validate every original ACE before appending.
            void* userAce = nullptr;
            result.exact = result.exact && result.size <= 65536 && pinfoDescriptor &&
                GetAce(reinterpret_cast<PACL>(privateDescriptor.acl), 0, &userAce) &&
                append_pinfo_container_ace(sd, &static_cast<ACCESS_ALLOWED_ACE*>(userAce)->SidStart,
                                          worldSid, pidLinkContainerSid, *pinfoDescriptor);
        } else if (!result.userShared) result.exact = result.exact && sd.nullDacl;
    } __except (EXCEPTION_EXECUTE_HANDLER) { result.exact = false; }
    return result;
}

void log_shared_section(const SharedSectionRequest& request, ACCESS_MASK access, ULONG protection,
                        ULONG allocation, NTSTATUS originalStatus, NTSTATUS finalStatus,
                        bool attempted, NTSTATUS openStatus, NTSTATUS queryStatus,
                        LONGLONG actualSize, ULONG actualAllocation, HANDLE originalHandle, bool reused, bool descriptorAdapted) {
    if (InterlockedIncrement(&sharedSectionRecords) > 32) return;
    alignas(void*) BYTE descriptor[2048] = {};
    DWORD required = 0, descriptorError = 0;
    const bool descriptorRead = originalHandle && GetKernelObjectSecurity(originalHandle,
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
        descriptor, sizeof(descriptor), &required);
    if (originalHandle && !descriptorRead) descriptorError = GetLastError();
    char descriptorHex[sizeof(descriptor) * 2 + 1] = {};
    constexpr char hex[] = "0123456789abcdef";
    if (descriptorRead && required <= sizeof(descriptor))
        for (DWORD n = 0; n < required; ++n) {
            descriptorHex[n * 2] = hex[descriptor[n] >> 4];
            descriptorHex[n * 2 + 1] = hex[descriptor[n] & 15];
        }
    char line[6144];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_SHARED_SECTION={\"schemaVersion\":1,\"pid\":%lu,\"name\":\"%s\",\"pinfo\":%s,\"userShared\":%s,\"cygpid\":%lu,\"parentHandleBound\":true,\"exactContract\":%s,\"requestDescriptorAdapted\":%s,\"sectionUserAccess\":%lu,\"sectionContainerAccess\":%lu,\"access\":\"0x%08lx\",\"objectAttributes\":\"0x%08lx\",\"requestedSize\":%lld,\"protection\":%lu,\"allocation\":%lu,\"inputSecurityComplete\":%s,\"inputDescriptorPresent\":%s,\"inputControl\":%u,\"inputRevision\":%lu,\"inputOwnerPresent\":%s,\"inputGroupPresent\":%s,\"inputNullDacl\":%s,\"inputAceCount\":%lu,\"originalStatus\":\"0x%08lx\",\"finalStatus\":\"0x%08lx\",\"existingOnlyOpenAttempted\":%s,\"openAccess\":7,\"openStatus\":\"0x%08lx\",\"queryStatus\":\"0x%08lx\",\"actualSectionSize\":%lld,\"actualAllocation\":%lu,\"existingSectionReused\":%s,\"originalResultDescriptorAttempted\":%s,\"originalResultDescriptorRead\":%s,\"descriptorError\":%lu,\"descriptorRequiredBytes\":%lu,\"descriptorHex\":\"%s\"}\n",
        GetCurrentProcessId(), request.label, request.pinfo ? "true" : "false", request.userShared ? "true" : "false", request.cygpid,
        request.exact ? "true" : "false", descriptorAdapted ? "true" : "false",
        descriptorAdapted ? ((request.pinfo || request.userShared) ? GENERIC_ALL : shared_section_user_access) : 0UL,
        descriptorAdapted ? shared_section_container_access : 0UL,
        access, request.attributes,
        request.size, protection, allocation, request.security.complete ? "true" : "false",
        request.security.descriptorPresent ? "true" : "false", static_cast<unsigned>(request.security.control),
        request.security.revision, request.security.ownerPresent ? "true" : "false",
        request.security.groupPresent ? "true" : "false", request.security.nullDacl ? "true" : "false",
        request.security.aceCount, static_cast<ULONG>(originalStatus), static_cast<ULONG>(finalStatus),
        attempted ? "true" : "false", static_cast<ULONG>(openStatus), static_cast<ULONG>(queryStatus),
        actualSize, actualAllocation, reused ? "true" : "false", originalHandle ? "true" : "false",
        descriptorRead ? "true" : "false", descriptorError, required, descriptorHex);
    DWORD written = 0;
    writingPipeDiagnostic = true;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    writingPipeDiagnostic = false;
}

NTSTATUS NTAPI create_shared_section(PHANDLE output, ACCESS_MASK access, POBJECT_ATTRIBUTES input,
                                     PLARGE_INTEGER size, ULONG protection, ULONG allocation, HANDLE file) {
    if (writingPipeDiagnostic) return realCreateSharedSection(output, access, input, size, protection, allocation, file);
    const DWORD before = GetLastError();
    SignalPipeDescriptor pinfoDescriptor = {};
    const SharedSectionRequest request = inspect_shared_section(access, input, size, protection, allocation, file, &pinfoDescriptor);
    OBJECT_ATTRIBUTES adapted = request.originalAttributes;
    const bool descriptorAdapted = request.exact;
    UNICODE_STRING name = {request.nameBytes, static_cast<USHORT>(request.nameBytes + 2), const_cast<PWSTR>(request.name)};
    if (descriptorAdapted) {
        adapted.SecurityDescriptor = (request.pinfo || request.userShared)
            ? &pinfoDescriptor.descriptor : &sharedSectionDescriptor.descriptor;
        adapted.RootDirectory = heldSharedDirectory;
        adapted.ObjectName = &name;
    }
    SetLastError(before);
    // OBJ_OPENIF ignores this descriptor on an existing object. Only creation
    // receives the actual-user/AppContainer ACL; access and all other fields stay intact.
    const NTSTATUS originalStatus = realCreateSharedSection(output, access, descriptorAdapted ? &adapted : input, size, protection, allocation, file);
    const DWORD after = GetLastError();
    NTSTATUS finalStatus = originalStatus, openStatus = 0, queryStatus = 0;
    bool attempted = false, reused = false;
    LONGLONG actualSize = 0;
    ULONG actualAllocation = 0;
    HANDLE originalHandle = nullptr;
    // NtCreateSection does not promise a meaningful output on failure.
    if (originalStatus >= 0) {
        __try { if (output) originalHandle = *output; }
        __except (EXCEPTION_EXECUTE_HANDLER) { originalHandle = nullptr; }
    }
    if (request.exact && output && originalStatus == static_cast<NTSTATUS>(0xc0000022)) {
        OBJECT_ATTRIBUTES attributes = {};
        attributes.Length = sizeof(attributes);
        attributes.RootDirectory = heldSharedDirectory;
        attributes.ObjectName = &name;
        attributes.Attributes = OBJ_CASE_INSENSITIVE;
        if (request.userShared) attributes.Attributes |= OBJ_INHERIT;
        HANDLE existing = nullptr;
        attempted = true;
        openStatus = realOpenSharedSection(&existing, 0x7, &attributes);
        if (openStatus >= 0) {
            struct SectionBasic { PVOID base; ULONG attributes; LARGE_INTEGER size; } basic = {};
            queryStatus = realQuerySharedSection(existing, 0, &basic, sizeof(basic), nullptr);
            if (queryStatus >= 0) { actualSize = basic.size.QuadPart; actualAllocation = basic.attributes; }
            if (queryStatus >= 0 && actualSize >= request.size && actualAllocation == SEC_COMMIT) {
                __try { *output = existing; reused = true; }
                __except (EXCEPTION_EXECUTE_HANDLER) { reused = false; }
            }
            if (reused) finalStatus = static_cast<NTSTATUS>(0x40000000); // Existing object; wrapper emits ERROR_ALREADY_EXISTS.
            else CloseHandle(existing);
        }
    }
    if (request.bound) log_shared_section(request, access, protection, allocation, originalStatus, finalStatus,
        attempted, openStatus, queryStatus, actualSize, actualAllocation, originalHandle, reused, descriptorAdapted);
    SetLastError(after);
    return finalStatus;
}

NTSTATUS NTAPI observe_pinfo_section_open(PHANDLE output, ACCESS_MASK access, POBJECT_ATTRIBUTES input) {
    if (writingPipeDiagnostic) return realOpenSharedSection(output, access, input);
    const DWORD before = GetLastError();
    bool bound = false;
    DWORD cygpid = 0; WCHAR name[24] = {}; USHORT bytes = 0;
    __try {
        bound = InterlockedCompareExchange(&sharedDirectoryState, 2, 2) == 2 && sameKernelObject &&
            input && input->Length == sizeof(OBJECT_ATTRIBUTES) && input->RootDirectory &&
            sameKernelObject(input->RootDirectory, heldSharedDirectory) &&
            input->Attributes == OBJ_CASE_INSENSITIVE && !input->SecurityDescriptor && !input->SecurityQualityOfService &&
            (access == FILE_MAP_READ || access == (FILE_MAP_READ | FILE_MAP_WRITE)) &&
            pid_link_number(input->ObjectName, L"cygpid.", 7, 2, 4194303, cygpid, name, bytes);
    } __except (EXCEPTION_EXECUTE_HANDLER) { bound = false; }
    SetLastError(before);
    const NTSTATUS status = realOpenSharedSection(output, access, input);
    const DWORD after = GetLastError();
    if (bound && InterlockedIncrement(&sharedSectionRecords) <= 32) {
        char line[320];
        const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
            "NEMOCLAW_MSYS_PINFO_OPEN={\"schemaVersion\":1,\"pid\":%lu,\"cygpid\":%lu,\"access\":%lu,\"nativeStatus\":\"0x%08lx\",\"parentHandleBound\":true}\n",
            GetCurrentProcessId(), cygpid, access, static_cast<ULONG>(status));
        DWORD written = 0;
        writingPipeDiagnostic = true;
        if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
        writingPipeDiagnostic = false;
    }
    SetLastError(after);
    return status;
}

struct SharedMutexRequest {
    bool bound = false;
    bool exact = false;
    const WCHAR* name = nullptr;
    const char* label = "";
    OBJECT_ATTRIBUTES attributes = {};
    PipeSecurityObservation security = {};
};

SharedMutexRequest inspect_shared_mutex(ACCESS_MASK access, POBJECT_ATTRIBUTES input, BOOLEAN owner) {
    SharedMutexRequest result = {};
    __try {
        if (InterlockedCompareExchange(&sharedDirectoryState, 2, 2) != 2 || !sameKernelObject ||
            !input || input->Length != sizeof(OBJECT_ATTRIBUTES) || !input->RootDirectory ||
            !input->ObjectName || input->ObjectName->Length != 34 ||
            input->ObjectName->MaximumLength < 34 || !input->ObjectName->Buffer ||
            !sameKernelObject(input->RootDirectory, heldSharedDirectory)) return result;
        if (memcmp(input->ObjectName->Buffer, L"tty_list::mutex.0", 34) == 0) {
            result.name = L"tty_list::mutex.0";
            result.label = "tty_list::mutex.0";
        } else if (memcmp(input->ObjectName->Buffer, L"cyg.loadavg.mutex", 34) == 0) {
            result.name = L"cyg.loadavg.mutex";
            result.label = "cyg.loadavg.mutex";
        } else return result;
        result.bound = true;
        result.attributes = *input;
        SECURITY_ATTRIBUTES attributes = {sizeof(SECURITY_ATTRIBUTES), input->SecurityDescriptor,
                                           (input->Attributes & OBJ_INHERIT) != 0};
        observe_pipe_security(&attributes, result.security);
        const auto& sd = result.security;
        const char* rejected = nullptr;
        DWORD identityError = 0;
        result.exact = access == shared_mutex_user_access && owner == FALSE &&
            input->Attributes == (OBJ_OPENIF | OBJ_CASE_INSENSITIVE) && !input->SecurityQualityOfService &&
            sd.complete && sd.descriptorPresent && sd.control == SE_DACL_PRESENT &&
            sd.revision == SECURITY_DESCRIPTOR_REVISION && !sd.ownerPresent && !sd.groupPresent &&
            !sd.ownerDefaulted && !sd.groupDefaulted && sd.nullDacl &&
            not_impersonating(rejected, identityError);
    } __except (EXCEPTION_EXECUTE_HANDLER) { result.exact = false; }
    return result;
}

void log_shared_mutex(const SharedMutexRequest& request, ACCESS_MASK access, BOOLEAN owner,
                      NTSTATUS originalStatus, NTSTATUS finalStatus, bool attempted,
                      NTSTATUS openStatus, HANDLE originalHandle, bool reused) {
    if (InterlockedIncrement(&sharedMutexRecords) > 8) return;
    alignas(void*) BYTE descriptor[2048] = {};
    DWORD required = 0, descriptorError = 0;
    const bool descriptorRead = originalHandle && GetKernelObjectSecurity(originalHandle,
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
        descriptor, sizeof(descriptor), &required);
    if (originalHandle && !descriptorRead) descriptorError = GetLastError();
    char descriptorHex[sizeof(descriptor) * 2 + 1] = {};
    constexpr char hex[] = "0123456789abcdef";
    if (descriptorRead && required <= sizeof(descriptor))
        for (DWORD n = 0; n < required; ++n) {
            descriptorHex[n * 2] = hex[descriptor[n] >> 4];
            descriptorHex[n * 2 + 1] = hex[descriptor[n] & 15];
        }
    char line[6144];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_SHARED_MUTEX={\"schemaVersion\":1,\"pid\":%lu,\"name\":\"%s\",\"parentHandleBound\":true,\"exactContract\":%s,\"requestDescriptorAdapted\":%s,\"access\":\"0x%08lx\",\"containerAccess\":\"0x%08lx\",\"initialOwner\":%u,\"objectAttributes\":\"0x%08lx\",\"inputDescriptorPresent\":%s,\"inputControl\":%u,\"inputNullDacl\":%s,\"originalStatus\":\"0x%08lx\",\"finalStatus\":\"0x%08lx\",\"existingOnlyOpenAttempted\":%s,\"openStatus\":\"0x%08lx\",\"existingMutexReused\":%s,\"originalResultDescriptorAttempted\":%s,\"originalResultDescriptorRead\":%s,\"descriptorError\":%lu,\"descriptorRequiredBytes\":%lu,\"descriptorHex\":\"%s\"}\n",
        GetCurrentProcessId(), request.label, request.exact ? "true" : "false", request.exact ? "true" : "false",
        access, shared_mutex_container_access, static_cast<unsigned>(owner), request.attributes.Attributes,
        request.security.descriptorPresent ? "true" : "false", static_cast<unsigned>(request.security.control),
        request.security.nullDacl ? "true" : "false", static_cast<ULONG>(originalStatus), static_cast<ULONG>(finalStatus),
        attempted ? "true" : "false", static_cast<ULONG>(openStatus), reused ? "true" : "false",
        originalHandle ? "true" : "false", descriptorRead ? "true" : "false", descriptorError, required, descriptorHex);
    DWORD written = 0;
    writingPipeDiagnostic = true;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    writingPipeDiagnostic = false;
}

NTSTATUS NTAPI create_shared_mutex(PHANDLE output, ACCESS_MASK access, POBJECT_ATTRIBUTES input, BOOLEAN owner) {
    if (writingPipeDiagnostic) return realCreateSharedMutex(output, access, input, owner);
    const DWORD before = GetLastError();
    const SharedMutexRequest request = inspect_shared_mutex(access, input, owner);
    OBJECT_ATTRIBUTES adapted = request.attributes;
    if (request.exact) adapted.SecurityDescriptor = &sharedMutexDescriptor.descriptor;
    SetLastError(before);
    const NTSTATUS originalStatus = realCreateSharedMutex(output, access, request.exact ? &adapted : input, owner);
    const DWORD after = GetLastError();
    NTSTATUS finalStatus = originalStatus, openStatus = 0;
    bool attempted = false, reused = false;
    HANDLE originalHandle = nullptr;
    if (originalStatus >= 0) {
        __try { if (output) originalHandle = *output; }
        __except (EXCEPTION_EXECUTE_HANDLER) { originalHandle = nullptr; }
    }
    if (request.exact && output && originalStatus == static_cast<NTSTATUS>(0xc0000022)) {
        UNICODE_STRING name = {34, 36, const_cast<PWSTR>(request.name)};
        OBJECT_ATTRIBUTES attributes = {};
        attributes.Length = sizeof(attributes);
        attributes.RootDirectory = heldSharedDirectory;
        attributes.ObjectName = &name;
        attributes.Attributes = OBJ_CASE_INSENSITIVE;
        HANDLE existing = nullptr;
        attempted = true;
        openStatus = realOpenSharedMutex(&existing, shared_mutex_container_access, &attributes);
        // Never read or close either native API's indeterminate failed output.
        if (openStatus >= 0) {
            __try { *output = existing; reused = true; }
            __except (EXCEPTION_EXECUTE_HANDLER) { reused = false; }
            if (reused) finalStatus = static_cast<NTSTATUS>(0x40000000);
            else CloseHandle(existing);
        }
    }
    if (request.bound) log_shared_mutex(request, access, owner, originalStatus, finalStatus,
        attempted, openStatus, originalHandle, reused);
    else observe_failed_private_mutant(input, access, owner, originalStatus, after, _ReturnAddress());
    SetLastError(after);
    return finalStatus;
}

struct IoObservation {
    const char* operation = "";
    const char* family = "";
    NTSTATUS status = 0;
    DWORD lastError = 0;
    PVOID caller = nullptr;
    HANDLE handles[8] = {};
    ULONG handleCount = 0;
    ULONG originalHandleCount = 0;
    bool handlesReadable = true;
    ULONG requestedBytes = 0;
    ACCESS_MASK requestedAccess = 0;
    ULONG flags = 0;
    ULONG auxiliary = 0;
    ULONG eventType = 0;
    bool descriptorPresent = false;
    bool requestReadable = true;
    bool unusualOutcome = false;
    bool completionKnown = false;
    NTSTATUS completionStatus = 0;
    ULONG_PTR transferred = 0;
    LARGE_INTEGER qpc = {};
    LARGE_INTEGER qpcFrequency = {};
    ULONGLONG tickMilliseconds = 0;
    bool clockKnown = false;
};

void stamp_io_observation(IoObservation& record) {
    const DWORD saved = GetLastError();
    record.tickMilliseconds = GetTickCount64();
    record.clockKnown = QueryPerformanceCounter(&record.qpc) && QueryPerformanceFrequency(&record.qpcFrequency);
    SetLastError(saved);
}

const char* observed_io_image() {
    WCHAR name[1024] = {};
    const DWORD length = GetModuleFileNameW(nullptr, name, 1024);
    if (!length || length >= 1024) return "unavailable";
    const WCHAR* leaf = name;
    for (DWORD n = 0; n < length; ++n) if (name[n] == L'\\' || name[n] == L'/') leaf = name + n + 1;
    if (lstrcmpiW(leaf, L"bash.exe") == 0) return "bash.exe";
    if (lstrcmpiW(leaf, L"cat.exe") == 0) return "cat.exe";
    if (lstrcmpiW(leaf, L"grep.exe") == 0) return "grep.exe";
    if (lstrcmpiW(leaf, L"node.exe") == 0) return "node.exe";
    return "other";
}

void log_io_observation(const IoObservation& record) {
    if (writingPipeDiagnostic || !GetModuleHandleW(L"msys-2.0.dll")) return;
    // Failures have their own budget, so ordinary startup traffic cannot hide
    // the first failed write/wait/event. These counters do not change any API.
    LONG* successBudget = strcmp(record.operation, "NtReadFile") == 0 ? &ioReadSuccessRecords : &ioSuccessRecords;
    if ((record.status < 0 || record.unusualOutcome) ? InterlockedIncrement(&ioFailureRecords) > 32 :
                            InterlockedIncrement(successBudget) > 16) return;
    writingPipeDiagnostic = true;
    const LONG sequence = InterlockedIncrement(&ioRecordSequence);
    HMODULE callerModule = nullptr;
    unsigned long long callerRva = 0;
    const bool msysCaller = GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, reinterpret_cast<LPCWSTR>(record.caller), &callerModule) &&
        callerModule == GetModuleHandleW(L"msys-2.0.dll");
    if (msysCaller) callerRva = reinterpret_cast<ULONG_PTR>(record.caller) - reinterpret_cast<ULONG_PTR>(callerModule);
    unsigned long long msysFrames[4] = {};
    ULONG msysFrameCount = 0;
    if (record.status < 0 || record.unusualOutcome) {
        PVOID frames[16] = {};
        const USHORT count = CaptureStackBackTrace(0, 16, frames, nullptr);
        for (USHORT n = 0; n < count && msysFrameCount < 4; ++n) {
            HMODULE module = nullptr;
            if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                reinterpret_cast<LPCWSTR>(frames[n]), &module) && module == GetModuleHandleW(L"msys-2.0.dll"))
                msysFrames[msysFrameCount++] = reinterpret_cast<ULONG_PTR>(frames[n]) - reinterpret_cast<ULONG_PTR>(module);
        }
    }
    char line[2048];
    int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_NATIVE_IO={\"schemaVersion\":1,\"pid\":%lu,\"tid\":%lu,\"sequence\":%ld,\"operation\":\"%s\",\"image\":\"%s\",\"clockKnown\":%s,\"qpcTicks\":\"%lld\",\"qpcFrequency\":\"%lld\",\"tickMilliseconds\":\"%llu\",\"family\":\"%s\",\"nativeStatus\":\"0x%08lx\",\"lastError\":%lu,\"msysCaller\":%s,\"callerRva\":\"0x%llx\",\"msysFrameCount\":%lu,\"msysFrames\":[\"0x%llx\",\"0x%llx\",\"0x%llx\",\"0x%llx\"],\"handleCount\":%lu,\"originalHandleCount\":%lu,\"handlesReadable\":%s,\"requestedBytes\":%lu,\"requestedAccess\":\"0x%08lx\",\"flags\":%lu,\"auxiliary\":%lu,\"eventType\":%lu,\"descriptorPresent\":%s,\"requestReadable\":%s,\"pending\":%s,\"unusualOutcome\":%s,\"completionKnown\":%s,\"completionStatus\":\"0x%08lx\",\"transferredBytes\":%llu}\n",
        GetCurrentProcessId(), GetCurrentThreadId(), sequence, record.operation, observed_io_image(),
        record.clockKnown ? "true" : "false", record.qpc.QuadPart, record.qpcFrequency.QuadPart,
        static_cast<unsigned long long>(record.tickMilliseconds), record.family,
        static_cast<ULONG>(record.status), record.lastError, msysCaller ? "true" : "false", callerRva,
        msysFrameCount, msysFrames[0], msysFrames[1], msysFrames[2], msysFrames[3],
        record.handleCount, record.originalHandleCount, record.handlesReadable ? "true" : "false",
        record.requestedBytes, record.requestedAccess, record.flags, record.auxiliary, record.eventType,
        record.descriptorPresent ? "true" : "false", record.requestReadable ? "true" : "false",
        record.status == 0x103 ? "true" : "false", record.unusualOutcome ? "true" : "false", record.completionKnown ? "true" : "false",
        static_cast<ULONG>(record.completionStatus), static_cast<unsigned long long>(record.transferred));
    DWORD written = 0;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    for (ULONG index = 0; record.status != 0x103 && index < record.handleCount; ++index) {
        const HANDLE handle = record.handles[index];
        PUBLIC_OBJECT_BASIC_INFORMATION basic = {};
        const NTSTATUS basicStatus = queryKernelObject(handle, ObjectBasicInformation, &basic, sizeof(basic), nullptr);
        DWORD inheritance = 0;
        const BOOL inherited = GetHandleInformation(handle, &inheritance);
        const DWORD inheritanceError = inherited ? 0 : GetLastError();
        SetLastError(0);
        const DWORD fileType = GetFileType(handle);
        const DWORD fileTypeError = GetLastError();
        alignas(void*) BYTE typeStorage[1024] = {};
        const NTSTATUS typeStatus = queryKernelObject(handle, ObjectTypeInformation, typeStorage, sizeof(typeStorage), nullptr);
        char type[40] = {};
        if (typeStatus == 0) {
            const auto name = reinterpret_cast<UNICODE_STRING*>(typeStorage);
            const auto begin = reinterpret_cast<ULONG_PTR>(name->Buffer);
            const auto low = reinterpret_cast<ULONG_PTR>(typeStorage);
            if (!(name->Length % sizeof(WCHAR)) && name->Length <= 76 && begin >= low &&
                begin <= low + sizeof(typeStorage) - name->Length) {
                bool safe = true;
                for (USHORT n = 0; n < name->Length / sizeof(WCHAR); ++n) {
                    const WCHAR c = name->Buffer[n];
                    if (!((c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z'))) { safe = false; break; }
                    type[n] = static_cast<char>(c);
                }
                if (!safe) type[0] = 0;
            }
        }
        DWORD pipeFlags = 0;
        const bool pipeQueryAttempted = fileType == FILE_TYPE_PIPE;
        const bool pipeInfoKnown = pipeQueryAttempted && GetNamedPipeInfo(handle, &pipeFlags, nullptr, nullptr, nullptr);
        const DWORD pipeInfoError = pipeQueryAttempted && !pipeInfoKnown ? GetLastError() : 0;
        count = _snprintf_s(line, sizeof(line), _TRUNCATE,
            "NEMOCLAW_MSYS_IO_HANDLE={\"schemaVersion\":1,\"pid\":%lu,\"tid\":%lu,\"sequence\":%ld,\"index\":%lu,\"handle\":\"0x%llx\",\"basicStatus\":\"0x%08lx\",\"grantedAccessKnown\":%s,\"grantedAccess\":\"0x%08lx\",\"inheritanceKnown\":%s,\"inheritanceFlags\":%lu,\"inheritanceError\":%lu,\"objectTypeStatus\":\"0x%08lx\",\"objectType\":\"%s\",\"fileType\":%lu,\"fileTypeError\":%lu,\"pipeQueryAttempted\":%s,\"pipeInfoKnown\":%s,\"pipeInfoError\":%lu,\"pipeFlags\":%lu,\"serverEnd\":%s}\n",
            GetCurrentProcessId(), GetCurrentThreadId(), sequence, index, reinterpret_cast<unsigned long long>(handle),
            static_cast<ULONG>(basicStatus), basicStatus == 0 ? "true" : "false", basicStatus == 0 ? basic.GrantedAccess : 0UL,
            inherited ? "true" : "false", inherited ? inheritance : 0UL, inheritanceError, static_cast<ULONG>(typeStatus), type,
            fileType, fileTypeError, pipeQueryAttempted ? "true" : "false", pipeInfoKnown ? "true" : "false",
            pipeInfoError, pipeInfoKnown ? pipeFlags : 0UL, pipeInfoKnown && (pipeFlags & PIPE_SERVER_END) ? "true" : "false");
        if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    }
    writingPipeDiagnostic = false;
}

void observe_io_attributes(POBJECT_ATTRIBUTES attributes, IoObservation& record) {
    __try {
        if (attributes) {
            if (attributes->Length != sizeof(OBJECT_ATTRIBUTES)) { record.requestReadable = false; return; }
            record.flags = attributes->Attributes;
            record.descriptorPresent = attributes->SecurityDescriptor != nullptr;
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) { record.requestReadable = false; }
}

NTSTATUS NTAPI observe_io_write(HANDLE file, HANDLE event, NativeIoApc apc, PVOID context,
                               PIO_STATUS_BLOCK io, PVOID buffer, ULONG length, PLARGE_INTEGER offset, PULONG key) {
    const NTSTATUS status = realWriteIoFile(file, event, apc, context, io, buffer, length, offset, key);
    const DWORD after = GetLastError();
    if (!writingPipeDiagnostic) {
        IoObservation record = {};
        stamp_io_observation(record);
        record.operation = "NtWriteFile"; record.status = status; record.lastError = after; record.caller = _ReturnAddress();
        record.handles[0] = file; record.handleCount = 1;
        if (event) record.handles[record.handleCount++] = event;
        record.originalHandleCount = record.handleCount; record.requestedBytes = length;
        // Pending or failed I/O does not establish a completed output block.
        if (status == 0) {
            __try { if (io) { record.completionStatus = io->Status; record.transferred = io->Information; record.completionKnown = true; } }
            __except (EXCEPTION_EXECUTE_HANDLER) { record.completionKnown = false; }
            if (record.completionKnown && record.completionStatus < 0) record.unusualOutcome = true;
        }
        log_io_observation(record);
    }
    SetLastError(after);
    return status;
}


NTSTATUS NTAPI observe_io_read(HANDLE file, HANDLE event, NativeIoApc apc, PVOID context,
                               PIO_STATUS_BLOCK io, PVOID buffer, ULONG length, PLARGE_INTEGER offset, PULONG key) {
    const NTSTATUS status = realReadIoFile(file, event, apc, context, io, buffer, length, offset, key);
    const DWORD after = GetLastError();
    if (!writingPipeDiagnostic) {
        IoObservation record = {};
        stamp_io_observation(record);
        record.operation = "NtReadFile"; record.status = status; record.lastError = after; record.caller = _ReturnAddress();
        record.handles[0] = file; record.handleCount = 1;
        if (event) record.handles[record.handleCount++] = event;
        record.originalHandleCount = record.handleCount; record.requestedBytes = length;
        // Pending or failed I/O does not establish a completed output block.
        if (status == 0) {
            __try { if (io) { record.completionStatus = io->Status; record.transferred = io->Information; record.completionKnown = true; } }
            __except (EXCEPTION_EXECUTE_HANDLER) { record.completionKnown = false; }
            if (record.completionKnown && record.completionStatus < 0) record.unusualOutcome = true;
        }
        log_io_observation(record);
    }
    SetLastError(after);
    return status;
}

bool unusual_io_wait(NTSTATUS status, ULONG count, ULONG type, BOOLEAN alertable, bool timed) {
    if (status < 0) return true;
    if ((type == 0 && status == 0) || (type == 1 && static_cast<ULONG>(status) < count)) return false;
    if (status == 0x102 && timed) return false;
    if ((status == 0xc0 || status == 0x101) && alertable) return false;
    return true; // Includes abandoned mutexes, which MSYS raw_write handles as an error.
}

NTSTATUS NTAPI observe_io_wait_many(ULONG count, PHANDLE handles, ULONG waitType, BOOLEAN alertable, PLARGE_INTEGER timeout) {
    const NTSTATUS status = realWaitIoMany(count, handles, waitType, alertable, timeout);
    const DWORD after = GetLastError();
    if (!writingPipeDiagnostic && unusual_io_wait(status, count, waitType, alertable, timeout != nullptr)) {
        IoObservation record = {};
        stamp_io_observation(record);
        record.unusualOutcome = true;
        record.operation = "NtWaitForMultipleObjects"; record.status = status; record.lastError = after; record.caller = _ReturnAddress();
        record.originalHandleCount = count; record.flags = waitType; record.auxiliary = alertable;
        __try { if (handles) { for (ULONG n = 0; n < count && n < 8; ++n) record.handles[record.handleCount++] = handles[n]; } else record.handlesReadable = false; }
        __except (EXCEPTION_EXECUTE_HANDLER) { record.handlesReadable = false; }
        log_io_observation(record);
    }
    SetLastError(after);
    return status;
}

NTSTATUS NTAPI observe_io_wait_one(HANDLE handle, BOOLEAN alertable, PLARGE_INTEGER timeout) {
    const NTSTATUS status = realWaitIoOne(handle, alertable, timeout);
    const DWORD after = GetLastError();
    if (!writingPipeDiagnostic && unusual_io_wait(status, 1, 0, alertable, timeout != nullptr)) {
        IoObservation record = {};
        stamp_io_observation(record);
        record.unusualOutcome = true;
        record.operation = "NtWaitForSingleObject"; record.status = status; record.lastError = after; record.caller = _ReturnAddress();
        record.handles[0] = handle; record.handleCount = record.originalHandleCount = 1; record.auxiliary = alertable;
        log_io_observation(record);
    }
    SetLastError(after);
    return status;
}

NTSTATUS NTAPI observe_io_event(PHANDLE output, ACCESS_MASK access, POBJECT_ATTRIBUTES attributes, ULONG type, BOOLEAN initial) {
    const NTSTATUS status = realCreateIoEvent(output, access, attributes, type, initial);
    const DWORD after = GetLastError();
    if (!writingPipeDiagnostic && status < 0) {
        IoObservation record = {};
        stamp_io_observation(record);
        record.operation = "NtCreateEvent"; record.status = status; record.lastError = after; record.caller = _ReturnAddress();
        record.requestedAccess = access; record.eventType = type; record.auxiliary = initial;
        observe_io_attributes(attributes, record);
        log_io_observation(record);
    }
    SetLastError(after);
    return status;
}

void observe_failed_private_mutant(POBJECT_ATTRIBUTES input, ACCESS_MASK access, BOOLEAN owner,
                                   NTSTATUS status, DWORD error, PVOID caller) {
    if (writingPipeDiagnostic || status >= 0) return;
    IoObservation record = {};
    stamp_io_observation(record);
    record.operation = "NtCreateMutant-unadapted"; record.status = status; record.lastError = error;
    record.caller = caller; record.requestedAccess = access; record.auxiliary = owner;
    __try {
        if (InterlockedCompareExchange(&sharedDirectoryState, 2, 2) != 2 || !sameKernelObject ||
            !input || input->Length != sizeof(OBJECT_ATTRIBUTES) ||
            !sameKernelObject(input->RootDirectory, heldSharedDirectory)) return;
        record.family = "owned-private-other";
        if (input->ObjectName && input->ObjectName->Buffer && input->ObjectName->Length >= 16 &&
            input->ObjectName->MaximumLength >= input->ObjectName->Length &&
            memcmp(input->ObjectName->Buffer, L"cygpipe.", 16) == 0) record.family = "owned-private-cygpipe-mutex";
    } __except (EXCEPTION_EXECUTE_HANDLER) { return; }
    observe_io_attributes(input, record);
    log_io_observation(record);
}

struct PidLinkRequest {
    bool bound = false;
    bool exact = false;
    DWORD winpid = 0;
    DWORD cygpid = 0;
    WCHAR name[24] = {};
    WCHAR target[24] = {};
    USHORT nameBytes = 0;
    USHORT targetBytes = 0;
    OBJECT_ATTRIBUTES attributes = {};
    PipeSecurityObservation security = {};
};
struct PidLinkQuery {
    HANDLE handle;
    DWORD winpid;
    WCHAR name[24];
    USHORT nameBytes;
};
__declspec(thread) PidLinkQuery pendingPidLink = {};

bool pid_link_number(PUNICODE_STRING input, const WCHAR* prefix, size_t prefixLength,
                     DWORD minimum, DWORD maximum, DWORD& number, WCHAR* copy, USHORT& bytes) {
    __try {
        if (!input || !input->Buffer || input->Length % sizeof(WCHAR) || input->Length > 46 ||
            input->Length > input->MaximumLength || input->Length <= prefixLength * sizeof(WCHAR)) return false;
        const size_t count = input->Length / sizeof(WCHAR);
        if (prefixLength && memcmp(input->Buffer, prefix, prefixLength * sizeof(WCHAR)) != 0) return false;
        if (input->Buffer[prefixLength] == L'0') return false;
        DWORD parsed = 0;
        for (size_t n = prefixLength; n < count; ++n) {
            const WCHAR c = input->Buffer[n];
            if (c < L'0' || c > L'9') return false;
            const DWORD digit = static_cast<DWORD>(c - L'0');
            if (parsed > (maximum - digit) / 10) return false;
            parsed = parsed * 10 + digit;
        }
        if (parsed < minimum || parsed > maximum) return false;
        for (size_t n = 0; n < count; ++n) copy[n] = input->Buffer[n];
        copy[count] = 0;
        number = parsed; bytes = input->Length;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

PidLinkRequest inspect_pid_link(ACCESS_MASK access, POBJECT_ATTRIBUTES input, PUNICODE_STRING target, bool create) {
    PidLinkRequest result = {};
    __try {
        if (InterlockedCompareExchange(&sharedDirectoryState, 2, 2) != 2 || !sameKernelObject ||
            !input || input->Length != sizeof(OBJECT_ATTRIBUTES) || !input->RootDirectory ||
            !sameKernelObject(input->RootDirectory, heldSharedDirectory) ||
            !pid_link_number(input->ObjectName, L"winpid.", 7, 1, MAXDWORD, result.winpid, result.name, result.nameBytes)) return result;
        result.bound = true;
        result.attributes = *input;
        const char* rejected = nullptr;
        DWORD error = 0;
        result.exact = input->Attributes == OBJ_CASE_INSENSITIVE && !input->SecurityQualityOfService &&
            access == (create ? 0x000f0001u : 1u) && not_impersonating(rejected, error);
        if (create) {
            // thisproc assigns myself_initial.dwProcessId (current process),
            // including in a forkee, before create_winpid_symlink.
            result.exact = result.exact && result.winpid == GetCurrentProcessId() &&
                pid_link_number(target, L"", 0, 2, 4194303, result.cygpid, result.target, result.targetBytes);
            SECURITY_ATTRIBUTES attributes = {sizeof(SECURITY_ATTRIBUTES), input->SecurityDescriptor, FALSE};
            observe_pipe_security(&attributes, result.security);
        } else result.exact = result.exact && input->SecurityDescriptor == nullptr;
    } __except (EXCEPTION_EXECUTE_HANDLER) { result.exact = false; }
    return result;
}

void log_pid_link(const char* operation, DWORD winpid, DWORD cygpid, bool targetObserved,
                  NTSTATUS status, bool adapted, bool queryBound, HANDLE createdHandle = nullptr) {
    if (InterlockedIncrement(&pidLinkRecords) > 32) return;
    IoObservation clock = {};
    stamp_io_observation(clock);
    alignas(void*) BYTE descriptor[512] = {};
    DWORD required = 0, error = 0;
    bool descriptorRead = false;
    writingPipeDiagnostic = true;
    if (createdHandle) {
        descriptorRead = GetKernelObjectSecurity(createdHandle,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
            descriptor, sizeof(descriptor), &required) != FALSE;
        if (!descriptorRead) error = GetLastError();
    }
    char hex[1025] = {};
    constexpr char digits[] = "0123456789abcdef";
    if (descriptorRead && required <= sizeof(descriptor))
        for (DWORD n = 0; n < required; ++n) { hex[n * 2] = digits[descriptor[n] >> 4]; hex[n * 2 + 1] = digits[descriptor[n] & 15]; }
    char line[2048];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_PID_LINK={\"schemaVersion\":1,\"pid\":%lu,\"tid\":%lu,\"operation\":\"%s\",\"winpid\":%lu,\"cygpid\":%lu,\"targetObserved\":%s,\"nativeStatus\":\"0x%08lx\",\"descriptorAdapted\":%s,\"queryBoundToOwnObject\":%s,\"qpcTicks\":\"%lld\",\"qpcFrequency\":\"%lld\",\"descriptorRead\":%s,\"descriptorError\":%lu,\"descriptorBytes\":%lu,\"descriptorHex\":\"%s\"}\n",
        GetCurrentProcessId(), GetCurrentThreadId(), operation, winpid, cygpid, targetObserved ? "true" : "false",
        static_cast<ULONG>(status), adapted ? "true" : "false", queryBound ? "true" : "false",
        clock.qpc.QuadPart, clock.qpcFrequency.QuadPart, descriptorRead ? "true" : "false", error, required, hex);
    DWORD written = 0;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    writingPipeDiagnostic = false;
}

NTSTATUS NTAPI create_pid_link(PHANDLE output, ACCESS_MASK access, POBJECT_ATTRIBUTES input, PUNICODE_STRING target) {
    if (writingPipeDiagnostic) return realCreatePidLink(output, access, input, target);
    const DWORD before = GetLastError();
    pendingPidLink = {};
    PidLinkRequest request = inspect_pid_link(access, input, target, true);
    ScopedDescriptor descriptor = {};
    const bool adapted = request.exact && append_pid_link_container_ace(request.security, worldSid, pidLinkContainerSid, descriptor);
    UNICODE_STRING name = {request.nameBytes, static_cast<USHORT>(request.nameBytes + 2), request.name};
    UNICODE_STRING pid = {request.targetBytes, static_cast<USHORT>(request.targetBytes + 2), request.target};
    OBJECT_ATTRIBUTES attributes = request.attributes;
    if (adapted) { attributes.RootDirectory = heldSharedDirectory; attributes.ObjectName = &name; attributes.SecurityDescriptor = &descriptor.descriptor; }
    SetLastError(before);
    const NTSTATUS status = realCreatePidLink(output, access, adapted ? &attributes : input, adapted ? &pid : target);
    const DWORD after = GetLastError();
    HANDLE created = nullptr;
    if (status >= 0) { __try { if (output) created = *output; } __except (EXCEPTION_EXECUTE_HANDLER) {} }
    if (request.bound) log_pid_link("create", request.winpid, request.cygpid, request.targetBytes != 0, status, adapted, true, created);
    SetLastError(after);
    return status;
}

NTSTATUS NTAPI open_pid_link(PHANDLE output, ACCESS_MASK access, POBJECT_ATTRIBUTES input) {
    if (writingPipeDiagnostic) return realOpenPidLink(output, access, input);
    const DWORD before = GetLastError();
    pendingPidLink = {};
    const PidLinkRequest request = inspect_pid_link(access, input, nullptr, false);
    SetLastError(before);
    const NTSTATUS status = realOpenPidLink(output, access, input);
    const DWORD after = GetLastError();
    if (request.exact && status >= 0) {
        __try {
            if (output && *output) {
                pendingPidLink.handle = *output; pendingPidLink.winpid = request.winpid;
                pendingPidLink.nameBytes = request.nameBytes;
                memcpy(pendingPidLink.name, request.name, sizeof(request.name));
            }
        } __except (EXCEPTION_EXECUTE_HANDLER) { pendingPidLink = {}; }
    }
    if (request.bound) log_pid_link("open", request.winpid, 0, false, status, false, request.exact);
    SetLastError(after);
    return status;
}

NTSTATUS NTAPI query_pid_link(HANDLE handle, PUNICODE_STRING target, PULONG required) {
    if (writingPipeDiagnostic) return realQueryPidLink(handle, target, required);
    const DWORD before = GetLastError();
    const PidLinkQuery pending = pendingPidLink;
    pendingPidLink = {};
    bool bound = false;
    // No link handle is retained across calls. Reopen only the just-observed
    // own name, compare the actual objects, then close before returning.
    HANDLE comparison = nullptr;
    if (pending.handle == handle && handle && pending.winpid) {
        UNICODE_STRING name = {pending.nameBytes, static_cast<USHORT>(pending.nameBytes + 2), const_cast<PWSTR>(pending.name)};
        OBJECT_ATTRIBUTES attributes = {};
        attributes.Length = sizeof(attributes); attributes.RootDirectory = heldSharedDirectory;
        attributes.ObjectName = &name; attributes.Attributes = OBJ_CASE_INSENSITIVE;
        const NTSTATUS opened = realOpenPidLink(&comparison, 1, &attributes);
        if (opened >= 0) {
            bound = sameKernelObject && sameKernelObject(handle, comparison);
            CloseHandle(comparison);
        }
    }
    SetLastError(before);
    const NTSTATUS status = realQueryPidLink(handle, target, required);
    const DWORD after = GetLastError();
    if (pending.handle == handle && pending.winpid) {
        DWORD pid = 0; WCHAR copied[24] = {}; USHORT bytes = 0;
        const bool observed = bound && status >= 0 && pid_link_number(target, L"", 0, 2, 4194303, pid, copied, bytes);
        log_pid_link("query", pending.winpid, pid, observed, status, false, bound);
    }
    SetLastError(after);
    return status;
}

#if defined(_M_X64)
LONG observedAccessViolations = 0;
PVOID faultObserver = nullptr;

void logFaultFrame(DWORD event, unsigned frame, DWORD64 address) {
    HMODULE module = nullptr;
    WCHAR fullName[MAX_PATH] = {};
    char name[96] = "unknown";
    DWORD64 base = 0;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(address), &module)) {
        base = reinterpret_cast<DWORD64>(module);
        const DWORD count = GetModuleFileNameW(module, fullName, MAX_PATH);
        if (count && count < MAX_PATH) {
            const WCHAR* leaf = fullName;
            for (DWORD i = 0; i < count; ++i) if (fullName[i] == L'\\' || fullName[i] == L'/') leaf = fullName + i + 1;
            unsigned i = 0;
            for (; leaf[i] && i < sizeof(name) - 1; ++i) {
                const WCHAR c = leaf[i];
                name[i] = ((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') ||
                    (c >= L'0' && c <= L'9') || c == L'.' || c == L'_' || c == L'-') ? static_cast<char>(c) : '?';
            }
            name[i] = 0;
        }
    }
    char line[448];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_FAULT_FRAME={\"schemaVersion\":1,\"pid\":%lu,\"event\":%lu,\"frame\":%u,\"address\":\"0x%llx\",\"module\":\"%s\",\"moduleBase\":\"0x%llx\",\"rva\":\"0x%llx\"}\n",
        GetCurrentProcessId(), event, frame, address, name, base, base ? address - base : 0);
    DWORD written = 0;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
}

LONG CALLBACK observeAccessViolation(EXCEPTION_POINTERS* exception) {
    const DWORD saved = GetLastError();
    if (!exception || !exception->ExceptionRecord || !exception->ContextRecord ||
        exception->ExceptionRecord->ExceptionCode != EXCEPTION_ACCESS_VIOLATION) return EXCEPTION_CONTINUE_SEARCH;
    const LONG event = InterlockedIncrement(&observedAccessViolations);
    if (event > 4) return EXCEPTION_CONTINUE_SEARCH;
    // First-chance evidence only. Unwind a copy; never alter the fault context,
    // handle the exception, record arbitrary memory contents, or write a dump.
    __try {
        const EXCEPTION_RECORD* record = exception->ExceptionRecord;
        CONTEXT context = *exception->ContextRecord;
        char line[448];
        const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
            "NEMOCLAW_MSYS_ACCESS_VIOLATION={\"schemaVersion\":1,\"pid\":%lu,\"event\":%ld,\"code\":\"0x%08lx\",\"firstChance\":true,\"accessKind\":%llu,\"target\":\"0x%llx\",\"rip\":\"0x%llx\",\"contextChanged\":false}\n",
            GetCurrentProcessId(), event, record->ExceptionCode,
            record->NumberParameters >= 1 ? static_cast<unsigned long long>(record->ExceptionInformation[0]) : 0,
            record->NumberParameters >= 2 ? static_cast<unsigned long long>(record->ExceptionInformation[1]) : 0,
            static_cast<unsigned long long>(context.Rip));
        DWORD written = 0;
        if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
        ULONG_PTR stackLow = 0, stackHigh = 0;
        GetCurrentThreadStackLimits(&stackLow, &stackHigh);
        for (unsigned frame = 0; frame < 8 && context.Rip; ++frame) {
            logFaultFrame(static_cast<DWORD>(event), frame, context.Rip);
            if (frame == 7 || !stackLow || stackHigh <= stackLow || context.Rsp < stackLow ||
                context.Rsp >= stackHigh || stackHigh - context.Rsp < sizeof(DWORD64)) break;
            const DWORD64 previousRip = context.Rip, previousRsp = context.Rsp;
            DWORD64 imageBase = 0, establisher = 0;
            PVOID handlerData = nullptr;
            PRUNTIME_FUNCTION function = RtlLookupFunctionEntry(context.Rip, &imageBase, nullptr);
            if (function) {
                RtlVirtualUnwind(UNW_FLAG_NHANDLER, imageBase, context.Rip, function, &context, &handlerData, &establisher, nullptr);
            } else {
                // A leaf frame has one return address. SEH bounds this read when
                // the fault left an invalid stack; no stack bytes are recorded.
                if (context.Rsp & 7) break;
                context.Rip = *reinterpret_cast<const DWORD64*>(context.Rsp);
                context.Rsp += 8;
            }
            if (context.Rsp <= previousRsp || context.Rsp < stackLow || context.Rsp >= stackHigh ||
                context.Rip == previousRip) break;
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        // Diagnostic faults must never replace the original access violation.
    }
    SetLastError(saved);
    return EXCEPTION_CONTINUE_SEARCH;
}

void installFaultObserver() {
    const DWORD saved = GetLastError();
    WCHAR ci[8] = {}, mode[16] = {};
    if (GetEnvironmentVariableW(L"GITHUB_ACTIONS", ci, 8) == 4 && !wcscmp(ci, L"true") &&
        GetEnvironmentVariableW(L"NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD", mode, 16) == 12 && !wcscmp(mode, L"repair-query")) {
        faultObserver = AddVectoredExceptionHandler(1, observeAccessViolation);
        const DWORD error = faultObserver ? 0 : GetLastError();
        char line[192];
        const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
            "NEMOCLAW_MSYS_FAULT_OBSERVER={\"schemaVersion\":1,\"pid\":%lu,\"registered\":%s,\"error\":%lu}\n",
            GetCurrentProcessId(), faultObserver ? "true" : "false", error);
        DWORD written = 0;
        if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    }
    SetLastError(saved);
}
void removeFaultObserver() {
    const DWORD saved = GetLastError();
    if (faultObserver) { RemoveVectoredExceptionHandler(faultObserver); faultObserver = nullptr; }
    SetLastError(saved);
}
#else
void installFaultObserver() {}
void removeFaultObserver() {}
#endif

} // namespace

BOOL WINAPI DllMain(HINSTANCE self, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_DETACH) { removeFaultObserver(); if (heldSharedDirectory) CloseHandle(heldSharedDirectory); return TRUE; }
    if (DetourIsHelperProcess()) return TRUE;
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    DetourRestoreAfterWith();
    if (!initialize_namespace()) return initialization_result("namespace-context", GetLastError() ? GetLastError() : ERROR_DLL_INIT_FAILED);
    if (!NemoClawInitializeProcessContext(self)) return initialization_result("process-context", GetLastError() ? GetLastError() : ERROR_DLL_INIT_FAILED);
    NemoClawLogCurrentImageLayout();
    LONG error = DetourTransactionBegin();
    if (error) return initialization_result("transaction-begin", error);
    error = DetourUpdateThread(GetCurrentThread());
    if (!error) error = NemoClawStageProcessPropagation();
    if (!error) error = DetourAttach(&realCreate, create_directory);
    if (!error) error = DetourAttach(&realOpen, open_directory);
    if (!error) error = DetourAttach(&realCreateSharedSection, create_shared_section);
    if (!error) error = DetourAttach(&realOpenSharedSection, observe_pinfo_section_open);
    if (!error) error = DetourAttach(&realCreateSharedMutex, create_shared_mutex);
    if (!error) error = DetourAttach(&realCreatePidLink, create_pid_link);
    if (!error) error = DetourAttach(&realOpenPidLink, open_pid_link);
    if (!error) error = DetourAttach(&realQueryPidLink, query_pid_link);
    if (!error) error = DetourAttach(&realWriteIoFile, observe_io_write);
    if (!error) error = DetourAttach(&realReadIoFile, observe_io_read);
    if (!error) error = DetourAttach(&realWaitIoMany, observe_io_wait_many);
    if (!error) error = DetourAttach(&realWaitIoOne, observe_io_wait_one);
    if (!error) error = DetourAttach(&realCreateIoEvent, observe_io_event);
    if (!error) error = DetourAttach(&realCreateSignalServer, observe_signal_server);
    if (!error) error = DetourAttach(&realOpenSignalWriter, observe_signal_writer);
    if (!error) error = DetourAttach(&realCreateTrackerPipe, create_tracker_pipe);
    if (!error) error = DetourAttach(&realNativePipeCreate, observe_native_create);
    if (!error) error = DetourAttach(&realNativeFileOpen, observe_native_open);
    if (error) {
        DetourTransactionAbort();
        return initialization_result("hook-staging", error);
    }
    error = DetourTransactionCommit();
    if (!error) installFaultObserver();
    return initialization_result(error ? "transaction-commit" : "attached", error);
}
