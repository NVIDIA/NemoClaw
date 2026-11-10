// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI creation-only target: the matrix never resumes this image.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

extern "C" __declspec(noreturn) void WINAPI SentinelEntry() {
  ExitProcess(0);
}
