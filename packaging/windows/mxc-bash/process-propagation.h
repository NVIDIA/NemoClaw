// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <windows.h>

// The context is derived from this process's token and this module's location.
// No caller-supplied SID, namespace, or arbitrary DLL path is accepted.
extern "C" BOOL NemoClawInitializeProcessContext(HMODULE self);
// Caller owns one transaction for process and namespace hooks together.
extern "C" LONG NemoClawStageProcessPropagation();
extern "C" BOOL NemoClawCompleteSuspendedChild(PROCESS_INFORMATION* child, DWORD callerFlags);
extern "C" void NemoClawLogLaunch(DWORD childPid, DWORD exitCode, BOOL exited, DWORD error);

// Scoped prototype creation option; all original startup fields are retained.
extern "C" BOOL NemoClawCreateProcessW(LPCWSTR app, LPWSTR args, LPSECURITY_ATTRIBUTES processAttributes,
    LPSECURITY_ATTRIBUTES threadAttributes, BOOL inherit, DWORD flags, LPVOID environment,
    LPCWSTR directory, LPSTARTUPINFOW startup, LPPROCESS_INFORMATION output);
extern "C" void NemoClawLogCurrentImageLayout();
