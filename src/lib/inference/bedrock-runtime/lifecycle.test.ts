// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveBedrockRuntimeAdapterLifecyclePaths,
  withBedrockRuntimeAdapterLifecycleLock,
} from "./lifecycle";
import { readMcpLockProcessIdentity } from "../../state/mcp-lifecycle-lock-identity";

describe("Bedrock Runtime adapter lifecycle", () => {
  it("records stable owner identity so a live lock cannot be reclaimed by age", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-lifecycle-lock-"));
    const lifecycle = resolveBedrockRuntimeAdapterLifecyclePaths(home, 8080);
    const expectedIdentity = readMcpLockProcessIdentity(process.pid, true);

    try {
      expect(expectedIdentity).not.toBeNull();
      withBedrockRuntimeAdapterLifecycleLock(lifecycle, () => {
        const owner = JSON.parse(fs.readFileSync(lifecycle.lockPath, "utf8"));
        expect(owner).toMatchObject({
          pid: process.pid,
          processIdentity: expectedIdentity,
        });
      });
      expect(fs.existsSync(lifecycle.lockPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
