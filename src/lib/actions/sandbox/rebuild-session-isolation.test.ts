// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { testHome, originalHome } = vi.hoisted(() => {
  const fs = process.getBuiltinModule("node:fs");
  const os = process.getBuiltinModule("node:os");
  const path = process.getBuiltinModule("node:path");
  const originalHome = process.env.HOME;
  const testHome = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-flow-session-")),
  );
  process.env.HOME = testHome;
  return { testHome, originalHome };
});

import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import {
  beginSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
} from "../../onboard/sandbox-recreate-transaction";
import { onboardSession as sessionDependency } from "../../../../test/helpers/rebuild-flow-harness";

const onboardSession = sessionDependency as typeof import("../../state/onboard-session");

describe("rebuild with independent recovery sessions", () => {
  installRebuildFlowTestHooks();
  beforeEach(() => {
    vi.stubEnv("HOME", testHome);
    expect(onboardSession.SESSION_DIR.startsWith(`${testHome}${path.sep}`)).toBe(true);
  });
  afterEach(() => {
    onboardSession.releaseOnboardLock();
    fs.rmSync(path.join(testHome, ".nemoclaw"), { recursive: true, force: true });
  });
  afterAll(() => {
    fs.rmSync(testHome, { recursive: true, force: true });
    originalHome === undefined
      ? Reflect.deleteProperty(process.env, "HOME")
      : Reflect.set(process.env, "HOME", originalHome);
  });

  it("rebuilds alpha through the public entrypoint while beta keeps its interrupted recovery (#11379)", async () => {
    const interrupted = onboardSession.createSession({ sandboxName: "beta", agent: "openclaw" });
    const transaction = beginSandboxRecreateTransaction(interrupted, {
      sandboxName: "beta",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sourceEntry: { name: "beta", agent: "openclaw" },
      observation: { state: "missing", liveIdentityFingerprint: null },
      targetIntentFingerprint: fingerprintSandboxRecreateValue("beta-target"),
    });
    interrupted.checkpoint = {
      ...interrupted.checkpoint!,
      sandboxIdentity: { kind: "selected", value: { name: "beta", agent: "openclaw" } },
      gatewayAuthority: {
        kind: "selected",
        value: {
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          mode: "nemoclaw-managed",
          source: "standalone",
          endpoint: null,
          stateDir: null,
          supervisor: null,
          requiredCapabilities: [],
        },
      },
      sandboxRecreate: transaction,
    };
    const saved = onboardSession.saveSession(interrupted);
    const harness = createRebuildFlowHarness({
      onboard: () => {
        expect(onboardSession.loadSession()?.sandboxName).toBe("alpha");
        expect(onboardSession.loadSession()?.checkpoint?.sandboxRecreate?.sandboxName).toBe(
          "alpha",
        );
      },
    });
    // Keep external runtime fixtures, but exercise the real session files and lock.
    vi.mocked(onboardSession.loadSession).mockRestore();
    vi.mocked(onboardSession.loadRebuildSession).mockRestore();
    vi.mocked(onboardSession.selectRebuildSession).mockRestore();
    vi.mocked(onboardSession.updateSession).mockRestore();
    vi.mocked(onboardSession.compareAndSwapSession).mockRestore();
    vi.mocked(onboardSession.acquireOnboardLock).mockRestore();
    vi.mocked(onboardSession.releaseOnboardLock).mockRestore();

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.onboardSpy).toHaveBeenCalledOnce();
    expect(onboardSession.loadRebuildSession("beta")).toEqual(saved);
    expect(onboardSession.isOnboardLockHeldByCurrentProcess()).toBe(false);
    expect(onboardSession.acquireOnboardLock("resume beta").acquired).toBe(true);
    try {
      onboardSession.selectRebuildSession("beta");
      expect(onboardSession.loadSession()).toEqual(saved);
    } finally {
      onboardSession.releaseOnboardLock();
    }
  });
});
