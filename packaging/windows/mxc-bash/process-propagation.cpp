// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "process-propagation.h"
#include <detours.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include <stdint.h>

namespace {
WCHAR moduleDirectory[MAX_PATH] = {};
alignas(SID) BYTE containerSid[SECURITY_MAX_SID_SIZE] = {};
BOOL initialized = FALSE;
__declspec(thread) BOOL withinCreate = FALSE;
decltype(&CreateProcessW) realCreateW = CreateProcessW;
decltype(&CreateProcessA) realCreateA = CreateProcessA;
decltype(&CreateProcessAsUserW) realCreateAsUserW = CreateProcessAsUserW;
decltype(&CreateProcessAsUserA) realCreateAsUserA = CreateProcessAsUserA;
decltype(&SetInformationJobObject) realSetJobInformation = SetInformationJobObject;

// The canonical MSYS image does not opt into DYNAMIC_BASE and fork expects
// its DLL data at identical addresses. This explicit prototype option changes
// only mandatory relocation; images opting into ASLR keep their normal policy.
bool preferredMsysLayout() {
    const DWORD saved = GetLastError();
    WCHAR ci[8] = {}, mode[16] = {};
    const bool enabled = initialized && GetEnvironmentVariableW(L"GITHUB_ACTIONS", ci, 8) == 4 && !wcscmp(ci, L"true") &&
        GetEnvironmentVariableW(L"NEMOCLAW_MSYS_IMAGE_LAYOUT", mode, 16) == 9 && !wcscmp(mode, L"preferred");
    SetLastError(saved);
    return enabled;
}

bool observeDerivedMsysLayout() {
    const DWORD saved = GetLastError();
    WCHAR ci[8] = {}, mode[4] = {};
    const bool enabled = initialized && GetEnvironmentVariableW(L"GITHUB_ACTIONS", ci, 8) == 4 && !wcscmp(ci, L"true") &&
        GetEnvironmentVariableW(L"NEMOCLAW_MSYS_ASLR_METADATA", mode, 4) == 1 && !wcscmp(mode, L"1");
    SetLastError(saved);
    return enabled;
}

template<class Startup, class Extended> struct MsysCreationLayout {
    Startup* startup = nullptr;
    Extended extended = {};
    DWORD flags = 0;
    bool requested = false, applied = false, preservedExtended = false, attributesInitialized = false;
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = nullptr;
    DWORD64 policy = 0x0000000000000200ULL; // FORCE_RELOCATE_IMAGES_ALWAYS_OFF, no other override.
    bool ready(Startup* original, DWORD originalFlags) {
        startup = original; flags = originalFlags; requested = preferredMsysLayout();
        if (!requested) return true;
        // Never replace an opaque caller-owned attribute list or a nonstandard
        // startup structure. The canonical launcher and MSYS fork use basic SI.
        preservedExtended = (flags & EXTENDED_STARTUPINFO_PRESENT) != 0;
        if (preservedExtended || !original || original->cb != sizeof(Startup)) return true;
        SIZE_T needed = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &needed);
        if (!needed || needed > 4096) { SetLastError(ERROR_INVALID_DATA); return false; }
        attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, needed));
        if (!attributes) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); return false; }
        if (!InitializeProcThreadAttributeList(attributes, 1, 0, &needed)) return false;
        attributesInitialized = true;
        if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
                &policy, sizeof(policy), nullptr, nullptr)) return false;
        extended.StartupInfo = *original; // Includes cbReserved2/lpReserved2 and every stdio/desktop field.
        extended.StartupInfo.cb = sizeof(Extended);
        extended.lpAttributeList = attributes;
        startup = &extended.StartupInfo;
        flags |= EXTENDED_STARTUPINFO_PRESENT;
        applied = true;
        return true;
    }
    ~MsysCreationLayout() {
        const DWORD saved = GetLastError();
        if (attributes) { if (attributesInitialized) DeleteProcThreadAttributeList(attributes); HeapFree(GetProcessHeap(), 0, attributes); }
        SetLastError(saved);
    }
};

struct MsysMappedLayout {
    DWORD64 base = 0, preferred = 0, caps = 0;
    DWORD size = 0;
    WORD characteristics = 0;
    BOOL exactShape = FALSE;
};
MsysMappedLayout mappedImageLayout(HMODULE module, bool msys) {
    MsysMappedLayout value;
    if (!module) return value;
    value.base = reinterpret_cast<DWORD64>(module);
    __try {
        const BYTE* base = reinterpret_cast<const BYTE*>(module);
        const auto dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
        if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 64 || dos->e_lfanew > 1024) return value;
        const auto pe = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
        if (pe->Signature != IMAGE_NT_SIGNATURE ||
            (pe->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 && pe->FileHeader.Machine != IMAGE_FILE_MACHINE_ARM64) ||
            pe->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) return value;
        value.preferred = pe->OptionalHeader.ImageBase;
        value.size = pe->OptionalHeader.SizeOfImage;
        value.characteristics = pe->OptionalHeader.DllCharacteristics;
        // Normal ASLR updates the mapped optional-header ImageBase. Accept
        // that form only for the already-selected derived metadata variant.
        const bool expectedBase = value.preferred == 0x210040000ULL ||
            (observeDerivedMsysLayout() && value.characteristics == IMAGE_DLLCHARACTERISTICS_DYNAMIC_BASE &&
             value.preferred == value.base);
        value.exactShape = msys && pe->FileHeader.Machine == IMAGE_FILE_MACHINE_AMD64 &&
            expectedBase && value.size == 0x360000 &&
            pe->FileHeader.TimeDateStamp == 0x69c910a9;
        if (value.exactShape) value.caps = *reinterpret_cast<const DWORD64*>(base + 0x34d198);
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
    return value;
}
void logMsysCreationLayout(HANDLE child, bool requested, bool applied, bool preservedExtended) {
    const bool derived = observeDerivedMsysLayout();
    if (!preferredMsysLayout() && !derived) return;
    const DWORD saved = GetLastError();
    PROCESS_MITIGATION_ASLR_POLICY parentPolicy = {}, childPolicy = {};
    const BOOL parentKnown = GetProcessMitigationPolicy(GetCurrentProcess(), ProcessASLRPolicy, &parentPolicy, sizeof(parentPolicy));
    const DWORD parentError = parentKnown ? 0 : GetLastError();
    const BOOL childKnown = child && GetProcessMitigationPolicy(child, ProcessASLRPolicy, &childPolicy, sizeof(childPolicy));
    const DWORD childError = child && !childKnown ? GetLastError() : 0;
    const MsysMappedLayout module = mappedImageLayout(GetModuleHandleW(L"msys-2.0.dll"), true);
    const MsysMappedLayout executable = mappedImageLayout(GetModuleHandleW(nullptr), false);
    char line[1536];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_IMAGE_LAYOUT={\"schemaVersion\":1,\"pid\":%lu,\"childPid\":%lu,\"requested\":%s,\"applied\":%s,\"existingExtendedAttributesPreserved\":%s,\"creationPolicy\":\"%s\",\"derivedMsysMetadata\":%s,\"parentAslrKnown\":%s,\"parentAslrFlags\":%lu,\"parentAslrError\":%lu,\"childAslrKnown\":%s,\"childAslrFlags\":%lu,\"childAslrError\":%lu,\"msysBase\":\"0x%llx\",\"msysPreferredBase\":\"0x%llx\",\"msysImageSize\":%lu,\"msysDllCharacteristics\":%u,\"exactMsysShape\":%s,\"capsPointer\":\"0x%llx\",\"mainImageBase\":\"0x%llx\",\"mainPreferredBase\":\"0x%llx\",\"mainDllCharacteristics\":%u}\n",
        GetCurrentProcessId(), child ? GetProcessId(child) : 0, requested ? "true" : "false", applied ? "true" : "false", preservedExtended ? "true" : "false",
        applied ? "0x0000000000000200" : "unchanged", derived ? "true" : "false",
        parentKnown ? "true" : "false", parentPolicy.Flags, parentError, childKnown ? "true" : "false", childPolicy.Flags, childError,
        module.base, module.preferred, module.size, static_cast<unsigned>(module.characteristics), module.exactShape ? "true" : "false", module.caps,
        executable.base, executable.preferred, static_cast<unsigned>(executable.characteristics));
    DWORD written = 0;
    if (count > 0 && NemoClawMsysDiagnosticsEnabled()) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
    SetLastError(saved);
}

uint16_t machineFromPeHeader(const unsigned char* header, size_t size) {
    if (size < 26 || header[0] != 'P' || header[1] != 'E' || header[2] || header[3]) return 0;
    const uint16_t machine = static_cast<uint16_t>(header[4] | (header[5] << 8));
    const uint16_t optionalSize = static_cast<uint16_t>(header[20] | (header[21] << 8));
    const uint16_t characteristics = static_cast<uint16_t>(header[22] | (header[23] << 8));
    if (optionalSize < 2 || header[24] != 0x0b || header[25] != 0x02 ||
        !(characteristics & 0x0002) || (characteristics & 0x2000)) return 0;
    return machine == 0xaa64 || machine == 0x8664 ? machine : 0;
}

struct ProcessImageFile {
    HANDLE handle = INVALID_HANDLE_VALUE;
    WCHAR path[4096] = {};
    BY_HANDLE_FILE_INFORMATION information = {};
    ~ProcessImageFile() {
        const DWORD error = GetLastError();
        if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
        SetLastError(error);
    }
};

BOOL readProcessImageMachine(HANDLE process, ProcessImageFile& image, USHORT& machine) {
    WCHAR* fileName = image.path;
    DWORD count = static_cast<DWORD>(sizeof(image.path) / sizeof(image.path[0]));
    if (!QueryFullProcessImageNameW(process, 0, fileName, &count)) return FALSE;
    image.handle = CreateFileW(fileName, GENERIC_READ, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (image.handle == INVALID_HANDLE_VALUE) return FALSE;
    BY_HANDLE_FILE_INFORMATION& info = image.information;
    if (!GetFileInformationByHandle(image.handle, &info)) return FALSE;
    if (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) {
        SetLastError(ERROR_BAD_EXE_FORMAT); return FALSE;
    }
    BYTE dos[64] = {};
    DWORD read = 0;
    if (!ReadFile(image.handle, dos, sizeof(dos), &read, nullptr)) return FALSE;
    if (read != sizeof(dos) || dos[0] != 'M' || dos[1] != 'Z') {
        SetLastError(ERROR_BAD_EXE_FORMAT); return FALSE;
    }
    const DWORD offset = static_cast<DWORD>(dos[60]) | (static_cast<DWORD>(dos[61]) << 8) |
        (static_cast<DWORD>(dos[62]) << 16) | (static_cast<DWORD>(dos[63]) << 24);
    const ULONGLONG fileSize = (static_cast<ULONGLONG>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
    if (offset < sizeof(dos) || offset > 1024 * 1024 || static_cast<ULONGLONG>(offset) + 26 > fileSize) {
        SetLastError(ERROR_BAD_EXE_FORMAT); return FALSE;
    }
    LARGE_INTEGER position = {}; position.QuadPart = offset;
    if (!SetFilePointerEx(image.handle, position, nullptr, FILE_BEGIN)) return FALSE;
    BYTE header[26] = {};
    if (!ReadFile(image.handle, header, sizeof(header), &read, nullptr)) return FALSE;
    machine = machineFromPeHeader(header, read);
    if (!machine) { SetLastError(ERROR_BAD_EXE_FORMAT); return FALSE; }
    return TRUE;
}

struct TokenProof {
    const char* operation = "not-called";
    const char* kind = "not-called";
    DWORD apiError = 0;
    BOOL appContainerKnown = FALSE;
    DWORD appContainer = 0;
    BOOL sidPresent = FALSE;
    BOOL sidValid = FALSE;
    BOOL sidCopied = FALSE;
};
LONG tokenProofRecords = 0;

BOOL processContainerSid(HANDLE process, BYTE* output, TokenProof* observed = nullptr) {
    TokenProof proof;
    HANDLE token = nullptr;
    proof.operation = "OpenProcessToken";
    if (!OpenProcessToken(process, TOKEN_QUERY, &token)) {
        proof.kind = "win32-api-failure"; proof.apiError = GetLastError();
        if (observed) *observed = proof;
        return FALSE;
    }
    DWORD appContainer = 0, needed = 0;
    alignas(TOKEN_APPCONTAINER_INFORMATION) BYTE buffer[sizeof(TOKEN_APPCONTAINER_INFORMATION) + SECURITY_MAX_SID_SIZE] = {};
    proof.operation = "GetTokenInformation/TokenIsAppContainer";
    BOOL result = GetTokenInformation(token, TokenIsAppContainer, &appContainer,
                                     sizeof(appContainer), &needed);
    proof.appContainerKnown = result;
    proof.appContainer = appContainer;
    if (!result) { proof.kind = "win32-api-failure"; proof.apiError = GetLastError(); }
    if (result && appContainer) {
        proof.operation = "GetTokenInformation/TokenAppContainerSid";
        result = GetTokenInformation(token, TokenAppContainerSid, buffer, sizeof(buffer), &needed);
        if (!result) { proof.kind = "win32-api-failure"; proof.apiError = GetLastError(); }
        if (result) {
            const auto info = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(buffer);
            proof.operation = "IsValidSid/GetLengthSid";
            proof.sidPresent = info->TokenAppContainer != nullptr;
            proof.sidValid = proof.sidPresent && IsValidSid(info->TokenAppContainer)
                && GetLengthSid(info->TokenAppContainer) <= SECURITY_MAX_SID_SIZE;
            result = proof.sidValid;
            if (result) {
                proof.operation = "CopySid";
                result = CopySid(SECURITY_MAX_SID_SIZE, output, info->TokenAppContainer);
                if (!result) { proof.kind = "win32-api-failure"; proof.apiError = GetLastError(); }
                proof.sidCopied = result;
            } else proof.kind = "invalid-sid";
        }
    } else {
        if (result) proof.kind = "not-appcontainer";
        result = FALSE;
        SetLastError(ERROR_ACCESS_DENIED);
    }
    DWORD error = result ? ERROR_SUCCESS : GetLastError();
    if (!result && !error) error = ERROR_INVALID_SID;
    if (result) proof.kind = "success";
    CloseHandle(token);
    if (observed) *observed = proof;
    SetLastError(error);
    return result;
}

void logTokenProof(HANDLE child, const TokenProof& proof, BOOL queried, BOOL sameSid,
                   BOOL jobKnown, BOOL inJob, DWORD jobError) {
    const DWORD saved = GetLastError();
    if (InterlockedIncrement(&tokenProofRecords) <= 16) {
        char line[896];
        const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
            "NEMOCLAW_MSYS_TOKEN_PROOF={\"schemaVersion\":1,\"parentPid\":%lu,\"childPid\":%lu,\"sourceApi\":\"%s\",\"resultKind\":\"%s\",\"apiError\":%lu,\"tokenIsAppContainerKnown\":%s,\"tokenIsAppContainer\":%lu,\"sidPresent\":%s,\"sidValid\":%s,\"sidCopied\":%s,\"parentIdentityInitialized\":%s,\"tokenProbeAttempted\":%s,\"sidComparisonPerformed\":%s,\"sameAppContainer\":%s,\"jobQuerySucceeded\":%s,\"inJob\":%s,\"jobQueryError\":%lu}\n",
            GetCurrentProcessId(), GetProcessId(child), proof.operation, proof.kind, proof.apiError,
            proof.appContainerKnown ? "true" : "false", proof.appContainer,
            proof.sidPresent ? "true" : "false", proof.sidValid ? "true" : "false", proof.sidCopied ? "true" : "false",
            initialized ? "true" : "false", initialized ? "true" : "false", queried ? "true" : "false", sameSid ? "true" : "false",
            jobKnown ? "true" : "false", inJob ? "true" : "false", jobError);
        DWORD written = 0;
        if (length > 0 && NemoClawMsysDiagnosticsEnabled()) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
    }
    SetLastError(saved);
}

void logPropagation(DWORD pid, USHORT machine, BOOL sameSid, BOOL inJob, BOOL injected, DWORD error) {
    char line[512];
    const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_PROPAGATION={\"schemaVersion\":1,\"parentPid\":%lu,\"childPid\":%lu,\"machine\":%u,\"sameAppContainer\":%s,\"inJob\":%s,\"injected\":%s,\"error\":%lu}\n",
        GetCurrentProcessId(), pid, static_cast<unsigned>(machine), sameSid ? "true" : "false",
        inJob ? "true" : "false", injected ? "true" : "false", error);
    DWORD written = 0;
    if (length > 0 && NemoClawMsysDiagnosticsEnabled()) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
}

// Failure-only readback of the existing process handle and current caller.
// A process descriptor is not the primary token's descriptor. No handle is
// reopened, no rights/context are changed, and none of this can admit a child.
void logTokenOpenDenial(HANDLE child) {
    static LONG records = 0;
    const DWORD saved = GetLastError();
    if (InterlockedIncrement(&records) > 4) { SetLastError(saved); return; }
    struct BasicInformation {
        ULONG attributes; ACCESS_MASK grantedAccess; ULONG handleCount; ULONG pointerCount; ULONG reserved[10];
    } basic = {};
    static_assert(sizeof(BasicInformation) == 56);
    using QueryObject = LONG (NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
    const auto query = reinterpret_cast<QueryObject>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryObject"));
    const DWORD resolveError = query ? 0 : GetLastError();
    ULONG basicNeeded = 0;
    const LONG basicStatus = query ? query(child, 0, &basic, sizeof(basic), &basicNeeded) : 0;
    const BOOL basicKnown = query && basicStatus == 0;
    alignas(void*) BYTE descriptor[1024] = {};
    DWORD descriptorNeeded = 0, descriptorError = 0, descriptorLength = 0, validationError = 0;
    BOOL descriptorAttempted = basicKnown && (basic.grantedAccess & READ_CONTROL);
    BOOL descriptorRead = FALSE, descriptorValid = FALSE;
    if (descriptorAttempted) {
        descriptorRead = GetKernelObjectSecurity(child,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            descriptor, sizeof(descriptor), &descriptorNeeded);
        descriptorError = descriptorRead ? 0 : GetLastError();
        if (descriptorRead) {
            __try {
                SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
                if (!GetSecurityDescriptorControl(descriptor, &control, &revision)) validationError = GetLastError();
                else if ((control & SE_SELF_RELATIVE) && IsValidSecurityDescriptor(descriptor)) {
                    descriptorLength = GetSecurityDescriptorLength(descriptor);
                    descriptorValid = descriptorLength >= 20 && descriptorLength <= sizeof(descriptor);
                }
            } __except (EXCEPTION_EXECUTE_HANDLER) { validationError = GetExceptionCode(); }
        }
    }
    char descriptorHex[sizeof(descriptor) * 2 + 1] = {};
    if (descriptorValid) for (DWORD index = 0; index < descriptorLength; ++index) {
        descriptorHex[index * 2] = "0123456789abcdef"[descriptor[index] >> 4];
        descriptorHex[index * 2 + 1] = "0123456789abcdef"[descriptor[index] & 15];
    }
    HANDLE threadToken = nullptr;
    const BOOL threadOpened = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &threadToken);
    const DWORD threadError = threadOpened ? 0 : GetLastError();
    DWORD threadType = 0, threadLevel = 0, threadAppContainer = 0, needed = 0;
    BOOL typeKnown = FALSE, levelKnown = FALSE, appKnown = FALSE;
    DWORD typeError = 0, levelError = 0, appError = 0, closeError = 0;
    if (threadOpened) {
        typeKnown = GetTokenInformation(threadToken, TokenType, &threadType, sizeof(threadType), &needed);
        typeError = typeKnown ? 0 : GetLastError();
        if (typeKnown && threadType == TokenImpersonation) {
            levelKnown = GetTokenInformation(threadToken, TokenImpersonationLevel, &threadLevel, sizeof(threadLevel), &needed);
            levelError = levelKnown ? 0 : GetLastError();
        }
        appKnown = GetTokenInformation(threadToken, TokenIsAppContainer, &threadAppContainer, sizeof(threadAppContainer), &needed);
        appError = appKnown ? 0 : GetLastError();
        if (!CloseHandle(threadToken)) closeError = GetLastError();
    }
    char line[4096];
    const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_TOKEN_OPEN_DENIAL={\"schemaVersion\":1,\"parentPid\":%lu,\"childPid\":%lu,\"objectQueryAvailable\":%s,\"objectQueryResolveError\":%lu,\"objectBasicStatus\":\"0x%08lx\",\"objectBasicKnown\":%s,\"objectBasicNeeded\":%lu,\"grantedAccess\":\"0x%08lx\",\"processQueryLimitedGranted\":%s,\"processReadControlGranted\":%s,\"processSdAttempted\":%s,\"processSdRead\":%s,\"processSdError\":%lu,\"processSdNeeded\":%lu,\"processSdValid\":%s,\"processSdLength\":%lu,\"processSdValidationError\":%lu,\"processSdHex\":\"%s\",\"threadTokenOpened\":%s,\"threadTokenOpenError\":%lu,\"threadHasNoToken\":%s,\"threadTypeKnown\":%s,\"threadType\":%lu,\"threadTypeError\":%lu,\"threadLevelKnown\":%s,\"threadLevel\":%lu,\"threadLevelError\":%lu,\"threadAppContainerKnown\":%s,\"threadAppContainer\":%lu,\"threadAppContainerError\":%lu,\"threadTokenCloseError\":%lu}\n",
        GetCurrentProcessId(), GetProcessId(child), query ? "true" : "false", resolveError,
        static_cast<ULONG>(basicStatus), basicKnown ? "true" : "false", basicNeeded, basicKnown ? basic.grantedAccess : 0UL,
        basicKnown && (basic.grantedAccess & PROCESS_QUERY_LIMITED_INFORMATION) ? "true" : "false",
        descriptorAttempted ? "true" : "false", descriptorAttempted ? "true" : "false", descriptorRead ? "true" : "false",
        descriptorError, descriptorNeeded, descriptorValid ? "true" : "false", descriptorLength, validationError, descriptorHex,
        threadOpened ? "true" : "false", threadError, !threadOpened && threadError == ERROR_NO_TOKEN ? "true" : "false",
        typeKnown ? "true" : "false", threadType, typeError, levelKnown ? "true" : "false", threadLevel, levelError,
        appKnown ? "true" : "false", threadAppContainer, appError, closeError);
    DWORD written = 0;
    if (length > 0 && NemoClawMsysDiagnosticsEnabled()) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
    SetLastError(saved);
}

void holdFailedForkForInspection(HANDLE child) {
    const DWORD saved = GetLastError();
    WCHAR enabled[2] = {};
    if (GetEnvironmentVariableW(L"NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD", enabled, 2) != 1 || enabled[0] != L'1') {
        SetLastError(saved); return;
    }
    static LONG used = 0;
    if (InterlockedCompareExchange(&used, 1, 0) != 0) { SetLastError(saved); return; }
    DWORD error = 0; BOOL published = FALSE, acknowledged = FALSE;
    ULONGLONG parentTime = 0, childTime = 0, elapsed = 0;
    do {
        FILETIME parentCreated = {}, childCreated = {}, exit = {}, kernel = {}, user = {};
        if (!GetProcessTimes(GetCurrentProcess(), &parentCreated, &exit, &kernel, &user) ||
            !GetProcessTimes(child, &childCreated, &exit, &kernel, &user)) { error = GetLastError(); break; }
        parentTime = (static_cast<ULONGLONG>(parentCreated.dwHighDateTime) << 32) | parentCreated.dwLowDateTime;
        childTime = (static_cast<ULONGLONG>(childCreated.dwHighDateTime) << 32) | childCreated.dwLowDateTime;
        WCHAR root[MAX_PATH] = {}, request[MAX_PATH] = {}, reply[MAX_PATH] = {};
        const DWORD count = GetCurrentDirectoryW(MAX_PATH, root);
        if (!count || count >= MAX_PATH || swprintf_s(request, L"%s\\msys-token-inspection.request", root) < 0 ||
            swprintf_s(reply, L"%s\\msys-token-inspection.ack", root) < 0) { error = ERROR_BUFFER_OVERFLOW; break; }
        char frame[128];
        const int length = _snprintf_s(frame, sizeof(frame), _TRUNCATE, "1 %lu %llu %lu %llu\n",
            GetCurrentProcessId(), parentTime, GetProcessId(child), childTime);
        if (length <= 0) { error = ERROR_BUFFER_OVERFLOW; break; }
        HANDLE output = CreateFileW(request, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (output == INVALID_HANDLE_VALUE) { error = GetLastError(); break; }
        DWORD written = 0;
        published = WriteFile(output, frame, static_cast<DWORD>(length), &written, nullptr) && written == static_cast<DWORD>(length);
        error = published ? 0 : GetLastError();
        if (!CloseHandle(output)) { if (!error) error = GetLastError(); published = FALSE; }
        if (!published) break;
        const ULONGLONG start = GetTickCount64();
        while (GetTickCount64() - start < 5000 && WaitForSingleObject(child, 0) == WAIT_TIMEOUT) {
            const DWORD attributes = GetFileAttributesW(reply);
            if (attributes != INVALID_FILE_ATTRIBUTES && !(attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
                acknowledged = TRUE; break;
            }
            Sleep(10);
        }
        elapsed = GetTickCount64() - start;
    } while (false);
    char line[640];
    const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD={\"schemaVersion\":1,\"parentPid\":%lu,\"childPid\":%lu,\"parentCreationFiletime\":\"%llu\",\"childCreationFiletime\":\"%llu\",\"requestPublished\":%s,\"acknowledged\":%s,\"elapsedMs\":%llu,\"error\":%lu,\"childResumed\":false,\"originalRefusalPreserved\":true}\n",
        GetCurrentProcessId(), GetProcessId(child), parentTime, childTime, published ? "true" : "false",
        acknowledged ? "true" : "false", elapsed, error);
    DWORD written = 0;
    if (length > 0 && NemoClawMsysDiagnosticsEnabled()) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
    SetLastError(saved);
}

BOOL removeInspectionHandle(HANDLE file) {
    FILE_DISPOSITION_INFO disposition = {}; disposition.DeleteFile = TRUE;
    return SetFileInformationByHandle(file, FileDispositionInfo, &disposition, sizeof(disposition));
}

BOOL requestHostQueryRepair(HANDLE child) {
    const DWORD saved = GetLastError();
    WCHAR mode[16] = {};
    const DWORD modeLength = GetEnvironmentVariableW(L"NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD", mode, 16);
    if (!modeLength || modeLength >= 16 || wcscmp(mode, L"repair-query")) { SetLastError(saved); return FALSE; }
    const ULONGLONG started = GetTickCount64();
    BOOL published = FALSE, verified = FALSE, ackRemoved = FALSE, requestRemoved = FALSE, replySeen = FALSE;
    DWORD error = 0;
    WCHAR request[MAX_PATH] = {}, reply[MAX_PATH] = {};
    BY_HANDLE_FILE_INFORMATION requestIdentity = {};
    BOOL requestOwned = FALSE;
    do {
        FILETIME parentCreated = {}, childCreated = {}, exit = {}, kernel = {}, user = {};
        if (!GetProcessTimes(GetCurrentProcess(), &parentCreated, &exit, &kernel, &user) ||
            !GetProcessTimes(child, &childCreated, &exit, &kernel, &user)) { error = GetLastError(); break; }
        const ULONGLONG parentTime = (static_cast<ULONGLONG>(parentCreated.dwHighDateTime) << 32) | parentCreated.dwLowDateTime;
        const ULONGLONG childTime = (static_cast<ULONGLONG>(childCreated.dwHighDateTime) << 32) | childCreated.dwLowDateTime;
        WCHAR root[MAX_PATH] = {}; const DWORD count = GetCurrentDirectoryW(MAX_PATH, root);
        if (!count || count >= MAX_PATH || swprintf_s(request, L"%s\\msys-token-inspection.request", root) < 0 ||
            swprintf_s(reply, L"%s\\msys-token-inspection.ack", root) < 0) { error = ERROR_BUFFER_OVERFLOW; break; }
        char frame[128], success[160], failure[160];
        const int length = _snprintf_s(frame, sizeof(frame), _TRUNCATE, "1 %lu %llu %lu %llu\n", GetCurrentProcessId(), parentTime, GetProcessId(child), childTime);
        if (length <= 0 || _snprintf_s(success, sizeof(success), _TRUNCATE, "%.*s verified\n", length - 1, frame) <= 0 ||
            _snprintf_s(failure, sizeof(failure), _TRUNCATE, "%.*s failed\n", length - 1, frame) <= 0) { error = ERROR_BUFFER_OVERFLOW; break; }
        HANDLE output = INVALID_HANDLE_VALUE;
        // CREATE_NEW is the fixed per-sandbox request lock. All waiting shares
        // this one five-second budget; there is no recursive injection retry.
        while (GetTickCount64() - started < 5000 && WaitForSingleObject(child, 0) == WAIT_TIMEOUT) {
            output = CreateFileW(request, GENERIC_WRITE | DELETE, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
            if (output != INVALID_HANDLE_VALUE) break;
            error = GetLastError();
            if (error != ERROR_FILE_EXISTS && error != ERROR_ALREADY_EXISTS) break;
            Sleep(10);
        }
        if (output == INVALID_HANDLE_VALUE) break;
        const BOOL identityRead = GetFileInformationByHandle(output, &requestIdentity);
        requestOwned = identityRead && requestIdentity.nNumberOfLinks == 1 &&
            !(requestIdentity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT));
        error = requestOwned ? 0 : identityRead ? ERROR_INVALID_DATA : GetLastError();
        DWORD written = 0;
        if (requestOwned) {
            const BOOL wrote = WriteFile(output, frame, static_cast<DWORD>(length), &written, nullptr);
            published = wrote && written == static_cast<DWORD>(length);
            error = published ? 0 : wrote ? ERROR_WRITE_FAULT : GetLastError();
        }
        if (!published) requestRemoved = removeInspectionHandle(output);
        if (!CloseHandle(output)) { error = GetLastError(); published = FALSE; }
        if (!published) break;
        while (GetTickCount64() - started < 5000 && WaitForSingleObject(child, 0) == WAIT_TIMEOUT) {
            HANDLE answer = CreateFileW(reply, GENERIC_READ | DELETE, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
            if (answer == INVALID_HANDLE_VALUE) {
                error = GetLastError();
                if (error != ERROR_FILE_NOT_FOUND && error != ERROR_SHARING_VIOLATION) break;
                Sleep(10); continue;
            }
            replySeen = TRUE;
            BY_HANDLE_FILE_INFORMATION identity = {}; char bytes[160] = {}; DWORD read = 0;
            const BOOL ordinary = GetFileInformationByHandle(answer, &identity) && identity.nNumberOfLinks == 1 &&
                !(identity.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) &&
                !identity.nFileSizeHigh && identity.nFileSizeLow > 0 && identity.nFileSizeLow < sizeof(bytes);
            const BOOL readOk = ordinary && ReadFile(answer, bytes, sizeof(bytes) - 1, &read, nullptr) && read == identity.nFileSizeLow;
            verified = readOk && read == strlen(success) && !memcmp(bytes, success, read);
            const BOOL matching = verified || (readOk && read == strlen(failure) && !memcmp(bytes, failure, read));
            error = matching ? 0 : ERROR_INVALID_DATA;
            if (matching) { ackRemoved = removeInspectionHandle(answer); if (!ackRemoved) error = GetLastError(); }
            if (!CloseHandle(answer)) { error = GetLastError(); ackRemoved = FALSE; }
            break;
        }
    } while (false);
    // Delete only the exact file object this request created. Ack is removed
    // first; the request lock is released last. A replaced file is never deleted.
    if (requestOwned && !requestRemoved && (!replySeen || ackRemoved)) {
        HANDLE owned = INVALID_HANDLE_VALUE;
        // The host holds READ-only sharing while validating this request. Wait
        // for that short read using the original budget, then recheck identity.
        do {
            owned = CreateFileW(request, DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_ATTRIBUTE_NORMAL, nullptr);
            if (owned != INVALID_HANDLE_VALUE) break;
            error = GetLastError();
            if (error != ERROR_SHARING_VIOLATION || GetTickCount64() - started >= 5000) break;
            Sleep(10);
        } while (GetTickCount64() - started < 5000);
        if (owned != INVALID_HANDLE_VALUE) {
            BY_HANDLE_FILE_INFORMATION current = {};
            if (!GetFileInformationByHandle(owned, &current)) error = GetLastError();
            else if (current.dwVolumeSerialNumber != requestIdentity.dwVolumeSerialNumber ||
                current.nFileIndexHigh != requestIdentity.nFileIndexHigh || current.nFileIndexLow != requestIdentity.nFileIndexLow ||
                (current.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) error = ERROR_INVALID_DATA;
            else { requestRemoved = removeInspectionHandle(owned); error = requestRemoved ? 0 : GetLastError(); }
            if (!CloseHandle(owned)) { error = GetLastError(); requestRemoved = FALSE; }
        } else error = GetLastError();
    }
    const BOOL recheck = verified && ackRemoved && requestRemoved;
    char line[640];
    const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_QUERY_REPAIR_WAIT={\"schemaVersion\":1,\"parentPid\":%lu,\"childPid\":%lu,\"requestPublished\":%s,\"matchingVerifiedAck\":%s,\"ackRemoved\":%s,\"requestRemoved\":%s,\"elapsedMs\":%llu,\"error\":%lu,\"actualSidRecheckRequired\":true,\"childResumed\":false}\n",
        GetCurrentProcessId(), GetProcessId(child), published ? "true" : "false", verified ? "true" : "false", ackRemoved ? "true" : "false", requestRemoved ? "true" : "false", GetTickCount64() - started, error);
    DWORD written = 0;
    // Requests follow the real owned session lifetime; diagnostic detail does
    // not. Preserve the existing bound without stopping successful repairs.
    static LONG records = 0;
    if (length > 0 && InterlockedCompareExchange(&records, 32, 32) < 32 && InterlockedIncrement(&records) <= 32)
        if (NemoClawMsysDiagnosticsEnabled()) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
    SetLastError(saved);
    return recheck;
}

// Chrome's locked renderer/utility leaf has no MSYS work or descendant to
// propagate into. Its own Win32k/no-child policies remain fully unchanged.
struct ChromeLeafReadback {
    bool sameFile = false, win32kKnown = false, childPolicyKnown = false, omitted = false;
    DWORD identityError = 0, win32kError = 0, childPolicyError = 0;
    DWORD win32kFlags = 0, childPolicyFlags = 0;
};
LONG chromeLeafRecords = 0;

void logChromeLeaf(HANDLE child, const ChromeLeafReadback& result) {
    const DWORD saved = GetLastError();
    if (InterlockedIncrement(&chromeLeafRecords) <= 8) {
        char line[1024];
        const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
            "NEMOCLAW_MSYS_CHROME_IMPORT={\"schemaVersion\":1,\"parentPid\":%lu,\"childPid\":%lu,\"sameAppContainerAndJobChecked\":true,\"sameHeldImageFile\":%s,\"identityError\":%lu,\"win32kKnown\":%s,\"win32kFlags\":%lu,\"win32kError\":%lu,\"childPolicyKnown\":%s,\"childPolicyFlags\":%lu,\"childPolicyError\":%lu,\"importOmitted\":%s,\"policiesChanged\":false,\"tokenChanged\":false}\n",
            GetCurrentProcessId(), GetProcessId(child), result.sameFile ? "true" : "false",
            result.identityError, result.win32kKnown ? "true" : "false", result.win32kFlags,
            result.win32kError, result.childPolicyKnown ? "true" : "false", result.childPolicyFlags,
            result.childPolicyError, result.omitted ? "true" : "false");
        if (length > 0 && length < static_cast<int>(sizeof(line))) {
            // The broker may discard stderr. Existing debug observation can
            // retain this bounded record without changing process behavior.
            OutputDebugStringA(line);
            if (NemoClawMsysDiagnosticsEnabled()) {
                DWORD written = 0;
                WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
            }
        }
    }
    SetLastError(saved);
}

bool omitLockedChromeImport(HANDLE child, const ProcessImageFile& image, USHORT machine) {
    const DWORD saved = GetLastError();
    WCHAR selected[4096] = {};
    const DWORD count = GetEnvironmentVariableW(L"AGENT_BROWSER_EXECUTABLE_PATH", selected, 4096);
    const WCHAR* selectedLeaf = count && count < 4096 ? wcsrchr(selected, L'\\') : nullptr;
    const WCHAR* childLeaf = wcsrchr(image.path, L'\\');
    if (machine != IMAGE_FILE_MACHINE_AMD64 || !selectedLeaf || !childLeaf ||
        selected[1] != L':' || selected[2] != L'\\' ||
        _wcsicmp(selectedLeaf + 1, L"chrome.exe") || _wcsicmp(childLeaf + 1, L"chrome.exe")) {
        SetLastError(saved);
        return false;
    }
    ChromeLeafReadback result;
    ProcessImageFile expected;
    expected.handle = CreateFileW(selected, GENERIC_READ, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (expected.handle == INVALID_HANDLE_VALUE) result.identityError = GetLastError();
    else if (!GetFileInformationByHandle(expected.handle, &expected.information))
        result.identityError = GetLastError();
    else if (expected.information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
        result.identityError = ERROR_INVALID_DATA;
    else {
        result.sameFile = image.information.dwVolumeSerialNumber == expected.information.dwVolumeSerialNumber &&
            image.information.nFileIndexHigh == expected.information.nFileIndexHigh &&
            image.information.nFileIndexLow == expected.information.nFileIndexLow;
        if (!result.sameFile) result.identityError = ERROR_INVALID_DATA;
    }
    if (result.sameFile) {
        PROCESS_MITIGATION_SYSTEM_CALL_DISABLE_POLICY win32k = {};
        PROCESS_MITIGATION_CHILD_PROCESS_POLICY childPolicy = {};
        static_assert(sizeof(win32k) == sizeof(DWORD) && sizeof(childPolicy) == sizeof(DWORD));
        result.win32kKnown = GetProcessMitigationPolicy(child, ProcessSystemCallDisablePolicy,
            &win32k, sizeof(win32k)) != FALSE;
        result.win32kError = result.win32kKnown ? 0 : GetLastError();
        if (result.win32kKnown) result.win32kFlags = win32k.Flags;
        result.childPolicyKnown = GetProcessMitigationPolicy(child, ProcessChildProcessPolicy,
            &childPolicy, sizeof(childPolicy)) != FALSE;
        result.childPolicyError = result.childPolicyKnown ? 0 : GetLastError();
        if (result.childPolicyKnown) result.childPolicyFlags = childPolicy.Flags;
        // Bit0 enforces Win32k disable / no child creation. Exclude the
        // AllowSecureProcessCreation exception (bit2) from this leaf route.
        result.omitted = result.win32kKnown && result.childPolicyKnown &&
            (result.win32kFlags & 1) && (result.childPolicyFlags & 1) && !(result.childPolicyFlags & 4);
    }
    logChromeLeaf(child, result);
    SetLastError(saved);
    return result.omitted;
}

BOOL inject(HANDLE child) {
    alignas(SID) BYTE actualSid[SECURITY_MAX_SID_SIZE] = {};
    USHORT processMachine = 0, nativeMachine = 0;
    TokenProof proof;
    BOOL sidQueried = initialized && processContainerSid(child, actualSid, &proof);
    BOOL sameSid = sidQueried && EqualSid(containerSid, actualSid);
    BOOL inJob = FALSE;
    BOOL jobKnown = IsProcessInJob(child, nullptr, &inJob);
    const DWORD jobError = jobKnown ? ERROR_SUCCESS : GetLastError();
    logTokenProof(child, proof, sidQueried, sameSid, jobKnown, inJob, jobError);
    DWORD error = ERROR_ACCESS_DENIED;
    if (!sameSid || !jobKnown || !inJob) {
        if (!sidQueried && !strcmp(proof.operation, "OpenProcessToken") && proof.apiError == ERROR_ACCESS_DENIED) {
            logTokenOpenDenial(child);
            holdFailedForkForInspection(child);
            if (requestHostQueryRepair(child)) {
                sidQueried = initialized && processContainerSid(child, actualSid, &proof);
                sameSid = sidQueried && EqualSid(containerSid, actualSid);
                inJob = FALSE;
                jobKnown = IsProcessInJob(child, nullptr, &inJob);
                const DWORD recheckJobError = jobKnown ? ERROR_SUCCESS : GetLastError();
                logTokenProof(child, proof, sidQueried, sameSid, jobKnown, inJob, recheckJobError);
            }
        }
        if (!sameSid || !jobKnown || !inJob) {
            logPropagation(GetProcessId(child), 0, sameSid, inJob, FALSE, error);
            SetLastError(error);
            return FALSE;
        }
    }
    // A suspended x64 process on ARM64 can still report UNKNOWN/native ARM64
    // before loader initialization. Bind selection to its executable image.
    const BOOL queried = IsWow64Process2(child, &processMachine, &nativeMachine);
    const DWORD queryError = queried ? ERROR_SUCCESS : GetLastError();
    ProcessImageFile image;
    USHORT machine = 0;
    if (!readProcessImageMachine(child, image, machine)) {
        error = GetLastError();
        logPropagation(GetProcessId(child), 0, TRUE, TRUE, FALSE, error);
        SetLastError(error); return FALSE;
    }
    char line[512];
    const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_IMAGE_MACHINE={\"schemaVersion\":1,\"childPid\":%lu,\"peMachine\":%u,\"queryProcessMachine\":%u,\"queryNativeMachine\":%u,\"queryError\":%lu,\"source\":\"QueryFullProcessImageNameW/PE\"}\n",
        GetProcessId(child), static_cast<unsigned>(machine), static_cast<unsigned>(processMachine),
        static_cast<unsigned>(nativeMachine), queryError);
    DWORD written = 0;
    if (length > 0 && NemoClawMsysDiagnosticsEnabled()) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
    // The exact already admitted Chrome leaf keeps its own restrictive
    // startup policies. Do not add an unused MSYS/USER32 import to that image.
    if (omitLockedChromeImport(child, image, machine)) {
        SetLastError(ERROR_SUCCESS);
        return TRUE;
    }
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
    if (length > 0 && NemoClawMsysDiagnosticsEnabled()) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
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
    if (!NemoClawCreateProcessW(app,args,processAttributes,threadAttributes,inherit,flags|CREATE_SUSPENDED,environment,directory,startup,&child)) return FALSE;
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
    MsysCreationLayout<STARTUPINFOA, STARTUPINFOEXA> layout;
    if (!layout.ready(startup, flags | CREATE_SUSPENDED)) return FALSE;
    if (!realCreateA(app,args,processAttributes,threadAttributes,inherit,layout.flags,environment,directory,layout.startup,&child)) return FALSE;
    logMsysCreationLayout(child.hProcess, layout.requested, layout.applied, layout.preservedExtended);
    if (!NemoClawCompleteSuspendedChild(&child, flags)) return FALSE;
    *output = child;
    return TRUE;
}

LONG chromeAsUserCalls = 0;
struct ChromeAsUserObservation {
    LONG sequence = 0;
    bool appMatched = false, appNull = false, parentQueried = false, parentMatched = false;
};

bool configuredChromeParentMatches(const WCHAR* selected, ProcessImageFile& parent, ProcessImageFile& expected) {
    USHORT machine = 0;
    if (!readProcessImageMachine(GetCurrentProcess(), parent, machine) || machine != IMAGE_FILE_MACHINE_AMD64)
        return false;
    expected.handle = CreateFileW(selected, GENERIC_READ, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (expected.handle == INVALID_HANDLE_VALUE ||
        !GetFileInformationByHandle(expected.handle, &expected.information) ||
        (expected.information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)))
        return false;
    return parent.information.dwVolumeSerialNumber == expected.information.dwVolumeSerialNumber &&
        parent.information.nFileIndexHigh == expected.information.nFileIndexHigh &&
        parent.information.nFileIndexLow == expected.information.nFileIndexLow;
}

bool configuredChromeParentMatches(const WCHAR* selected) {
    ProcessImageFile parent, expected;
    return configuredChromeParentMatches(selected, parent, expected);
}

// A nested Chrome UI-restricted job cannot be created inside this MXC UI job.
// Keep UI isolation at the existing MXC boundary, while preserving every
// per-target token, mitigation and non-UI job limit. This changes Chrome's
// per-target USER-handle/global-atom isolation scope; it is not equivalent.
LONG chromeInnerUiRecords = 0;

bool exactChromeInnerUiRequest(JOBOBJECTINFOCLASS kind, LPVOID information, DWORD bytes) {
    if (kind != JobObjectBasicUIRestrictions || !information || bytes != sizeof(JOBOBJECT_BASIC_UI_RESTRICTIONS))
        return false;
    __try { return static_cast<const JOBOBJECT_BASIC_UI_RESTRICTIONS*>(information)->UIRestrictionsClass == 0xff; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

bool chromeBrokerCommand() {
    // The canonical broker has no process-type switch. Refuse any occurrence,
    // including quoted/mixed-case child forms, rather than parse new arguments.
    __try {
        const WCHAR* command = GetCommandLineW();
        if (!command) return false;
        size_t length = 0;
        while (length < 32768 && command[length]) ++length;
        if (!length || length == 32768) return false;
        for (size_t i = 0; i < length; ++i)
            if (!_wcsnicmp(command + i, L"--type", 6) || !_wcsnicmp(command + i, L"/type", 5)) return false;
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

struct ChromeInnerUiProof {
    const char* stage = "parent-identity";
    DWORD checkError = 0, requested = 0xff, before = 0, after = 0;
    DWORD outerBefore = 0, outerAfter = 0, outerExtended = 0;
    bool admitted = false, applied = false, verified = false;
    bool innerReadback = false, outerReadback = false, limitsUnchanged = false, stillUnused = false;
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
};

bool admitChromeInnerUi(HANDLE job, ChromeInnerUiProof& proof) {
    alignas(SID) BYTE actualSid[SECURITY_MAX_SID_SIZE] = {};
    BOOL currentInJob = FALSE, currentInTarget = FALSE;
    if (!initialized) { SetLastError(ERROR_INVALID_STATE); return false; }
    if (!processContainerSid(GetCurrentProcess(), actualSid)) return false;
    if (!EqualSid(actualSid, containerSid)) { SetLastError(ERROR_ACCESS_DENIED); return false; }
    proof.stage = "current-MXC-job";
    JOBOBJECT_BASIC_UI_RESTRICTIONS outer = {};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION outerLimits = {};
    if (!IsProcessInJob(GetCurrentProcess(), nullptr, &currentInJob) || !currentInJob ||
        !QueryInformationJobObject(nullptr, JobObjectBasicUIRestrictions, &outer, sizeof(outer), nullptr) ||
        !QueryInformationJobObject(nullptr, JobObjectExtendedLimitInformation, &outerLimits, sizeof(outerLimits), nullptr)) return false;
    proof.outerBefore = outer.UIRestrictionsClass;
    proof.outerExtended = outerLimits.BasicLimitInformation.LimitFlags;
    if (proof.outerBefore != 0x3bf || proof.outerExtended != JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) { SetLastError(ERROR_ACCESS_DENIED); return false; }
    proof.stage = "unused-separate-inner-job";
    JOBOBJECT_BASIC_UI_RESTRICTIONS inner = {};
    if (!job || job == INVALID_HANDLE_VALUE ||
        !IsProcessInJob(GetCurrentProcess(), job, &currentInTarget) || currentInTarget ||
        !QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &proof.accounting, sizeof(proof.accounting), nullptr) ||
        !QueryInformationJobObject(job, JobObjectBasicUIRestrictions, &inner, sizeof(inner), nullptr) ||
        !QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &proof.limits, sizeof(proof.limits), nullptr)) return false;
    proof.before = inner.UIRestrictionsClass;
    // TotalProcesses counts every lifetime association, including failed
    // assignments. Chrome calls this while its newly created job is private.
    const bool unused = proof.before == 0 && proof.accounting.TotalProcesses == 0 &&
        proof.accounting.ActiveProcesses == 0 && proof.accounting.TotalTerminatedProcesses == 0;
    if (!unused) SetLastError(ERROR_ACCESS_DENIED);
    return unused;
}

void logChromeInnerUi(HANDLE job, const ChromeInnerUiProof& proof, BOOL apiResult, DWORD apiError) {
    const DWORD saved = GetLastError();
    if (InterlockedIncrement(&chromeInnerUiRecords) <= 8) {
        char line[1280];
        const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
            "NEMOCLAW_MSYS_CHROME_INNER_UI={\"schemaVersion\":1,\"pid\":%lu,\"threadId\":%lu,\"job\":\"0x%llx\",\"stage\":\"%s\",\"admitted\":%s,\"requestedInnerMask\":%lu,\"beforeInnerMask\":%lu,\"effectiveInnerMask\":%lu,\"outerBeforeMask\":%lu,\"outerAfterMask\":%lu,\"outerExtendedFlags\":%lu,\"totalProcessesBefore\":%lu,\"activeProcessesBefore\":%lu,\"terminatedProcessesBefore\":%lu,\"applied\":%s,\"apiResult\":%s,\"apiError\":%lu,\"lastError\":%lu,\"checkError\":%lu,\"innerReadback\":%s,\"outerReadback\":%s,\"otherJobLimitsUnchanged\":%s,\"stillUnused\":%s,\"verified\":%s,\"uiIsolationScope\":\"MXC-outer-boundary\",\"chromePerTargetUiScopeEquivalent\":false}\n",
            GetCurrentProcessId(), GetCurrentThreadId(), static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(job)), proof.stage,
            proof.admitted ? "true" : "false", proof.requested, proof.before, proof.after,
            proof.outerBefore, proof.outerAfter, proof.outerExtended, proof.accounting.TotalProcesses,
            proof.accounting.ActiveProcesses, proof.accounting.TotalTerminatedProcesses, proof.applied ? "true" : "false",
            apiResult ? "true" : "false", apiResult ? 0 : apiError, apiError, proof.checkError, proof.innerReadback ? "true" : "false",
            proof.outerReadback ? "true" : "false", proof.limitsUnchanged ? "true" : "false",
            proof.stillUnused ? "true" : "false", proof.verified ? "true" : "false");
        if (length > 0 && length < static_cast<int>(sizeof(line))) {
            OutputDebugStringA(line);
            DWORD written = 0;
            // Best-effort stderr may be NUL even in Personal capture; the
            // debugger can retain OutputDebugString. No command/token is logged.
            WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
        }
    }
    SetLastError(saved);
}

void chromeInnerUiCheckFailure(ChromeInnerUiProof& proof, const char* stage, DWORD error) {
    if (!proof.checkError) { proof.stage = stage; proof.checkError = error ? error : ERROR_INVALID_DATA; }
}

BOOL WINAPI hookedSetJobInformation(HANDLE job, JOBOBJECTINFOCLASS kind, LPVOID information, DWORD bytes) {
    const DWORD saved = GetLastError();
    if (!initialized || !exactChromeInnerUiRequest(kind, information, bytes)) {
        SetLastError(saved); return realSetJobInformation(job, kind, information, bytes);
    }
    WCHAR selected[4096] = {};
    const DWORD count = GetEnvironmentVariableW(L"AGENT_BROWSER_EXECUTABLE_PATH", selected, 4096);
    const WCHAR* leaf = count && count < 4096 ? wcsrchr(selected, L'\\') : nullptr;
    ProcessImageFile parent, expected; // Both identities stay held through readback.
    if (!leaf || selected[1] != L':' || selected[2] != L'\\' || _wcsicmp(leaf + 1, L"chrome.exe") ||
        !chromeBrokerCommand() || !configuredChromeParentMatches(selected, parent, expected)) {
        SetLastError(saved); return realSetJobInformation(job, kind, information, bytes);
    }
    ChromeInnerUiProof proof;
    proof.admitted = admitChromeInnerUi(job, proof);
    if (!proof.admitted) {
        proof.checkError = GetLastError();
        SetLastError(saved);
        const BOOL result = realSetJobInformation(job, kind, information, bytes);
        const DWORD error = GetLastError();
        logChromeInnerUi(job, proof, result, error);
        SetLastError(error); return result;
    }
    // Do not mutate the caller's buffer or make any other SetInformation call.
    JOBOBJECT_BASIC_UI_RESTRICTIONS effective = {};
    SetLastError(saved);
    const BOOL result = realSetJobInformation(job, kind, &effective, sizeof(effective));
    const DWORD error = GetLastError();
    proof.applied = result != FALSE; proof.stage = "SetInformationJobObject";
    if (result) {
        JOBOBJECT_BASIC_UI_RESTRICTIONS inner = {}, outer = {};
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {}, outerLimits = {};
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {};
        BOOL currentInTarget = TRUE;
        proof.stage = "readback";
        proof.innerReadback = QueryInformationJobObject(job, JobObjectBasicUIRestrictions, &inner, sizeof(inner), nullptr) != FALSE;
        proof.after = inner.UIRestrictionsClass;
        if (!proof.innerReadback) chromeInnerUiCheckFailure(proof, "inner-ui-readback", GetLastError());
        else if (proof.after != 0) chromeInnerUiCheckFailure(proof, "inner-ui-mismatch", ERROR_INVALID_DATA);
        proof.outerReadback = QueryInformationJobObject(nullptr, JobObjectBasicUIRestrictions, &outer, sizeof(outer), nullptr) != FALSE;
        proof.outerAfter = outer.UIRestrictionsClass;
        if (!proof.outerReadback) chromeInnerUiCheckFailure(proof, "outer-ui-readback", GetLastError());
        else if (proof.outerAfter != proof.outerBefore) chromeInnerUiCheckFailure(proof, "outer-ui-mismatch", ERROR_INVALID_DATA);
        proof.limitsUnchanged = QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr) &&
            !memcmp(&limits, &proof.limits, sizeof(limits));
        if (!proof.limitsUnchanged) chromeInnerUiCheckFailure(proof, "inner-extended-readback", GetLastError());
        proof.stillUnused = QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) &&
            !accounting.TotalProcesses && !accounting.ActiveProcesses && !accounting.TotalTerminatedProcesses &&
            IsProcessInJob(GetCurrentProcess(), job, &currentInTarget) && !currentInTarget;
        if (!proof.stillUnused) chromeInnerUiCheckFailure(proof, "unused-job-readback", GetLastError());
        proof.verified = proof.innerReadback && proof.after == 0 && proof.outerReadback && proof.outerAfter == proof.outerBefore &&
            proof.limitsUnchanged && proof.stillUnused &&
            QueryInformationJobObject(nullptr, JobObjectExtendedLimitInformation, &outerLimits, sizeof(outerLimits), nullptr) &&
            outerLimits.BasicLimitInformation.LimitFlags == proof.outerExtended;
        if (!proof.verified) chromeInnerUiCheckFailure(proof, "outer-extended-readback", GetLastError());
    }
    logChromeInnerUi(job, proof, result, error);
    SetLastError(result && !proof.verified ? ERROR_INVALID_DATA : error);
    return result && !proof.verified ? FALSE : result;
}

ChromeAsUserObservation chromeAsUserCall(LPCWSTR app) {
    const DWORD saved = GetLastError();
    ChromeAsUserObservation value;
    value.appNull = app == nullptr;
    if (InterlockedCompareExchange(&chromeAsUserCalls, 0, 0) >= 4) return value;
    WCHAR selected[4096] = {};
    bool configured = false;
    __try {
        const DWORD count = GetEnvironmentVariableW(L"AGENT_BROWSER_EXECUTABLE_PATH", selected, 4096);
        size_t length = 0;
        if (app) while (length < 4096 && app[length]) ++length;
        const WCHAR* leaf = count && count < 4096 ? wcsrchr(selected, L'\\') : nullptr;
        configured = initialized && leaf && selected[1] == L':' && selected[2] == L'\\' &&
            !_wcsicmp(leaf + 1, L"chrome.exe");
        value.appMatched = configured && app && length && length < 4096 && !_wcsicmp(app, selected);
    } __except (EXCEPTION_EXECUTE_HANDLER) { configured = false; }
    if (configured && !value.appMatched) {
        value.parentQueried = true;
        value.parentMatched = configuredChromeParentMatches(selected);
    }
    if (value.appMatched || value.parentMatched) {
        const LONG sequence = InterlockedIncrement(&chromeAsUserCalls);
        if (sequence > 0 && sequence <= 4) value.sequence = sequence;
    }
    SetLastError(saved);
    return value;
}

void logChromeAsUser(const ChromeAsUserObservation& call, bool returned, DWORD callerFlags, DWORD actualFlags,
    BOOL inherit, bool nested, BOOL result, DWORD error, LPPROCESS_INFORMATION output) {
    if (!call.sequence) return;
    const DWORD saved = GetLastError();
    DWORD pid = 0;
    __try { if (returned && output) pid = output->dwProcessId; }
    __except (EXCEPTION_EXECUTE_HANDLER) { pid = 0; }
    char line[1024];
    const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_CHROME_ASUSER={\"schemaVersion\":1,\"callId\":%lu,\"parentPid\":%lu,\"threadId\":%lu,\"tickMs\":%llu,\"api\":\"CreateProcessAsUserW\",\"stage\":\"%s\",\"callerFlags\":%lu,\"actualFlags\":%lu,\"inheritValue\":%d,\"withinCreateOnEntry\":%s,\"appMatched\":%s,\"appNull\":%s,\"parentIdentityQueried\":%s,\"parentMatched\":%s,\"apiReturned\":%s,\"result\":%s,\"lastError\":%lu,\"lastErrorIsFailure\":%s,\"returnedPid\":%lu,\"boundTrampoline\":\"0x%llx\",\"diagnosticOnly\":true}\n",
        static_cast<DWORD>(call.sequence), GetCurrentProcessId(), GetCurrentThreadId(), GetTickCount64(),
        returned ? "return" : "entry", callerFlags, actualFlags, inherit, nested ? "true" : "false",
        call.appMatched ? "true" : "false", call.appNull ? "true" : "false",
        call.parentQueried ? "true" : "false", call.parentMatched ? "true" : "false",
        returned ? "true" : "false", returned ? (result ? "true" : "false") : "null", error,
        returned && !result ? "true" : "false", pid,
        static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(realCreateAsUserW)));
    if (length > 0 && length < static_cast<int>(sizeof(line))) {
        OutputDebugStringA(line);
        if (NemoClawMsysDiagnosticsEnabled()) {
            DWORD written = 0;
            WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
        }
    }
    SetLastError(saved);
}

BOOL WINAPI hookedAsUserW(HANDLE token, LPCWSTR app, LPWSTR args, LPSECURITY_ATTRIBUTES processAttributes,
    LPSECURITY_ATTRIBUTES threadAttributes, BOOL inherit, DWORD flags, LPVOID environment,
    LPCWSTR directory, LPSTARTUPINFOW startup, LPPROCESS_INFORMATION output) {
    if (withinCreate) {
        const ChromeAsUserObservation call = chromeAsUserCall(app);
        logChromeAsUser(call, false, flags, flags, inherit, true, FALSE, 0, nullptr);
        const BOOL created = realCreateAsUserW(token,app,args,processAttributes,threadAttributes,inherit,flags,environment,directory,startup,output);
        const DWORD error = GetLastError();
        logChromeAsUser(call, true, flags, flags, inherit, true, created, error, output);
        SetLastError(error);
        return created;
    }
    if (!allowed(output, flags)) return FALSE;
    CreationScope scope;
    PROCESS_INFORMATION child = {};
    MsysCreationLayout<STARTUPINFOW, STARTUPINFOEXW> layout;
    if (!layout.ready(startup, flags | CREATE_SUSPENDED)) return FALSE;
    const ChromeAsUserObservation call = chromeAsUserCall(app);
    logChromeAsUser(call, false, flags, layout.flags, inherit, false, FALSE, 0, nullptr);
    const BOOL created = realCreateAsUserW(token,app,args,processAttributes,threadAttributes,inherit,layout.flags,environment,directory,layout.startup,&child);
    const DWORD error = GetLastError();
    logChromeAsUser(call, true, flags, layout.flags, inherit, false, created, error, &child);
    SetLastError(error);
    if (!created) return FALSE;
    logMsysCreationLayout(child.hProcess, layout.requested, layout.applied, layout.preservedExtended);
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
    MsysCreationLayout<STARTUPINFOA, STARTUPINFOEXA> layout;
    if (!layout.ready(startup, flags | CREATE_SUSPENDED)) return FALSE;
    if (!realCreateAsUserA(token,app,args,processAttributes,threadAttributes,inherit,layout.flags,environment,directory,layout.startup,&child)) return FALSE;
    logMsysCreationLayout(child.hProcess, layout.requested, layout.applied, layout.preservedExtended);
    if (!NemoClawCompleteSuspendedChild(&child, flags)) return FALSE;
    *output = child;
    return TRUE;
}
}

extern "C" BOOL NemoClawCreateProcessW(LPCWSTR app, LPWSTR args, LPSECURITY_ATTRIBUTES processAttributes,
    LPSECURITY_ATTRIBUTES threadAttributes, BOOL inherit, DWORD flags, LPVOID environment,
    LPCWSTR directory, LPSTARTUPINFOW startup, LPPROCESS_INFORMATION output) {
    MsysCreationLayout<STARTUPINFOW, STARTUPINFOEXW> layout;
    if (!layout.ready(startup, flags)) return FALSE;
    const BOOL created = realCreateW(app,args,processAttributes,threadAttributes,inherit,layout.flags,environment,directory,layout.startup,output);
    if (created) logMsysCreationLayout(output->hProcess, layout.requested, layout.applied, layout.preservedExtended);
    return created;
}
extern "C" void NemoClawLogCurrentImageLayout() {
    logMsysCreationLayout(nullptr, preferredMsysLayout(), false, false);
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
    if (!error) error = DetourAttach(reinterpret_cast<PVOID*>(&realSetJobInformation), reinterpret_cast<PVOID>(hookedSetJobInformation));
    return error;
}

extern "C" void NemoClawLogLaunch(DWORD childPid, DWORD exitCode, BOOL exited, DWORD error) {
    char line[512];
    int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_LAUNCH={\"schemaVersion\":1,\"parentPid\":%lu,\"childPid\":%lu,\"childExited\":%s,\"exitCode\":%lu,\"error\":%lu}\n",
        GetCurrentProcessId(), childPid, exited ? "true" : "false", exitCode, error);
    DWORD written = 0;
    if (length > 0 && (error || !exited || exitCode || NemoClawMsysDiagnosticsEnabled())) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
}
