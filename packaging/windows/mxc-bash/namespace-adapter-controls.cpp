// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Unit controls only: never call DllMain, install detours or enter a sandbox.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
BOOL WINAPI duplicate_adapter_control(HANDLE, HANDLE, HANDLE, LPHANDLE, DWORD, BOOL, DWORD);
#define DuplicateHandle duplicate_adapter_control
#include "namespace-compat.cpp"
#undef DuplicateHandle
#include <initializer_list>
#include <stdlib.h>

bool failDuplicateForControl = false;
BOOL WINAPI duplicate_adapter_control(HANDLE sourceProcess, HANDLE source, HANDLE targetProcess,
                                     LPHANDLE output, DWORD access, BOOL inherit, DWORD options) {
    if (failDuplicateForControl) {
        *output = source; // An arbitrary failed output must not be closed.
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    return DuplicateHandle(sourceProcess, source, targetProcess, output, access, inherit, options);
}

namespace {
unsigned controlsPassed = 0;
void check_adapter(bool condition, const char* label) {
    if (!condition) { fprintf(stderr, "FAIL %s\n", label); exit(1); }
    ++controlsPassed;
}
WCHAR callerMutexName[64] = {};
OBJECT_ATTRIBUTES callerMutexAttributes = {};
const WCHAR* expectedMutexName = nullptr;
bool expectAdaptation = false;
bool adapterCalled = false;
BOOL WINAPI compare_fixture_handles(HANDLE first, HANDLE second) {
    return first == reinterpret_cast<HANDLE>(2) && second == reinterpret_cast<HANDLE>(1);
}
NTSTATUS NTAPI inspect_mutex_call(PHANDLE, ACCESS_MASK access, POBJECT_ATTRIBUTES attributes, BOOLEAN owner) {
    adapterCalled = true;
    if (expectAdaptation) {
        // Change the caller's storage after admission, before the fake API
        // consumes it. The adapted call must use its own validated snapshot.
        wcscpy_s(callerMutexName, L"foreign-mutex");
        callerMutexAttributes.RootDirectory = reinterpret_cast<HANDLE>(3);
        check_adapter(attributes != &callerMutexAttributes && attributes->ObjectName->Buffer != callerMutexName,
                      "mutex-does-not-reuse-caller-storage");
        check_adapter(attributes->RootDirectory == heldSharedDirectory &&
                      wcscmp(attributes->ObjectName->Buffer, expectedMutexName) == 0,
                      "mutex-target-remains-admitted");
        check_adapter(attributes->SecurityDescriptor == &sharedMutexDescriptor.descriptor &&
                      attributes->Attributes == (OBJ_OPENIF | OBJ_CASE_INSENSITIVE) &&
                      access == shared_mutex_user_access && !owner,
                      "mutex-security-and-native-flags-preserved");
    } else check_adapter(attributes == &callerMutexAttributes, "unmatched-mutex-passes-through");
    return static_cast<NTSTATUS>(0xc00000bbu);
}
}

int main() {
    for (DWORD mask : {0xbfu, 0x1bfu, 0x3bfu}) {
        HANDLE marker = nullptr;
        check_adapter(browser_ui_policy_admitted(mask, marker) && marker == nullptr,
                      "legacy-browser-policy-unchanged-without-marker");
    }
    for (DWORD mask : {0u, 1u, 0x3ffu}) {
        HANDLE marker = nullptr;
        check_adapter(!browser_ui_policy_admitted(mask, marker) && marker == nullptr,
                      "uncontained-or-unknown-browser-policy-refused");
    }
    HANDLE borrowed = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    check_adapter(borrowed != nullptr, "create-owned-control-event");
    for (const auto code : {0xc0000022u, 0xc0000034u, 0x80000005u}) {
        check_adapter(!finish_private_root_open(static_cast<NTSTATUS>(code), borrowed), "root-failure-preserved");
        DWORD flags = 0;
        check_adapter(GetHandleInformation(borrowed, &flags) != FALSE, "failed-root-output-not-closed");
    }
    for (const auto code : {0u, 0x40000000u}) {
        HANDLE owned = nullptr;
        check_adapter(DuplicateHandle(GetCurrentProcess(), borrowed, GetCurrentProcess(), &owned,
                                     0, FALSE, DUPLICATE_SAME_ACCESS) != FALSE, "duplicate-owned-control-event");
        check_adapter(finish_private_root_open(static_cast<NTSTATUS>(code), owned), "successful-root-closed");
        DWORD flags = 0;
        check_adapter(!GetHandleInformation(owned, &flags) && GetLastError() == ERROR_INVALID_HANDLE,
                      "successful-root-not-leaked");
    }
    check_adapter(!finish_private_root_open(0, nullptr), "null-root-success-refused");
    check_adapter(!finish_private_root_open(0, INVALID_HANDLE_VALUE), "invalid-root-success-refused");
    sameKernelObject = compare_fixture_handles;
    queryKernelObject = reinterpret_cast<QueryObject>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryObject"));
    check_adapter(queryKernelObject != nullptr, "query-api-present-for-duplicate-control");
    failDuplicateForControl = true;
    retain_npfs_root(borrowed);
    failDuplicateForControl = false;
    DWORD flags = 0;
    check_adapter(GetHandleInformation(borrowed, &flags) != FALSE, "failed-npfs-duplicate-output-not-closed");
    check_adapter(npfsBindingState == 0 && heldNpfsRoot == nullptr && npfsBindingError == ERROR_ACCESS_DENIED,
                  "failed-npfs-duplicate-not-admitted");
    check_adapter(CloseHandle(borrowed) != FALSE, "owned-control-event-closed");

    sameKernelObject = compare_fixture_handles;
    realCreateSharedMutex = inspect_mutex_call;
    heldSharedDirectory = reinterpret_cast<HANDLE>(1);
    sharedDirectoryState = 2;
    SECURITY_DESCRIPTOR descriptor = {};
    check_adapter(InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
                  SetSecurityDescriptorDacl(&descriptor, TRUE, nullptr, FALSE), "canonical-null-dacl-fixture");
    for (const auto name : {L"tty_list::mutex.0", L"cyg.loadavg.mutex", L"not-canonical"}) {
        wcscpy_s(callerMutexName, name);
        UNICODE_STRING objectName = {34, sizeof(callerMutexName), callerMutexName};
        callerMutexAttributes = {};
        callerMutexAttributes.Length = sizeof(callerMutexAttributes);
        callerMutexAttributes.RootDirectory = reinterpret_cast<HANDLE>(2);
        callerMutexAttributes.ObjectName = &objectName;
        callerMutexAttributes.Attributes = OBJ_OPENIF | OBJ_CASE_INSENSITIVE;
        callerMutexAttributes.SecurityDescriptor = &descriptor;
        expectedMutexName = name;
        expectAdaptation = wcscmp(name, L"not-canonical") != 0;
        adapterCalled = false;
        HANDLE result = nullptr;
        const auto status = create_shared_mutex(&result, shared_mutex_user_access, &callerMutexAttributes, FALSE);
        check_adapter(adapterCalled && status == static_cast<NTSTATUS>(0xc00000bbu), "mutex-native-failure-preserved");
    }
    heldSharedDirectory = nullptr;
    printf("NEMOCLAW_MSYS_ADAPTER_CONTROLS=%u\n", controlsPassed);
    return controlsPassed == 36 ? 0 : 1;
}
