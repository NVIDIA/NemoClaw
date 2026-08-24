// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";

type RunSandboxDoctor = (typeof import("./doctor"))["runSandboxDoctor"];
type PortableAgentReceiptDisposition = ReturnType<
  (typeof import("../../onboard/experimental/portable-agent-lifecycle"))["inspectPortableAgentReceiptDisposition"]
>;
type WithMcpLifecycleLock =
  (typeof import("../../state/mcp-lifecycle-lock-acquisition"))["withMcpLifecycleLock"];

function hermesPortableDisposition(phase: "pending" | "configuring" | "active") {
  return {
    kind: "hermes" as const,
    phase,
    gatewayName: "nemoclaw-19080",
    lifecycleGeneration: "generation-1",
    liveIdentityFingerprint: phase === "pending" ? null : "fingerprint-1",
  };
}

type DoctorHarnessOptions = {
  portableDisposition?:
    | PortableAgentReceiptDisposition
    | Error
    | (() => PortableAgentReceiptDisposition | Error);
  registryEntry?: "present" | "missing";
  registryAgent?: "openclaw" | "hermes";
  registryOverrides?: Record<string, unknown>;
  withMcpLifecycleLock?: WithMcpLifecycleLock;
};

const requireDist = createRequire(import.meta.url);
const doctorModulePath = "./doctor.js";

function createDoctorHarness(
  provider = "ollama-local",
  options: DoctorHarnessOptions = {},
): {
  buildToolScopeChecksSpy: MockInstance;
  captureOpenShellSpy: MockInstance;
  captureHostCommandSpy: MockInstance;
  configuredMessagingChannelsSpy: MockInstance;
  executeSandboxCommandForVerificationSpy: MockInstance;
  getBaselineExclusionsSpy: MockInstance;
  getBaselineExclusionTransitionSpy: MockInstance;
  getBaselineExclusionRuntimeStatusSpy: MockInstance;
  getSandboxSpy: MockInstance;
  getNamedGatewayLifecycleStateSpy: MockInstance;
  healthProbeSpy: MockInstance;
  inspectMutableConfigPermsSpy: MockInstance;
  loadAgentSpy: MockInstance;
  probeSandboxInferenceGatewayHealthSpy: MockInstance;
  logSpy: MockInstance;
  recoverNamedGatewayRuntimeSpy: MockInstance;
  repairMutableConfigPermsSpy: MockInstance;
  resolveOpenShellSpy: MockInstance;
  resolveSandboxGatewayNameSpy: MockInstance;
  runSandboxDoctor: RunSandboxDoctor;
  withMcpLifecycleLockSpy: MockInstance;
} {
  delete require.cache[requireDist.resolve(doctorModulePath)];

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  const resolve = requireDist("../../adapters/openshell/resolve.js");
  const runtime = requireDist("../../adapters/openshell/runtime.js");
  const agentDefs = requireDist("../../agent/defs.js");
  const agentRuntime = requireDist("../../agent/runtime.js");
  const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
  const health = requireDist("../../inference/health.js");
  const dockerDriverPlatform = requireDist("../../onboard/docker-driver-platform.js");
  const gatewayBinding = requireDist("../../onboard/gateway-binding.js");
  const policy = requireDist("../../policy/index.js");
  const sandboxVerificationExec = requireDist("../../onboard/sandbox-verification-exec.js");
  const sandboxVersion = requireDist("../../sandbox/version.js");
  const shields = requireDist("../../shields/index.js");
  const registry = requireDist("../../state/registry.js");
  const statusCommandDeps = requireDist("../../status-command-deps.js");
  const tunnelServices = requireDist("../../tunnel/services.js");
  const doctorHostCommand = requireDist("./doctor-host-command.js");
  const doctorToolScope = requireDist("./doctor-tool-scope.js");
  const inferenceRouteHealth = requireDist("./inference-route-health.js");
  const portableAgentLifecycle = requireDist(
    "../../onboard/experimental/portable-agent-lifecycle.js",
  );
  const doctorSystemChecks = requireDist("./doctor-system-checks.js");

  const qualifyPortableAgentLifecycleAuthority =
    portableAgentLifecycle.qualifyPortableAgentLifecycleAuthority;
  vi.spyOn(doctorSystemChecks, "inspectSandboxDoctorPortableAuthority").mockImplementation(((
    sandboxName: string,
  ) => {
    const disposition =
      typeof options.portableDisposition === "function"
        ? options.portableDisposition()
        : options.portableDisposition;
    switch (disposition instanceof Error) {
      case true:
        throw disposition;
      default:
        return qualifyPortableAgentLifecycleAuthority(sandboxName, {
          inspectReceiptDisposition: () => disposition ?? { kind: "absent" },
          readRegistry: () =>
            options.registryEntry === "missing" ? null : (registryEntry as never),
        });
    }
  }) as never);
  const withMcpLifecycleLockSpy = vi
    .spyOn(doctorSystemChecks, "withSandboxDoctorLifecycleLock")
    .mockImplementation(
      (options.withMcpLifecycleLock ??
        (async (_sandboxName: string, operation: () => unknown) => await operation())) as never,
    );

  const registryEntry = {
    name: "alpha",
    agent: options.registryAgent ?? "openclaw",
    model: "registry-model",
    provider,
    openshellDriver: "docker",
    openshellVersion: "0.0.72",
    nemoclawVersion: "0.0.83",
    fromDockerfile: null,
    dashboardPort: 18789,
    imageTag: "nemoclaw-openclaw:test",
    gatewayName: "nemoclaw-19080",
    gatewayPort: 19080,
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: "fingerprint-1",
    messaging: undefined,
    ...options.registryOverrides,
  };
  const getSandboxSpy = vi
    .spyOn(registry, "getSandbox")
    .mockReturnValue(options.registryEntry === "missing" ? null : registryEntry);
  const configuredMessagingChannelsSpy = vi
    .spyOn(registry, "getConfiguredMessagingChannelsFromEntry")
    .mockReturnValue([]);
  vi.spyOn(registry, "getDisabledMessagingChannelsFromEntry").mockReturnValue([]);
  const getBaselineExclusionsSpy = vi.spyOn(registry, "getBaselineExclusions").mockReturnValue([]);
  const getBaselineExclusionTransitionSpy = vi
    .spyOn(registry, "getBaselineExclusionTransition")
    .mockReturnValue(null);
  const getBaselineExclusionRuntimeStatusSpy = vi
    .spyOn(policy, "getBaselineExclusionRuntimeStatus")
    .mockReturnValue("excluded");
  const resolveOpenShellSpy = vi
    .spyOn(resolve, "resolveOpenshell")
    .mockReturnValue("/usr/bin/openshell");
  const resolveSandboxGatewayNameSpy = vi
    .spyOn(gatewayBinding, "resolveSandboxGatewayName")
    .mockReturnValue("nemoclaw-19080");
  vi.spyOn(gatewayBinding, "resolveGatewayName").mockReturnValue("nemoclaw-19080");
  vi.spyOn(dockerDriverPlatform, "isLinuxDockerDriverGatewayEnabled").mockReturnValue(true);
  const recoverNamedGatewayRuntimeSpy = vi
    .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
    .mockResolvedValue({
      before: { state: "healthy_named", status: "Status: Connected", gatewayInfo: "" },
      after: { state: "healthy_named", status: "Status: Connected", gatewayInfo: "" },
      recovered: false,
    });
  const getNamedGatewayLifecycleStateSpy = vi
    .spyOn(gatewayRuntime, "getNamedGatewayLifecycleState")
    .mockReturnValue({
      state: "healthy_named",
      status: "Status: Connected",
      gatewayInfo: "Gateway: nemoclaw-19080",
      activeGateway: "nemoclaw-19080",
    });
  const captureOpenShellSpy = vi
    .spyOn(runtime, "captureOpenshell")
    .mockImplementation((args: unknown) => {
      const argv = Array.isArray(args) ? args : [];
      if (argv[0] === "sandbox" && argv[1] === "list") {
        return { status: 0, output: "alpha Ready" };
      }
      if (argv[0] === "inference" && argv[1] === "get") {
        return { status: 0, output: `Provider: ${provider}\nModel: live-model\n` };
      }
      return { status: 0, output: "" };
    });
  const captureHostCommandSpy = vi
    .spyOn(doctorHostCommand, "captureHostCommand")
    .mockImplementation((command: unknown) => {
      if (command === "docker") return { status: 0, stdout: "25.0.0\n", stderr: "" };
      if (command === "curl") {
        return { status: 0, stdout: JSON.stringify({ models: [{ name: "m" }] }), stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
  const healthProbeSpy = vi.spyOn(health, "probeProviderHealth").mockReturnValue({
    ok: true,
    probed: true,
    providerLabel: "Ollama",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    detail: "healthy",
  });
  const probeSandboxInferenceGatewayHealthSpy = vi
    .spyOn(inferenceRouteHealth, "probeSandboxInferenceGatewayHealth")
    .mockResolvedValue({
      ok: false,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 0,
      detail: "Inference gateway unreachable inside the sandbox.",
    });
  const loadAgentSpy = vi.spyOn(agentDefs, "loadAgent").mockReturnValue({
    name: "openclaw",
    configPaths: { dir: "/sandbox/.openclaw", configFile: "openclaw.json", format: "json" },
  });
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "openclaw" });
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw");
  vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
    sandboxVersion: "0.1.0",
    expectedVersion: "0.2.0",
    isStale: true,
  });
  vi.spyOn(shields, "getShieldsPosture").mockReturnValue({
    mode: "temporarily_unlocked",
    detail: "temporarily unlocked for maintenance",
  });
  const inspectMutableConfigPermsSpy = vi
    .spyOn(shields, "inspectMutableConfigPerms")
    .mockReturnValue({
      applies: true,
      ok: true,
      dirMode: "2770",
      dirOwner: "sandbox:sandbox",
      fileMode: "660",
      fileOwner: "sandbox:sandbox",
      configDir: "/sandbox/.openclaw",
      configFile: "openclaw.json",
      issues: [],
    });
  const repairMutableConfigPermsSpy = vi
    .spyOn(shields, "repairMutableConfigPerms")
    .mockReturnValue({
      applied: true,
      verified: true,
      errors: [],
    });
  vi.spyOn(statusCommandDeps, "buildStatusCommandDeps").mockReturnValue({});
  vi.spyOn(tunnelServices, "readCloudflaredState").mockReturnValue({ kind: "running", pid: 1234 });
  const executeSandboxCommandForVerificationSpy = vi
    .spyOn(sandboxVerificationExec, "executeSandboxCommandForVerification")
    .mockReturnValue({
      status: 0,
      stdout: "ok",
      stderr: "",
    });
  const buildToolScopeChecksSpy = vi
    .spyOn(doctorToolScope, "buildToolScopeChecks")
    .mockReturnValue([
      {
        group: "Sandbox",
        label: "Tool scope approvals",
        status: "ok",
        detail: "no pending approvals",
      },
    ]);

  logSpy.mockClear();
  const runSandboxDoctor = requireDist(doctorModulePath).runSandboxDoctor;
  const existsSync = fs.existsSync.bind(fs);
  const cliBuildPath = [process.cwd(), "dist", "nemoclaw.js"].join(path.sep);
  vi.spyOn(fs, "existsSync").mockImplementation((candidate) =>
    typeof candidate === "string" && path.resolve(candidate) === cliBuildPath
      ? true
      : existsSync(candidate),
  );

  return {
    buildToolScopeChecksSpy,
    captureOpenShellSpy,
    captureHostCommandSpy,
    configuredMessagingChannelsSpy,
    executeSandboxCommandForVerificationSpy,
    getBaselineExclusionsSpy,
    getBaselineExclusionTransitionSpy,
    getBaselineExclusionRuntimeStatusSpy,
    getSandboxSpy,
    getNamedGatewayLifecycleStateSpy,
    healthProbeSpy,
    inspectMutableConfigPermsSpy,
    loadAgentSpy,
    probeSandboxInferenceGatewayHealthSpy,
    logSpy,
    recoverNamedGatewayRuntimeSpy,
    repairMutableConfigPermsSpy,
    resolveOpenShellSpy,
    resolveSandboxGatewayNameSpy,
    runSandboxDoctor,
    withMcpLifecycleLockSpy,
  };
}

describe("runSandboxDoctor flow", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireDist.resolve(doctorModulePath)];
  });

  it.each(["pending", "configuring", "active"] as const)(
    "reports Hermes portable receipt phase %s without Docker or OpenClaw doctor work (#9203)",
    testTimeoutOptions(30_000),
    async (phase) => {
      const harness = createDoctorHarness("ollama-local", {
        portableDisposition: hermesPortableDisposition(phase),
        registryEntry: phase === "pending" ? "missing" : "present",
        registryAgent: "hermes",
      });

      const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

      expect(report).toMatchObject({
        sandbox: "alpha",
        status: phase === "active" ? "ok" : "warn",
        checks: [
          {
            label: "Portable lifecycle",
            detail: `agent=Hermes; phase=${phase}`,
          },
        ],
      });
      expect(harness.captureOpenShellSpy).not.toHaveBeenCalled();
      expect(harness.captureHostCommandSpy).not.toHaveBeenCalled();
      expect(harness.recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
      expect(harness.executeSandboxCommandForVerificationSpy).not.toHaveBeenCalled();
      expect(harness.withMcpLifecycleLockSpy).toHaveBeenCalledWith("alpha", expect.any(Function));
    },
  );

  it("renders plain Hermes portable doctor output without recovery (#9203)", async () => {
    const harness = createDoctorHarness("ollama-local", {
      portableDisposition: hermesPortableDisposition("active"),
      registryAgent: "hermes",
    });

    await expect(harness.runSandboxDoctor("alpha")).resolves.toBeUndefined();

    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
      "Portable lifecycle: agent=Hermes; phase=active",
    );
    expect(harness.captureHostCommandSpy).not.toHaveBeenCalled();
    expect(harness.recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
  });

  it("releases the lifecycle lock before a failing doctor report exits (#9203)", async () => {
    const events: string[] = [];
    const harness = createDoctorHarness("ollama-local", {
      withMcpLifecycleLock: async (_sandboxName, operation) => {
        events.push("lock-enter");
        try {
          return await operation();
        } finally {
          events.push("lock-exit");
        }
      },
    });
    exitSpy.mockImplementationOnce(((code?: number) => {
      events.push(`exit-${String(code)}`);
      throw new Error(`process.exit(${String(code)})`);
    }) as never);

    await expect(harness.runSandboxDoctor("alpha")).rejects.toThrow("process.exit(1)");
    expect(events).toEqual(["lock-enter", "lock-exit", "exit-1"]);
  });

  it("rejects malformed portable receipt authority before doctor probes (#9203)", async () => {
    const harness = createDoctorHarness("ollama-local", {
      portableDisposition: new Error("invalid portable lifecycle receipt"),
    });

    await expect(
      harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true }),
    ).rejects.toThrow("invalid portable lifecycle receipt");
    expect(harness.captureOpenShellSpy).not.toHaveBeenCalled();
    expect(harness.captureHostCommandSpy).not.toHaveBeenCalled();
  });

  it.each([
    { field: "gatewayName", value: "other-gateway" },
    { field: "lifecycleGeneration", value: "other-generation" },
    { field: "lifecycleLiveIdentityFingerprint", value: "other-fingerprint" },
  ] as const)("rejects Hermes portable registry disagreement in $field (#9203)", async (drift) => {
    const harness = createDoctorHarness("ollama-local", {
      portableDisposition: hermesPortableDisposition("active"),
      registryAgent: "hermes",
      registryOverrides: { [drift.field]: drift.value },
    });

    await expect(
      harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true }),
    ).rejects.toThrow("receipt and registry authority disagree");
    expect(harness.captureOpenShellSpy).not.toHaveBeenCalled();
    expect(harness.captureHostCommandSpy).not.toHaveBeenCalled();
  });

  it("rejects an active Hermes receipt with no registry row (#9203)", async () => {
    const harness = createDoctorHarness("ollama-local", {
      portableDisposition: hermesPortableDisposition("active"),
      registryEntry: "missing",
    });

    await expect(
      harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true }),
    ).rejects.toThrow("missing its registry authority");
    expect(harness.captureOpenShellSpy).not.toHaveBeenCalled();
    expect(harness.captureHostCommandSpy).not.toHaveBeenCalled();
  });

  it("preserves schema-4 OpenClaw doctor behavior under the lifecycle fence (#9203)", async () => {
    const harness = createDoctorHarness("ollama-local", {
      portableDisposition: { kind: "openclaw" },
    });

    await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(harness.captureOpenShellSpy).toHaveBeenCalled();
    expect(harness.captureHostCommandSpy).toHaveBeenCalled();
    expect(harness.withMcpLifecycleLockSpy).toHaveBeenCalledWith("alpha", expect.any(Function));
  });

  it("classifies publication while waiting for the doctor lifecycle fence (#9203)", async () => {
    let disposition: PortableAgentReceiptDisposition = { kind: "absent" };
    const harness = createDoctorHarness("ollama-local", {
      portableDisposition: () => disposition,
      registryAgent: "hermes",
      withMcpLifecycleLock: async (_sandboxName, operation) => {
        disposition = hermesPortableDisposition("active");
        return await operation();
      },
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toEqual([
      expect.objectContaining({ detail: "agent=Hermes; phase=active" }),
    ]);
    expect(harness.captureOpenShellSpy).not.toHaveBeenCalled();
    expect(harness.captureHostCommandSpy).not.toHaveBeenCalled();
  });

  it(
    "builds a JSON report with host, gateway, sandbox, inference, messaging, and local-service checks",
    testTimeoutOptions(30_000),
    async () => {
      const harness = createDoctorHarness();

      const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

      expect(report).toMatchObject({
        schemaVersion: 1,
        sandbox: "alpha",
        status: "fail",
      });
      expect(report?.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ group: "Host", label: "Docker daemon", status: "ok" }),
          expect.objectContaining({ group: "Gateway", label: "OpenShell status", status: "ok" }),
          expect.objectContaining({ group: "Sandbox", label: "Live sandbox", status: "ok" }),
          expect.objectContaining({
            group: "Inference",
            label: "Provider health (upstream)",
            status: "ok",
          }),
          expect.objectContaining({
            group: "Inference",
            label: "Inference route (gateway)",
            status: "fail",
          }),
          expect.objectContaining({
            group: "Sandbox",
            label: "Lifecycle registration",
            status: "ok",
          }),
          expect.objectContaining({ group: "Messaging", label: "Channels", status: "info" }),
          expect.objectContaining({ group: "Local services", label: "Ollama", status: "ok" }),
          expect.objectContaining({
            group: "Local services",
            label: "cloudflared",
            status: "ok",
          }),
        ]),
      );
      expect(exitSpy).not.toHaveBeenCalled();
      expect(harness.logSpy).not.toHaveBeenCalled();
    },
  );

  it("fails the JSON host check for an unknown durable runtime provider", async () => {
    const harness = createDoctorHarness();
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "unknown-runtime",
      openshellVersion: "0.0.72",
      nemoclawVersion: "0.0.83",
      fromDockerfile: null,
      dashboardPort: 18789,
      imageTag: "nemoclaw-openclaw:test",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toContainEqual({
      group: "Host",
      label: "Runtime provider",
      status: "fail",
      detail: "Runtime provider 'unknown-runtime' is not registered for this operation.",
      hint: "restore a supported durable runtime provider identity before retrying",
    });
  });

  it.each([
    ["high", "high"],
    [null, "endpoint-default"],
  ] as const)(
    "reports effective reasoning effort in doctor JSON (%s) (#7659)",
    async (stored, expected) => {
      const harness = createDoctorHarness("compatible-endpoint");
      harness.getSandboxSpy.mockReturnValue({
        name: "alpha",
        agent: "openclaw",
        model: "registry-model",
        provider: "compatible-endpoint",
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoningEffort: stored,
        openshellDriver: "docker",
        openshellVersion: "0.0.72",
        nemoclawVersion: "0.0.83",
        fromDockerfile: null,
        dashboardPort: 18789,
        imageTag: "nemoclaw-openclaw:test",
        gatewayName: "nemoclaw-19080",
        gatewayPort: 19080,
      });

      const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

      expect(report?.checks).toContainEqual({
        group: "Inference",
        label: "Reasoning effort",
        status: "info",
        detail: expected,
      });
    },
  );

  it(
    "reports baseline exclusions and flags content drift since approval (#7194)",
    testTimeoutOptions(30_000),
    async () => {
      const harness = createDoctorHarness();
      harness.getBaselineExclusionsSpy.mockReturnValue([
        {
          version: 1,
          agent: "openclaw",
          key: "nous_research",
          digest: "digest-1",
          acknowledgedAt: "2026-07-19T00:00:00.000Z",
        },
        {
          version: 1,
          agent: "openclaw",
          key: "changed_entry",
          digest: "digest-stale",
          acknowledgedAt: "2026-07-18T00:00:00.000Z",
        },
        {
          version: 1,
          agent: "openclaw",
          key: "dropped_entry",
          digest: "digest-2",
          acknowledgedAt: "2026-07-17T00:00:00.000Z",
        },
      ]);
      const statuses: Record<string, "excluded" | "content-changed" | "no-longer-in-baseline"> = {
        nous_research: "excluded",
        changed_entry: "content-changed",
        dropped_entry: "no-longer-in-baseline",
      };
      harness.getBaselineExclusionRuntimeStatusSpy.mockImplementation(
        (_sandbox, entry) => statuses[entry.key],
      );

      const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

      expect(report?.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            group: "Sandbox",
            label: "Baseline exclusion: nous_research",
            status: "info",
          }),
          expect.objectContaining({
            group: "Sandbox",
            label: "Baseline exclusion: changed_entry",
            status: "warn",
            hint: expect.stringContaining("policy restore changed_entry"),
          }),
          expect.objectContaining({
            group: "Sandbox",
            label: "Baseline exclusion: dropped_entry",
            status: "warn",
            detail:
              "Baseline entry 'dropped_entry' no longer exists; rebuild fails closed until the stale exclusion is cleared.",
            hint: "key no longer exists in the baseline; run `nemoclaw alpha policy restore dropped_entry` to clear the stale record",
          }),
        ]),
      );
    },
  );

  it("fails when registry intent is not enforced by the live policy (#7194)", async () => {
    const harness = createDoctorHarness();
    harness.getBaselineExclusionsSpy.mockReturnValue([
      {
        version: 1,
        agent: "hermes",
        key: "pypi",
        digest: "a".repeat(64),
      },
    ]);
    harness.getBaselineExclusionRuntimeStatusSpy.mockReturnValue("live-policy-mismatch");

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toContainEqual(
      expect.objectContaining({
        label: "Baseline exclusion: pypi",
        status: "fail",
        detail: expect.stringContaining("not enforced"),
      }),
    );
  });

  it("flags an interrupted baseline transaction as a rebuild-blocking repair (#7178)", async () => {
    const harness = createDoctorHarness();
    harness.getBaselineExclusionTransitionSpy.mockReturnValue({
      id: "tx-1",
      operation: "restore",
      exclusion: { version: 1, agent: "openclaw", key: "nous_research", digest: "approved" },
      targetLiveDigest: "current",
      startedAt: "2026-07-19T00:00:00.000Z",
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "Sandbox",
          label: "Baseline exclusion: nous_research",
          status: "warn",
          detail: expect.stringContaining("interrupted"),
          hint: "re-run `nemoclaw alpha policy restore nous_research`",
        }),
      ]),
    );
  });

  it("keeps repair guidance visible when another exclusion baseline is unreadable (#7194)", async () => {
    const harness = createDoctorHarness();
    harness.getBaselineExclusionsSpy.mockReturnValue([
      { version: 1, agent: "openclaw", key: "another_entry", digest: "c".repeat(64) },
      { version: 1, agent: "openclaw", key: "nous_research", digest: "a".repeat(64) },
    ]);
    harness.getBaselineExclusionTransitionSpy.mockReturnValue({
      id: "0b2f3297-a9ab-4c2f-80da-bf1760a1afbf",
      operation: "restore",
      exclusion: { version: 1, agent: "openclaw", key: "nous_research", digest: "a".repeat(64) },
      targetLiveDigest: "b".repeat(64),
      startedAt: "2026-07-19T00:00:00.000Z",
    });
    harness.getBaselineExclusionRuntimeStatusSpy.mockReturnValue("baseline-unreadable");

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Baseline exclusion: another_entry",
          status: "warn",
          detail: expect.stringContaining("unreadable"),
        }),
        expect.objectContaining({
          label: "Baseline exclusion: nous_research",
          status: "warn",
          detail: expect.stringContaining("interrupted"),
        }),
      ]),
    );
  });

  it.each(["openclaw", "hermes"] as const)(
    "keeps serving-process health explicitly unchecked for the %s gateway (#7003)",
    async (agent) => {
      const harness = createDoctorHarness();
      harness.loadAgentSpy.mockReturnValue({
        name: agent,
        runtime: { kind: "gateway" },
        configPaths: {
          dir: "/sandbox/.agent",
          configFile: "config.json",
          format: "json",
        },
      });
      harness.getSandboxSpy.mockReturnValue({
        name: "alpha",
        agent,
        model: "registry-model",
        provider: "ollama-local",
        openshellDriver: "docker",
        openshellVersion: "0.0.72",
        nemoclawVersion: "0.0.83",
        fromDockerfile: null,
        dashboardPort: 18789,
        imageTag: "nemoclaw-openclaw:test",
        gatewayName: "nemoclaw-19080",
        gatewayPort: 19080,
      });

      const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

      expect(harness.loadAgentSpy).toHaveBeenCalledWith(agent);
      expect(report?.checks).toContainEqual(
        expect.objectContaining({
          group: "Inference",
          label: "Serving process",
          status: "info",
          detail: "not checked — serving-process probing is not implemented",
        }),
      );
    },
  );

  it("rejects mutating --fix when JSON output was requested", async () => {
    const harness = createDoctorHarness();

    await expect(harness.runSandboxDoctor("alpha", ["--json", "--fix"])).rejects.toThrow(
      "process.exit(1)",
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(harness.getSandboxSpy).not.toHaveBeenCalled();
    expect(harness.captureHostCommandSpy).not.toHaveBeenCalled();
    expect(harness.repairMutableConfigPermsSpy).not.toHaveBeenCalled();
  });

  it("does not run live or tool-scope probes when OpenShell is unavailable", async () => {
    const harness = createDoctorHarness();
    harness.resolveOpenShellSpy.mockReturnValue(null);

    await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(harness.recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
    expect(harness.captureOpenShellSpy).not.toHaveBeenCalled();
    expect(harness.buildToolScopeChecksSpy).not.toHaveBeenCalled();
    expect(harness.probeSandboxInferenceGatewayHealthSpy).not.toHaveBeenCalled();
  });

  it("does not run live or tool-scope probes when the named gateway is disconnected", async () => {
    const harness = createDoctorHarness();
    harness.configuredMessagingChannelsSpy.mockReturnValue(["telegram"]);
    harness.getNamedGatewayLifecycleStateSpy.mockReturnValue({
      state: "missing_named",
      status: "Status: Disconnected",
      gatewayInfo: "",
      activeGateway: null,
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(harness.captureOpenShellSpy).not.toHaveBeenCalled();
    expect(harness.buildToolScopeChecksSpy).not.toHaveBeenCalled();
    expect(harness.probeSandboxInferenceGatewayHealthSpy).not.toHaveBeenCalled();
    expect(harness.executeSandboxCommandForVerificationSpy).not.toHaveBeenCalled();
    expect(report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "Inference",
          label: "Inference route (gateway)",
          status: "info",
          detail: "skipped because the sandbox is not reachable through its named gateway",
        }),
        expect.objectContaining({
          group: "Messaging",
          label: "Runtime channel registry",
          status: "info",
          detail: "skipped because the sandbox is not reachable through its named gateway",
        }),
      ]),
    );
  });

  it("reports incomplete lifecycle registration even when runtime health is otherwise readable", async () => {
    const harness = createDoctorHarness();
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      model: "registry-model",
      provider: "ollama-local",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toContainEqual(
      expect.objectContaining({
        group: "Sandbox",
        label: "Lifecycle registration",
        status: "warn",
        detail: expect.stringContaining("openshellDriver"),
        hint: expect.stringContaining("re-register or re-onboard"),
      }),
    );
  });

  it("reports null image metadata in JSON lifecycle diagnostics", async () => {
    const harness = createDoctorHarness();
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "docker",
      openshellVersion: "0.0.72",
      nemoclawVersion: "0.0.83",
      fromDockerfile: null,
      dashboardPort: 18789,
      imageTag: null,
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toContainEqual(
      expect.objectContaining({
        group: "Sandbox",
        label: "Lifecycle registration",
        status: "warn",
        detail: expect.stringContaining("invalid imageTag"),
      }),
    );
    expect(
      report?.checks.find(
        (check) => check.group === "Sandbox" && check.label === "Lifecycle registration",
      )?.detail,
    ).toContain("snapshot");
  });

  it("reports an invalid stored gateway binding without running live probes", async () => {
    const harness = createDoctorHarness();
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "docker",
      openshellVersion: "0.0.72",
      nemoclawVersion: "0.0.83",
      fromDockerfile: null,
      dashboardPort: 18789,
      imageTag: "nemoclaw-openclaw:test",
      gatewayName: "nemoclaw-100000",
      gatewayPort: 100_000,
    });
    harness.resolveSandboxGatewayNameSpy.mockImplementation(() => {
      throw new Error("Invalid persisted sandbox gateway binding");
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "Gateway",
          label: "Registered gateway binding",
          status: "fail",
        }),
        expect.objectContaining({
          group: "Sandbox",
          label: "Lifecycle registration",
          status: "warn",
          detail: expect.stringContaining("invalid gatewayPort"),
        }),
      ]),
    );
    expect(harness.getNamedGatewayLifecycleStateSpy).not.toHaveBeenCalled();
    expect(harness.recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
    expect(harness.captureOpenShellSpy).not.toHaveBeenCalled();
  });

  it("keeps JSON gateway diagnostics read-only", async () => {
    const harness = createDoctorHarness();

    await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(harness.getNamedGatewayLifecycleStateSpy).toHaveBeenCalledWith("nemoclaw-19080");
    expect(harness.recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
  });

  it("runs live probes only after plain doctor recovers the named gateway", async () => {
    const harness = createDoctorHarness();
    harness.configuredMessagingChannelsSpy.mockReturnValue(["telegram"]);
    harness.recoverNamedGatewayRuntimeSpy.mockResolvedValue({
      before: {
        state: "missing_named",
        status: "Status: Disconnected",
        gatewayInfo: "",
      },
      after: {
        state: "healthy_named",
        status: "Status: Connected",
        gatewayInfo: "Gateway: nemoclaw-19080",
      },
      recovered: true,
    });
    harness.probeSandboxInferenceGatewayHealthSpy.mockResolvedValue({
      ok: true,
      endpoint: "http://127.0.0.1:19000/v1/chat/completions",
      httpStatus: 200,
      detail: "healthy",
    });

    await harness.runSandboxDoctor("alpha");

    expect(harness.recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-19080",
    });
    expect(harness.captureOpenShellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw-19080"],
      expect.any(Object),
    );
    expect(harness.probeSandboxInferenceGatewayHealthSpy).toHaveBeenCalledWith("alpha");
    expect(harness.executeSandboxCommandForVerificationSpy).toHaveBeenCalled();
    expect(harness.buildToolScopeChecksSpy).toHaveBeenCalledWith(
      "alpha",
      "nemoclaw",
      false,
      expect.any(Object),
    );
    expect(harness.recoverNamedGatewayRuntimeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.captureOpenShellSpy.mock.invocationCallOrder[0],
    );
  });

  it("does not enable repairs for plain or JSON diagnostics", async () => {
    const harness = createDoctorHarness();
    harness.inspectMutableConfigPermsSpy.mockReturnValue({
      applies: true,
      ok: false,
      dirMode: "700",
      dirOwner: "sandbox:sandbox",
      fileMode: "600",
      fileOwner: "sandbox:sandbox",
      configDir: "/sandbox/.openclaw",
      configFile: "openclaw.json",
      issues: ["directory mode is 700"],
    });
    const inferenceRouteHealth = requireDist("./inference-route-health.js");
    vi.mocked(inferenceRouteHealth.probeSandboxInferenceGatewayHealth).mockResolvedValue({
      ok: true,
      endpoint: "http://127.0.0.1:19000/v1/chat/completions",
      httpStatus: 200,
      detail: "healthy",
    });

    await harness.runSandboxDoctor("alpha");
    await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(harness.repairMutableConfigPermsSpy).not.toHaveBeenCalled();
    expect(harness.buildToolScopeChecksSpy).toHaveBeenCalledTimes(2);
    expect(harness.buildToolScopeChecksSpy.mock.calls.map((call) => call[2])).toEqual([
      false,
      false,
    ]);
  });

  it("skips gateway-specific and OpenClaw checks for terminal agents", async () => {
    const harness = createDoctorHarness();
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "docker",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });
    harness.loadAgentSpy.mockReturnValue({
      name: "langchain-deepagents-code",
      runtime: { kind: "terminal", interactive_command: "deepagents" },
      configPaths: {
        dir: "/sandbox/.deepagents",
        configFile: "config.json",
        format: "json",
      },
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(harness.buildToolScopeChecksSpy).not.toHaveBeenCalled();
    expect(report?.checks).not.toContainEqual(
      expect.objectContaining({ group: "Inference", label: "Serving process" }),
    );
    expect(report?.checks).not.toContainEqual(
      expect.objectContaining({
        group: "Sandbox",
        label: "Lifecycle registration",
        detail: expect.stringContaining("dashboardPort"),
      }),
    );
  });

  it("appends the local gateway result without mutating provider health", async () => {
    const harness = createDoctorHarness();
    const providerHealth = {
      ok: true,
      probed: true,
      providerLabel: "Ollama",
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      detail: "healthy",
    };
    harness.healthProbeSpy.mockReturnValue(providerHealth);

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(providerHealth).not.toHaveProperty("subprobes");
    expect(report?.checks).toContainEqual(
      expect.objectContaining({
        group: "Inference",
        label: "Inference route (gateway)",
      }),
    );
  });

  it("reports agent definition failures instead of hiding the runtime channel check", async () => {
    const harness = createDoctorHarness();
    harness.configuredMessagingChannelsSpy.mockReturnValue(["telegram"]);
    harness.loadAgentSpy.mockImplementation(() => {
      throw new Error("agent definition is invalid");
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toContainEqual(
      expect.objectContaining({
        group: "Messaging",
        label: "Runtime channel registry",
        status: "warn",
        detail: "unable to resolve agent config paths: agent definition is invalid",
      }),
    );
  });
});
