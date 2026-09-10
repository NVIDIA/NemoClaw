// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as receiptAuthority from "../../../onboard/experimental/hermes-portable-receipt";
import {
  portableLifecycleLockOptions,
  resolveHermesPortableLifecycleLockOptions,
} from "../../../onboard/experimental/portable-lifecycle-lock";
import { isMcpLifecycleLockHeld } from "../../../state/mcp-lifecycle-lock-acquisition";
import { portableHostFencePath } from "../../../state/portable-uninstall-retirement";
import { withSandboxLifecycleLock, withSandboxLifecycleLockSync } from "./lock";

describe("Portable-aware sandbox lifecycle lock", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-lifecycle-lock-"));
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
    vi.spyOn(receiptAuthority, "hasHermesPortableReceiptCandidate").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("reuses one host-scoped lock through asynchronous and synchronous lifecycle layers", async () => {
    const portableStateDir = portableLifecycleLockOptions(process.env).stateDir;
    const gatewayStateDir = path.join(homeDir, ".nemoclaw", "gateways", "18080", "state");

    await withSandboxLifecycleLock("alpha", async () => {
      expect(fs.existsSync(portableHostFencePath(homeDir))).toBe(true);
      expect(isMcpLifecycleLockHeld("alpha", portableStateDir)).toBe(true);
      expect(isMcpLifecycleLockHeld("alpha", gatewayStateDir)).toBe(false);

      withSandboxLifecycleLockSync("alpha", () => {
        expect(isMcpLifecycleLockHeld("alpha", portableStateDir)).toBe(true);
        expect(isMcpLifecycleLockHeld("alpha", gatewayStateDir)).toBe(false);
      });

      await withSandboxLifecycleLock("alpha", () => {
        expect(isMcpLifecycleLockHeld("alpha", portableStateDir)).toBe(true);
        expect(isMcpLifecycleLockHeld("alpha", gatewayStateDir)).toBe(false);
      });
    });

    expect(fs.existsSync(portableHostFencePath(homeDir))).toBe(false);
  });

  it("selects host receipt state only for a Hermes Portable candidate", () => {
    const env = { HOME: homeDir, NEMOCLAW_GATEWAY_PORT: "18080" };

    expect(resolveHermesPortableLifecycleLockOptions("alpha", env, () => true)).toEqual({
      stateDir: path.join(homeDir, ".nemoclaw", "state"),
    });
    expect(resolveHermesPortableLifecycleLockOptions("alpha", env, () => false)).toBeUndefined();
  });

  it("rejects a direct synchronous Portable operation without the host fence", () => {
    expect(() => withSandboxLifecycleLockSync("alpha", () => undefined)).toThrow(
      "Portable host authority mutation requires the current HOME fence",
    );
  });

  it("serializes competing Portable lifecycle operations on the same authority", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstWaiting = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = withSandboxLifecycleLock("alpha", async () => {
      events.push("first-entered");
      firstEntered();
      await firstWaiting;
      events.push("first-released");
    });
    await firstStarted;
    const second = withSandboxLifecycleLock("alpha", () => {
      events.push("second-entered");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events).toEqual(["first-entered"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-entered", "first-released", "second-entered"]);
  });
});
