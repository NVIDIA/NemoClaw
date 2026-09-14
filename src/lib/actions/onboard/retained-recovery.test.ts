// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyOpenShellSandboxPresence } from "../../adapters/openshell/sandbox-presence";
import { resolveOnboardEntryOptions } from "../../onboard/entry-options";
import type { RetainedSandboxRecoveryRecord } from "../../state/onboard-session/retained-sandbox-recovery";
import type { SandboxEntry } from "../../state/registry";
import * as gatewayRuntime from "../../gateway-runtime-action";
import * as destroyRuntime from "../sandbox/destroy";
import {
  createRetainedOnboardRecovery,
  reconcileRetainedN1xOnboard,
  type RetainedOnboardRecoveryDeps,
} from "./retained-recovery";

vi.mock("../../state/mcp-lifecycle-lock-acquisition", () => ({
  withMcpLifecycleLock: async (_name: string, operation: () => Promise<unknown>) => operation(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const options = {
  sandboxName: null,
  resume: false,
  agent: null,
  experimentalProfile: null,
  apfInterceptorRequested: null,
};

function harness(name = "my-assistant") {
  const record: RetainedSandboxRecoveryRecord = {
    schemaVersion: 1,
    recordId: "a".repeat(64),
    sandboxName: name,
    sandboxIdentityFingerprint: "b".repeat(64),
    identityWasUnavailable: false,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "failed-generation",
    createAttemptNonce: "c".repeat(62),
    resources: {
      sharedInferenceProviders: ["vllm-local"],
      sandboxScopedProviders: [],
      credentialEnvironmentVariables: [],
    },
    reason: "retained_after_sandbox_creation_failure",
    recordedAt: "2026-09-11T16:54:47.903Z",
  };
  const entry: SandboxEntry = {
    name,
    provider: "vllm-local",
    model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    endpointSource: null,
    pendingRouteReservation: true,
    openshellDriver: null,
    gatewayName: record.gatewayName,
    gatewayPort: record.gatewayPort,
  };
  const state = {
    records: [record] as readonly RetainedSandboxRecoveryRecord[],
    entry: entry as SandboxEntry | null,
    gatewayAvailable: false,
    response: { status: 0, stdout: "[]", stderr: "" },
  };
  const deps: RetainedOnboardRecoveryDeps = {
    gatewayPort: 8080,
    validateName: (name) => name,
    env: {},
    loadSession: () => null,
    listRecords: () => state.records,
    getSandbox: () => state.entry,
    withLock: vi.fn(async (_name, operation) => operation()),
    recoverGateway: vi.fn(async () => {
      state.gatewayAvailable = true;
      return true;
    }),
    observeSandbox: vi.fn(() =>
      classifyOpenShellSandboxPresence(
        name,
        state.gatewayAvailable
          ? state.response
          : { status: 1, stderr: "Unknown gateway 'nemoclaw'" },
      ),
    ),
    confirm: vi.fn(async () => true),
    destroy: vi.fn(async () => {
      state.entry = null;
      state.records = [];
    }),
  };
  return { state, deps, record, entry };
}

describe("retrying a retained N1x onboarding name", () => {
  it("scopes production recovery to its recorded gateway and requires a cleanup answer", async () => {
    const h = harness();
    vi.stubEnv("OPENSHELL_GATEWAY", "another-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", undefined);
    vi.stubEnv("NEMOCLAW_YES", "1");
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");
    vi.spyOn(process, "stdin", "get").mockReturnValue({
      isTTY: true,
      fd: 0,
    } as typeof process.stdin);
    vi.spyOn(gatewayRuntime.gatewayRuntimeDependencies, "observeGateway").mockResolvedValue({
      state: "healthy_named",
      activeGateway: "nemoclaw",
      recoveryBlocked: false,
      unavailable: false,
      diagnostic: "Connected",
    });
    vi.spyOn(gatewayRuntime, "observeNamedGatewaySandboxPresence").mockReturnValue("absent");
    const destroy = vi.spyOn(destroyRuntime, "destroySandbox").mockImplementation(h.deps.destroy);
    const prompt = vi.fn(async () => {
      expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw");
      expect(process.env.OPENSHELL_WORKSPACE).toBe("default");
      expect(destroy).not.toHaveBeenCalled();
      return "yes";
    });

    await expect(createRetainedOnboardRecovery({ ...h.deps, prompt })(options)).resolves.toBe(
      "my-assistant",
    );

    expect(prompt).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledExactlyOnceWith("my-assistant", {
      yes: true,
      cleanupGateway: false,
    });
    expect(process.env.OPENSHELL_GATEWAY).toBe("another-gateway");
    expect(process.env.OPENSHELL_WORKSPACE).toBeUndefined();
  });

  it("does not authorize production cleanup from installer auto-yes without a terminal", async () => {
    const h = harness();
    vi.stubEnv("OPENSHELL_WORKSPACE", undefined);
    vi.stubEnv("NEMOCLAW_YES", "1");
    vi.spyOn(process, "stdin", "get").mockReturnValue({
      isTTY: false,
      fd: 0,
    } as typeof process.stdin);
    vi.spyOn(gatewayRuntime.gatewayRuntimeDependencies, "observeGateway").mockResolvedValue({
      state: "healthy_named",
      activeGateway: "nemoclaw",
      recoveryBlocked: false,
      unavailable: false,
      diagnostic: "Connected",
    });
    vi.spyOn(gatewayRuntime, "observeNamedGatewaySandboxPresence").mockReturnValue("absent");
    const destroy = vi.spyOn(destroyRuntime, "destroySandbox").mockImplementation(h.deps.destroy);
    const prompt = vi.fn();

    await expect(createRetainedOnboardRecovery({ ...h.deps, prompt })(options)).rejects.toThrow(
      "authorize cleanup",
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(h.state.records).toEqual([h.record]);
  });

  it.each([null, "my-assistant", "custom-assistant"])(
    "restores the missing gateway and admits the same name %s after confirmed cleanup (#11510)",
    async (sandboxName) => {
      const h = harness(sandboxName ?? "my-assistant");
      const recoveredName = await reconcileRetainedN1xOnboard({ ...options, sandboxName }, h.deps);

      expect(h.state.gatewayAvailable).toBe(true);
      expect(recoveredName).toBe(h.record.sandboxName);
      expect(h.deps.destroy).toHaveBeenCalledExactlyOnceWith(h.record.sandboxName);
      expect(h.state.records).toEqual([]);
      const admitted = resolveOnboardEntryOptions(
        {
          opts: { sandboxName: recoveredName, fresh: true },
          env: {},
          stdinIsTty: true,
          stdoutIsTty: true,
          retainedRecoverySandboxNames: h.state.records.map((record) => record.sandboxName),
        },
        {
          isNonInteractive: () => false,
          validateName: (name) => name,
          reservedSandboxNames: new Set(),
          cliDisplayName: () => "nemoclaw",
          getNameValidationGuidance: () => [],
          error: vi.fn(),
          exitProcess: () => {
            throw new Error("Onboarding remained blocked");
          },
        },
      );
      expect(admitted).toMatchObject({ requestedSandboxName: h.record.sandboxName, fresh: true });
    },
  );

  it("uses the installer-selected name without requiring an active session", async () => {
    const h = harness("installer-name");
    h.deps.env.NEMOCLAW_SANDBOX_NAME = "installer-name";
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).resolves.toBe("installer-name");
  });

  it.each([
    { status: 1, stdout: "", stderr: "Unknown gateway 'nemoclaw'" },
    { status: 0, stdout: "not-json", stderr: "" },
    {
      status: 0,
      stdout: JSON.stringify([
        {
          id: "retained-sandbox",
          name: "my-assistant",
          labels: {},
          resource_version: 1,
          created_at: "2026-09-11T16:54:47Z",
          phase: "Ready",
          current_policy_version: 1,
        },
      ]),
      stderr: "",
    },
  ])("preserves recovery when absence is unproven: %j", async (response) => {
    const h = harness();
    h.state.response = response;
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).resolves.toBeNull();
    expect(h.deps.confirm).not.toHaveBeenCalled();
    expect(h.deps.destroy).not.toHaveBeenCalled();
    expect(h.state.records).toEqual([h.record]);
  });

  it("does not clear recovery when gateway restoration fails", async () => {
    const h = harness();
    h.deps.recoverGateway = vi.fn(async () => false);
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).rejects.toThrow("Could not restore");
    expect(h.deps.observeSandbox).not.toHaveBeenCalled();
    expect(h.deps.destroy).not.toHaveBeenCalled();
    expect(h.state.records).toEqual([h.record]);
  });

  it("preserves the record when cleanup is declined despite installer auto-yes", async () => {
    const h = harness();
    h.deps.env.NEMOCLAW_YES = "1";
    h.deps.env.NEMOCLAW_NON_INTERACTIVE = "1";
    h.deps.confirm = vi.fn(async () => false);
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).rejects.toThrow("authorize cleanup");
    expect(h.deps.destroy).not.toHaveBeenCalled();
    expect(h.state.entry).toEqual(h.entry);
  });

  it("refuses a recovery record replaced during confirmation", async () => {
    const h = harness();
    h.deps.confirm = async () => {
      h.state.records = [{ ...h.record, createAttemptNonce: "d".repeat(62) }];
      return true;
    };
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).rejects.toThrow("authority");
    expect(h.deps.destroy).not.toHaveBeenCalled();
  });

  it("refuses registry authority changed during gateway restoration", async () => {
    const h = harness();
    h.deps.recoverGateway = async () => {
      h.state.entry = { ...h.entry, lifecycleGeneration: "replacement" };
      return true;
    };
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).rejects.toThrow("authority");
    expect(h.deps.observeSandbox).not.toHaveBeenCalled();
    expect(h.deps.destroy).not.toHaveBeenCalled();
  });

  it("does not admit the name when destroy leaves unresolved recovery", async () => {
    const h = harness();
    h.deps.destroy = async () => {};
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).rejects.toThrow("not confirmed");
    expect(h.state.records).toEqual([h.record]);
  });

  it.each([
    { resume: true },
    { agent: "hermes" },
    { apfInterceptorRequested: true },
    { sandboxName: "another-name" },
  ])("preserves other onboarding intent %j", async (override) => {
    const h = harness();
    await expect(
      reconcileRetainedN1xOnboard({ ...options, ...override }, h.deps),
    ).resolves.toBeNull();
    expect(h.deps.recoverGateway).not.toHaveBeenCalled();
    expect(h.deps.destroy).not.toHaveBeenCalled();
  });

  it.each([
    { provider: "compatible-endpoint" },
    { model: "another-model" },
    { pendingRouteReservation: undefined },
    { openshellDriver: "podman" },
    { gatewayName: "another-gateway" },
    { gatewayPort: 18080 },
    { endpointUrl: "https://external.example/v1" },
    { endpointSource: "inference-set" as const },
    { nimContainer: "nemoclaw-nim" },
  ])("preserves routes outside the failed N1x attempt: %j", async (override) => {
    const h = harness();
    h.state.entry = { ...h.entry, ...override };
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).resolves.toBeNull();
    expect(h.deps.recoverGateway).not.toHaveBeenCalled();
    expect(h.deps.destroy).not.toHaveBeenCalled();
  });

  it("preserves a cancelled attempt and multiple matching recovery records", async () => {
    const h = harness();
    h.state.records = [{ ...h.record, reason: "cancelled_after_sandbox_creation" }];
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).resolves.toBeNull();
    h.state.records = [h.record, { ...h.record, recordId: "d".repeat(64) }];
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).resolves.toBeNull();
    expect(h.deps.recoverGateway).not.toHaveBeenCalled();
    expect(h.deps.destroy).not.toHaveBeenCalled();
  });

  it("preserves recovery under another workspace selection", async () => {
    const h = harness();
    h.deps.env.OPENSHELL_WORKSPACE = "other";
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).resolves.toBeNull();
    expect(h.deps.recoverGateway).not.toHaveBeenCalled();
    expect(h.deps.destroy).not.toHaveBeenCalled();
  });

  it("preserves recovery when the environment selects another agent", async () => {
    const h = harness();
    h.deps.env.NEMOCLAW_AGENT = "hermes";
    await expect(reconcileRetainedN1xOnboard(options, h.deps)).resolves.toBeNull();
    expect(h.deps.recoverGateway).not.toHaveBeenCalled();
    expect(h.deps.destroy).not.toHaveBeenCalled();
  });
});
