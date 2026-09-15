// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };

const { Type } = require("typebox") as typeof TypeBoxModule;
const { Check } = require("typebox/value") as typeof TypeBoxValueModule;
const SandboxIdSchema = Type.String({ minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9._-]+$" });

export function isOpenShellSandboxId(value: unknown): value is string {
  return Check(SandboxIdSchema, value);
}

export function fingerprintOpenShellSandboxId(sandboxId: string): string | null {
  return isOpenShellSandboxId(sandboxId)
    ? createHash("sha256").update(sandboxId).digest("hex")
    : null;
}
