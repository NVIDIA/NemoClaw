// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";

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
  fingerprintSandboxRegistryEntry,
  fingerprintSandboxRecreateValue,
} from "../../onboard/sandbox-recreate-transaction";
import {
  destroyPresence,
  dockerRuntime,
  onboardSession as sessionDependency,
  rebuildPreflightPhase,
  registerHarnessRebuildBackup,
} from "../../../../test/helpers/rebuild-flow-harness";

const onboardSession = sessionDependency as typeof import("../../state/onboard-session");

function useRealSessions(): void {
  vi.mocked(onboardSession.loadSession).mockRestore();
  vi.mocked(onboardSession.loadRebuildSession).mockRestore();
  vi.mocked(onboardSession.listRetainedSandboxRecoveryRecords).mockRestore();
  vi.mocked(onboardSession.selectRebuildSession).mockRestore();
  vi.mocked(onboardSession.updateSession).mockRestore();
  vi.mocked(onboardSession.compareAndSwapSession).mockRestore();
  vi.mocked(onboardSession.acquireOnboardLock).mockRestore();
  vi.mocked(onboardSession.releaseOnboardLock).mockRestore();
}

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
    useRealSessions();

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

  it("resumes an identity-free retained replacement through rebuild while beta is active (#7475)", async () => {
    const onboard = vi
      .fn()
      .mockRejectedValueOnce(new Error("interrupted replacement"))
      .mockImplementation(async () => {
        expect(onboardSession.loadSession()?.sandboxName).toBe("alpha");
        expect(onboardSession.loadSession()?.checkpoint?.sandboxRecreate?.sandboxName).toBe(
          "alpha",
        );
      });
    const harness = createRebuildFlowHarness({ onboard });
    useRealSessions();
    onboardSession.saveSession(onboardSession.createSession({ sandboxName: "alpha" }));
    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");
    const interrupted = onboardSession.loadSession();
    const journal = interrupted?.checkpoint?.sandboxRecreate;
    expect(journal?.phase).toBe("deleted");
    const savedSource = harness.getSandboxEntry();
    expect(fingerprintSandboxRegistryEntry(savedSource)).toBe(journal?.sourceRegistryFingerprint);
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const { resolveGatewayStateDirForPort } = await import("../../onboard/gateway-binding");
    const { writeDockerDriverGatewayRuntimeMarkerForStateDir } =
      await import("../../onboard/docker-driver-gateway-runtime-marker");
    writeDockerDriverGatewayRuntimeMarkerForStateDir(
      resolveGatewayStateDirForPort({ home: testHome, port: journal!.gatewayPort }),
      {
        pid: 4242,
        desiredEnv: {},
        endpoint: `https://127.0.0.1:${journal!.gatewayPort}`,
        dockerHost: null,
        createdAt: new Date(Date.now() - 1_000).toISOString(),
        runtimeProviderId: "docker",
      },
    );
    onboardSession.markRetainedSandboxRecovery(
      "alpha",
      "replacement identity unavailable",
      undefined,
      {
        gatewayName: journal!.gatewayName,
        gatewayPort: journal!.gatewayPort,
        lifecycleGeneration: journal!.targetGeneration,
        createAttemptNonce: "a".repeat(62),
      },
    );
    expect(onboardSession.listRetainedSandboxRecoveryRecords()).toHaveLength(1);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(harness.backupPath, "rebuild-manifest.json"), "utf8"),
    );
    expect(onboardSession.acquireOnboardLock("select beta").acquired).toBe(true);
    try {
      onboardSession.selectRebuildSession("beta");
    } finally {
      onboardSession.releaseOnboardLock();
    }
    expect(onboardSession.loadSession()?.sandboxName).toBe("beta");
    expect(onboardSession.loadRebuildSession("alpha")?.checkpoint?.sandboxRecreate?.id).toBe(
      journal?.id,
    );
    const resumed = createRebuildFlowHarness({
      staleRecovery: true,
      sandboxEntry: { ...savedSource },
      captureOpenshell: (args) =>
        args.includes("list")
          ? { status: 0, output: "[]", stdout: "[]", stderr: "" }
          : {
              status: 1,
              output: "",
              stdout: "",
              stderr: "Error: sandbox alpha not found",
            },
      onboard,
    });
    useRealSessions();
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
    vi.stubEnv("DOCKER_CONTEXT", "default");
    vi.spyOn(dockerRuntime, "dockerRun").mockImplementation((args) => {
      expect(args).toContain("volume");
      return { status: 0, stdout: "", stderr: "", pid: 0, output: [null, "", ""], signal: null };
    });
    vi.spyOn(destroyPresence, "observeDestroyContainerIdentity").mockReturnValue({
      status: "observed",
      rows: [],
      malformedRows: 0,
    });
    // Production discovery rereads the persisted manifest, including later handoff writes.
    registerHarnessRebuildBackup(manifest);
    resumed.backupSandboxStateSpy.mockClear();
    resumed.runOpenshellSpy.mockClear();
    const runPreflight = rebuildPreflightPhase.runRebuildPreflightPhase;
    const preflight = vi
      .spyOn(rebuildPreflightPhase, "runRebuildPreflightPhase")
      .mockImplementation((...args) => {
        // Successful rebuilds retire the MCP handoff in place after preflight.
        expect(args).toEqual([
          "alpha",
          { yes: true, force: false, verbose: false },
          expect.objectContaining({ recoveryManifest: manifest }),
        ]);
        return runPreflight(...args);
      });

    await expect(
      resumed.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(preflight).toHaveBeenCalledOnce();
    expect(onboard).toHaveBeenCalledTimes(2);
    expect(resumed.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(onboardSession.listRetainedSandboxRecoveryRecords()).toEqual([]);
    expectNoSandboxDelete(resumed.runOpenshellSpy);
    expect(onboardSession.loadSession()?.checkpoint?.sandboxRecreate?.id).toBe(
      interrupted?.checkpoint?.sandboxRecreate?.id,
    );
  });
});
