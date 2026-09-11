// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Hermes Portable onboarding lifecycle lock", () => {
  it("uses host receipt state when the process starts on a non-default gateway port", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-onboard-lock-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
    vi.resetModules();

    try {
      const [portable, lock, paths] = await Promise.all([
        import("../experimental/hermes-portable-onboarding"),
        import("../../state/mcp-lifecycle-lock-acquisition"),
        import("../../state/paths"),
      ]);
      const portableLockStateDir = path.join(
        portable.defaultHermesPortableStateDir(process.env),
        "state",
      );
      const gatewayStateDir = paths.resolveNemoclawStateDir();
      const withLifecycleLock = portable.bindHermesPortableOnboardingLifecycleLock(
        lock.withMcpLifecycleLock,
      );

      expect(gatewayStateDir).toBe(path.join(home, ".nemoclaw", "gateways", "18080", "state"));
      expect(portableLockStateDir).toBe(path.join(home, ".nemoclaw", "state"));

      await withLifecycleLock("alpha", async () => {
        expect(lock.isMcpLifecycleLockHeld("alpha", portableLockStateDir)).toBe(true);
        expect(lock.isMcpLifecycleLockHeld("alpha", gatewayStateDir)).toBe(false);
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
