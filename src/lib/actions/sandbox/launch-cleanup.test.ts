// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { loadAgent } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import { launchSandbox } from "./launch";

const mocks = vi.hoisted(() => ({ startSandboxExec: vi.fn() }));
vi.mock("./exec", () => ({ startSandboxExec: mocks.startSandboxExec }));
vi.mock("./connect", () => ({
  printInteractiveSessionHints: vi.fn(),
  completeReadinessQualifiedInteractiveSessionSetup: vi.fn(),
}));
vi.mock("./connect-hermes-light-skin", () => ({ prepareHermesLightTerminalSkin: vi.fn() }));
vi.mock("./gateway-state", async (original) => ({
  ...(await original<typeof import("./gateway-state")>()),
  inspectPortableAgentReceiptDisposition: () => ({ kind: "absent" }),
}));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createSerialTestLock(
  events: string[],
  label: string,
): <T>(name: string, operation: () => Promise<T> | T) => Promise<T> {
  let tail = Promise.resolve();
  return async <T>(_name: string, operation: () => Promise<T> | T): Promise<T> => {
    const previous = tail;
    const release = deferred();
    tail = previous.then(() => release.promise);
    await previous;
    events.push(`${label}:acquired`);
    try {
      return await operation();
    } finally {
      events.push(`${label}:released`);
      release.resolve();
    }
  };
}

describe("interactive launch cleanup", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    { replacement: "unchanged", cleanupCount: 1, stateFile: "unrelated.json", error: "exit:0" },
    { replacement: "legacy", cleanupCount: 1, stateFile: "unrelated.json", error: "exit:0" },
    {
      replacement: "legacy-replaced",
      cleanupCount: 0,
      stateFile: "unrelated.json",
      error: "exit:0",
    },
    {
      replacement: "legacy-missing",
      cleanupCount: 0,
      stateFile: "unrelated.json",
      error: "exit:0",
    },
    {
      replacement: "legacy-unavailable",
      cleanupCount: 0,
      stateFile: "unrelated.json",
      error: "probe unavailable",
    },
    { replacement: "gateway-moved", cleanupCount: 0, stateFile: "unrelated.json", error: "exit:0" },
    { replacement: "metadata", cleanupCount: 1, stateFile: "unrelated.json", error: "exit:0" },
    { replacement: "recreated", cleanupCount: 0, stateFile: "unrelated.json", error: "exit:0" },
    { replacement: "removed", cleanupCount: 0, stateFile: "unrelated.json", error: "exit:0" },
    {
      replacement: "legacy-recovery",
      cleanupCount: 0,
      stateFile: "shields-timer-alpha.json",
      error: /recovery artifacts from the removed Shields/u,
    },
  ])(
    "binds completion cleanup to the launched sandbox ($replacement)",
    async ({ replacement, cleanupCount, stateFile, error }) => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      onTestFinished(() => stderr.mockRestore());
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launch-cleanup-"));
      onTestFinished(() => fs.rmSync(stateDir, { recursive: true, force: true }));
      vi.stubEnv("HOME", stateDir);
      vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", stateDir);
      vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", stateDir);
      const statePath = path.join(stateDir, stateFile);
      const { startSandboxExec } = await vi.importActual<typeof import("./exec")>("./exec");
      const agent = loadAgent("openclaw");
      const legacy = ["legacy", "legacy-replaced", "legacy-missing", "legacy-unavailable"].includes(
        replacement,
      );
      let current: SandboxEntry | null = {
        ...({ name: "alpha", agent: agent.name } as SandboxEntry),
        gatewayName: "nemoclaw-8081",
        lifecycleGeneration: legacy ? undefined : "generation-alpha",
        lifecycleLiveIdentityFingerprint: legacy ? undefined : "f".repeat(64),
      };
      let liveIdentityFingerprint: string | null = "f".repeat(64);
      const sessionEnded = deferred();
      const childStarted = deferred();
      const events: string[] = [];
      const lock = createSerialTestLock(events, "sandbox");
      const cleanup = vi.fn(() => {
        events.push("cleanup");
        return { applies: true as const, ok: false, issues: ["config mode drift"] };
      });
      const repair = vi.fn(() => ({ applied: true as const, verified: true, errors: [] }));
      const observeSandbox = vi.fn(() => {
        events.push("identity");
        return { state: "ready" as const, liveIdentityFingerprint };
      });
      const release = vi.fn();
      mocks.startSandboxExec.mockImplementation((name, command, options, deps) =>
        startSandboxExec(name, command, options, {
          ...deps,
          selectGateway: () => ({ outcome: "unregistered", gatewayName: null }),
          commandExecutor: {
            probeDirectory: async () => ({ state: "present" }),
            runStreaming: async () => {
              childStarted.resolve();
              await sessionEnded.promise;
              return { outcome: { kind: "completed", exitCode: 0 }, release };
            },
          },
          cleanupDeps: {
            getSandbox: () => current,
            inspectMutableConfigPerms: cleanup,
            repairMutableConfigPerms: repair,
          },
          policyHint: {
            env: {},
            probeLogs: () => "",
            enableAudit: () => {},
            sleep: async () => {},
            attempts: 1,
          },
          exit: (code) => {
            throw new Error(`exit:${code}`);
          },
        }),
      );
      const launch = launchSandbox("alpha", {
        inspectLaunchReadiness: async () => ({
          kind: "accepted",
          category: "accepted",
          agent,
          sb: current!,
        }),
        getSandbox: () => current,
        observeSandbox,
        withSandboxMutationLock: lock,
      });
      const completion = expect(launch).rejects.toThrow(error === "exit:0" ? error : "exit:1");
      await childStarted.promise;
      await lock("alpha", () => {
        fs.writeFileSync(statePath, "recorded state\n");
        current =
          replacement === "removed"
            ? null
            : {
                ...current!,
                gatewayPort: replacement === "gateway-moved" ? 8082 : current!.gatewayPort,
                model: replacement === "metadata" ? "updated-model" : current!.model,
                lifecycleGeneration:
                  replacement === "recreated" ? "generation-new" : current!.lifecycleGeneration,
              };
        liveIdentityFingerprint =
          replacement === "legacy-missing"
            ? null
            : replacement === "legacy-replaced"
              ? "e".repeat(64)
              : liveIdentityFingerprint;
        observeSandbox.mockImplementation(() => {
          events.push("identity");
          replacement !== "legacy-unavailable" ||
            (() => {
              throw new Error("probe unavailable");
            })();
          return { state: "ready" as const, liveIdentityFingerprint };
        });
        events.push("replacement-observed");
      });
      expect(cleanup).not.toHaveBeenCalled();
      events.length = 0;
      sessionEnded.resolve();
      await completion;
      expect(stderr.mock.calls.map(([line]) => line)).toEqual(
        error === "exit:0" ? [] : [expect.stringMatching(error)],
      );
      expect(cleanup).toHaveBeenCalledTimes(cleanupCount);
      expect(repair).toHaveBeenCalledTimes(cleanupCount);
      expect(observeSandbox).toHaveBeenCalledTimes(legacy ? 2 : 0);
      expect(release).toHaveBeenCalledOnce();
      expect(fs.readFileSync(statePath, "utf8")).toBe("recorded state\n");
      expect(events).toEqual([
        "sandbox:acquired",
        ...(legacy ? ["identity"] : []),
        ...(cleanupCount === 1 ? ["cleanup"] : []),
        "sandbox:released",
      ]);
    },
  );
  it.each([
    { state: "missing", liveIdentityFingerprint: null },
    { state: "not_ready", liveIdentityFingerprint: "f".repeat(64) },
    { state: "ready", liveIdentityFingerprint: null },
  ] as const)(
    "stops before dispatch when legacy identity is unverified ($state)",
    async (observation) => {
      const entry = {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw-8081",
      } as SandboxEntry;
      const events: string[] = [];
      const observeSandbox = vi.fn(() => observation);
      await expect(
        launchSandbox("alpha", {
          getSandbox: () => entry,
          inspectLaunchReadiness: async () => ({
            kind: "accepted",
            category: "accepted",
            agent: loadAgent("openclaw"),
            sb: entry,
          }),
          withSandboxMutationLock: createSerialTestLock(events, "sandbox"),
          observeSandbox,
        }),
      ).rejects.toThrow(/Cannot verify the live identity.*sandbox doctor/u);
      expect(observeSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxName: "alpha",
          gatewayName: "nemoclaw-8081",
          gatewayPort: 8081,
        }),
      );
      expect(mocks.startSandboxExec).not.toHaveBeenCalled();
      expect(events).toEqual(["sandbox:acquired", "sandbox:released"]);
    },
  );
});
