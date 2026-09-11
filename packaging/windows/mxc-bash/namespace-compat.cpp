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
#include "namespace-path.h"
#include "namespace-security.h"
#include "process-propagation.h"

namespace {
using namespace nemoclaw_msys;
using DirectoryCall = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES);
DirectoryCall realCreate = nullptr;
DirectoryCall realOpen = nullptr;
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
LONG pipeRecords = 0;
__declspec(thread) bool writingPipeDiagnostic = false;
WCHAR privateRoot[maximum_root_characters] = {};
WCHAR apiRoot[maximum_root_characters] = {};
size_t privateRootLength = 0;
DWORD ownSession = 0;
alignas(void*) BYTE worldSid[SECURITY_MAX_SID_SIZE] = {};
ScopedDescriptor privateDescriptor = {};
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
        stage = "token-user";
        if (!GetTokenInformation(token, TokenUser, userBuffer, sizeof(userBuffer), &needed)) { error = GetLastError(); break; }
        auto user = reinterpret_cast<TOKEN_USER*>(userBuffer)->User.Sid;
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

bool current_default_pipe_descriptor(SignalPipeDescriptor& output) {
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
                        &static_cast<ACCESS_ALLOWED_ACE*>(userAce)->SidStart, expectedContainer, output);
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
    if (!error) error = DetourAttach(&realCreateSignalServer, observe_signal_server);
    if (!error) error = DetourAttach(&realOpenSignalWriter, observe_signal_writer);
    if (!error) error = DetourAttach(&realNativePipeCreate, observe_native_create);
    if (!error) error = DetourAttach(&realNativeFileOpen, observe_native_open);
    if (error) {
        DetourTransactionAbort();
        return initialization_result("hook-staging", error);
    }
    error = DetourTransactionCommit();
    return initialization_result(error ? "transaction-commit" : "attached", error);
}
