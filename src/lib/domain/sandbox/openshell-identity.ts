// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

const SANDBOX_ID_RE = /^[A-Za-z0-9._-]+$/u;
const SANDBOX_ID_MAX_LENGTH = 512;

export function isOpenShellSandboxId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= SANDBOX_ID_MAX_LENGTH &&
    SANDBOX_ID_RE.test(value)
  );
}

export function fingerprintOpenShellSandboxId(sandboxId: string): string | null {
  return isOpenShellSandboxId(sandboxId)
    ? createHash("sha256").update(sandboxId).digest("hex")
    : null;
}
