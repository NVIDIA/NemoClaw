// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "process-propagation.h"
#include <string>
#include <vector>
#include <wchar.h>

static std::wstring quote(const wchar_t* value) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (const wchar_t* p = value; *p; ++p) {
        if (*p == L'\\') { ++slashes; continue; }
        result.append(slashes * (*p == L'\"' ? 2 : 1), L'\\');
        slashes = 0;
        if (*p == L'\"') result += L'\\';
        result += *p;
    }
    result.append(slashes * 2, L'\\');
    result += L'\"';
    return result;
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 3 || wcscmp(argv[1], L"--") || wcslen(argv[2]) < 4 || argv[2][1] != L':' || argv[2][2] != L'\\')
        return ERROR_INVALID_PARAMETER;
    if (!NemoClawInitializeProcessContext(nullptr)) {
        DWORD error = GetLastError();
        NemoClawLogLaunch(0, error, FALSE, error);
        return static_cast<int>(error);
    }
    std::wstring command;
    for (int index = 2; index < argc; ++index) {
        if (!command.empty()) command += L' ';
        command += quote(argv[index]);
    }
    if (command.size() >= 32767) return ERROR_BUFFER_OVERFLOW;
    std::vector<wchar_t> writable(command.begin(), command.end());
    writable.push_back(0);
    STARTUPINFOW startup = {};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION child = {};
    if (!NemoClawCreateProcessW(argv[2], writable.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                        nullptr, nullptr, &startup, &child)) {
        DWORD error = GetLastError();
        NemoClawLogLaunch(0, error, FALSE, error);
        return static_cast<int>(error);
    }
    DWORD childPid = child.dwProcessId;
    if (!NemoClawCompleteSuspendedChild(&child, 0)) {
        DWORD error = GetLastError();
        NemoClawLogLaunch(childPid, error, FALSE, error);
        return static_cast<int>(error);
    }
    DWORD wait = WaitForSingleObject(child.hProcess, INFINITE);
    DWORD code = ERROR_PROCESS_ABORTED;
    DWORD error = 0;
    BOOL exited = wait == WAIT_OBJECT_0 && GetExitCodeProcess(child.hProcess, &code);
    if (!exited) { error = GetLastError(); TerminateProcess(child.hProcess, ERROR_PROCESS_ABORTED); WaitForSingleObject(child.hProcess, 5000); }
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
    NemoClawLogLaunch(childPid, code, exited, error);
    return static_cast<int>(exited ? code : ERROR_PROCESS_ABORTED);
}
