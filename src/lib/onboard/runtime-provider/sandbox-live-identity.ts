// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export function fingerprintSandboxLiveIdentity(getOutput: string): string | null {
  const clean = String(getOutput).replace(/\x1b\[[0-9;]*m/g, "");
  const match = clean.match(/^\s*Id:\s+(\S+)\s*$/im);
  if (!match?.[1] || match[1].length > 512) return null;
  return createHash("sha256").update(match[1], "utf8").digest("hex");
}

export interface SandboxRecreateObservation {
  readonly state: "missing" | "not_ready" | "ready";
  readonly liveIdentityFingerprint: string | null;
}
