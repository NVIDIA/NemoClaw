// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const HERMETIC_GIT_ARGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "diff.external=",
] as const;

export function gitIsolationEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
  };
}

export function safeEnvironmentValue(value: string): boolean {
  return ![0, 10, 13].some((code) => value.includes(String.fromCharCode(code)));
}
