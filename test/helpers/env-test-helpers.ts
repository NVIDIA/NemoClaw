// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Centralise the branch on `original === undefined` so per-test env
// restoration does not add if-statements to each changed test file's
// growth guard, and so the same restore contract is shared across suites.
export function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

export function restoreEnvBulk(entries: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(entries)) {
    restoreEnv(name, value);
  }
}
