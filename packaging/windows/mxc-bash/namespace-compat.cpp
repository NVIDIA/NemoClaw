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
        if (redirect) log_result(match, create, status);
        else log_rejected(match, create, access, attributes.Attributes, rejected, rejectionError, status);
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

// These two observers do not redirect or repair pipes. They preserve original
// argument pointers, handles and immediate last-error values on every path.
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
                     const PipeSecurityObservation& security) {
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
        "NEMOCLAW_MSYS_SIGNAL_PIPE={\"schemaVersion\":1,\"pid\":%lu,\"operation\":\"%s\",\"name\":\"%s\",\"accessOrOpenMode\":\"0x%08lx\",\"pipeMode\":\"0x%08lx\",\"maxInstances\":%lu,\"outBufferBytes\":%lu,\"inBufferBytes\":%lu,\"defaultTimeout\":%lu,\"shareMode\":\"0x%08lx\",\"creationDisposition\":%lu,\"flags\":\"0x%08lx\",\"resultSuccess\":%s,\"win32Error\":%lu,\"securityInspectionComplete\":%s,\"attributesPresent\":%s,\"attributesLength\":%lu,\"inheritHandle\":%d,\"descriptorPresent\":%s,\"descriptorControl\":\"0x%04x\",\"descriptorRevision\":%lu,\"daclPresent\":%s,\"nullDacl\":%s,\"aclBytes\":%lu,\"aceCount\":%lu,\"capturedAclBytes\":%lu,\"aclTruncated\":%s,\"aclHex\":\"%s\"}\n",
        GetCurrentProcessId(), operation, escaped, access, mode, instances, outBuffer, inBuffer, timeout,
        share, disposition, flags, result && result != INVALID_HANDLE_VALUE ? "true" : "false", error,
        security.complete ? "true" : "false", security.attributesPresent ? "true" : "false",
        security.attributesLength, security.inheritedHandle, security.descriptorPresent ? "true" : "false",
        static_cast<unsigned>(security.control), security.revision, security.daclPresent ? "true" : "false",
        security.nullDacl ? "true" : "false", security.aclBytes, security.aceCount, security.capturedAclBytes,
        security.capturedAclBytes < security.aclBytes ? "true" : "false", aclHex);
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
    SetLastError(before);
    HANDLE result = realCreateSignalServer(name, openMode, pipeMode, maxInstances, outBuffer, inBuffer, timeout, attributes);
    const DWORD error = GetLastError();
    if (observed) log_signal_pipe(copied, "server-create", openMode, pipeMode, maxInstances,
        outBuffer, inBuffer, timeout, 0, 0, 0, result, error, security);
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
    if (error) {
        DetourTransactionAbort();
        return initialization_result("hook-staging", error);
    }
    error = DetourTransactionCommit();
    return initialization_result(error ? "transaction-commit" : "attached", error);
}
