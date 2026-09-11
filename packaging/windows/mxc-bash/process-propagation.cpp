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
MsysMappedLayout currentMsysLayout() {
    MsysMappedLayout value;
    HMODULE module = GetModuleHandleW(L"msys-2.0.dll");
    if (!module) return value;
    value.base = reinterpret_cast<DWORD64>(module);
    __try {
        const BYTE* base = reinterpret_cast<const BYTE*>(module);
        const auto dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
        if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 64 || dos->e_lfanew > 1024) return value;
        const auto pe = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
        if (pe->Signature != IMAGE_NT_SIGNATURE || pe->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
            pe->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) return value;
        value.preferred = pe->OptionalHeader.ImageBase;
        value.size = pe->OptionalHeader.SizeOfImage;
        value.characteristics = pe->OptionalHeader.DllCharacteristics;
        value.exactShape = value.preferred == 0x210040000ULL && value.size == 0x360000 &&
            pe->FileHeader.TimeDateStamp == 0x69c910a9;
        if (value.exactShape) value.caps = *reinterpret_cast<const DWORD64*>(base + 0x34d198);
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
    return value;
}
void logMsysCreationLayout(HANDLE child, bool requested, bool applied, bool preservedExtended) {
    if (!preferredMsysLayout()) return;
    const DWORD saved = GetLastError();
    PROCESS_MITIGATION_ASLR_POLICY parentPolicy = {}, childPolicy = {};
    const BOOL parentKnown = GetProcessMitigationPolicy(GetCurrentProcess(), ProcessASLRPolicy, &parentPolicy, sizeof(parentPolicy));
    const DWORD parentError = parentKnown ? 0 : GetLastError();
    const BOOL childKnown = child && GetProcessMitigationPolicy(child, ProcessASLRPolicy, &childPolicy, sizeof(childPolicy));
    const DWORD childError = child && !childKnown ? GetLastError() : 0;
    const MsysMappedLayout module = currentMsysLayout();
    char line[1024];
    const int count = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_IMAGE_LAYOUT={\"schemaVersion\":1,\"pid\":%lu,\"childPid\":%lu,\"requested\":%s,\"applied\":%s,\"existingExtendedAttributesPreserved\":%s,\"creationPolicy\":\"0x0000000000000200\",\"parentAslrKnown\":%s,\"parentAslrFlags\":%lu,\"parentAslrError\":%lu,\"childAslrKnown\":%s,\"childAslrFlags\":%lu,\"childAslrError\":%lu,\"msysBase\":\"0x%llx\",\"msysPreferredBase\":\"0x%llx\",\"msysImageSize\":%lu,\"msysDllCharacteristics\":%u,\"exactMsysShape\":%s,\"capsPointer\":\"0x%llx\"}\n",
        GetCurrentProcessId(), child ? GetProcessId(child) : 0, requested ? "true" : "false", applied ? "true" : "false", preservedExtended ? "true" : "false",
        parentKnown ? "true" : "false", parentPolicy.Flags, parentError, childKnown ? "true" : "false", childPolicy.Flags, childError,
        module.base, module.preferred, module.size, static_cast<unsigned>(module.characteristics), module.exactShape ? "true" : "false", module.caps);
    DWORD written = 0;
    if (count > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(count), &written, nullptr);
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
    ~ProcessImageFile() {
        const DWORD error = GetLastError();
        if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
        SetLastError(error);
    }
};

BOOL readProcessImageMachine(HANDLE process, ProcessImageFile& image, USHORT& machine) {
    WCHAR fileName[4096] = {};
    DWORD count = static_cast<DWORD>(sizeof(fileName) / sizeof(fileName[0]));
    if (!QueryFullProcessImageNameW(process, 0, fileName, &count)) return FALSE;
    image.handle = CreateFileW(fileName, GENERIC_READ, FILE_SHARE_READ, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (image.handle == INVALID_HANDLE_VALUE) return FALSE;
    BY_HANDLE_FILE_INFORMATION info = {};
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
        if (length > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
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
    if (length > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
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
    if (length > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
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
    if (length > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
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
    static LONG attempts = 0;
    if (InterlockedIncrement(&attempts) > 32) { SetLastError(saved); return FALSE; }
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
        HANDLE owned = CreateFileW(request, DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_ATTRIBUTE_NORMAL, nullptr);
        if (owned != INVALID_HANDLE_VALUE) {
            BY_HANDLE_FILE_INFORMATION current = {};
            if (!GetFileInformationByHandle(owned, &current)) error = GetLastError();
            else if (current.dwVolumeSerialNumber != requestIdentity.dwVolumeSerialNumber ||
                current.nFileIndexHigh != requestIdentity.nFileIndexHigh || current.nFileIndexLow != requestIdentity.nFileIndexLow ||
                (current.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) error = ERROR_INVALID_DATA;
            else { requestRemoved = removeInspectionHandle(owned); if (!requestRemoved) error = GetLastError(); }
            if (!CloseHandle(owned)) { error = GetLastError(); requestRemoved = FALSE; }
        } else error = GetLastError();
    }
    const BOOL recheck = verified && ackRemoved && requestRemoved;
    char line[640];
    const int length = _snprintf_s(line, sizeof(line), _TRUNCATE,
        "NEMOCLAW_MSYS_QUERY_REPAIR_WAIT={\"schemaVersion\":1,\"parentPid\":%lu,\"childPid\":%lu,\"requestPublished\":%s,\"matchingVerifiedAck\":%s,\"ackRemoved\":%s,\"requestRemoved\":%s,\"elapsedMs\":%llu,\"error\":%lu,\"actualSidRecheckRequired\":true,\"childResumed\":false}\n",
        GetCurrentProcessId(), GetProcessId(child), published ? "true" : "false", verified ? "true" : "false", ackRemoved ? "true" : "false", requestRemoved ? "true" : "false", GetTickCount64() - started, error);
    DWORD written = 0;
    if (length > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
    SetLastError(saved);
    return recheck;
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
    if (length > 0) WriteFile(GetStdHandle(STD_ERROR_HANDLE), line, static_cast<DWORD>(length), &written, nullptr);
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

BOOL WINAPI hookedAsUserW(HANDLE token, LPCWSTR app, LPWSTR args, LPSECURITY_ATTRIBUTES processAttributes,
    LPSECURITY_ATTRIBUTES threadAttributes, BOOL inherit, DWORD flags, LPVOID environment,
    LPCWSTR directory, LPSTARTUPINFOW startup, LPPROCESS_INFORMATION output) {
    if (withinCreate) return realCreateAsUserW(token,app,args,processAttributes,threadAttributes,inherit,flags,environment,directory,startup,output);
    if (!allowed(output, flags)) return FALSE;
    CreationScope scope;
    PROCESS_INFORMATION child = {};
    MsysCreationLayout<STARTUPINFOW, STARTUPINFOEXW> layout;
    if (!layout.ready(startup, flags | CREATE_SUSPENDED)) return FALSE;
    if (!realCreateAsUserW(token,app,args,processAttributes,threadAttributes,inherit,layout.flags,environment,directory,layout.startup,&child)) return FALSE;
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
