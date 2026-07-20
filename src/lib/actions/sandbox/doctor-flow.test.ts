// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";

type RunSandboxDoctor = typeof import("./doctor")["runSandboxDoctor"];

const requireDist = createRequire(import.meta.url);
const doctorModulePath = "./doctor.js";

function createDoctorHarness(): {
  buildToolScopeChecksSpy: MockInstance;
  captureOpenShellSpy: MockInstance;
  captureHostCommandSpy: MockInstance;
  configuredMessagingChannelsSpy: MockInstance;
  executeSandboxCommandForVerificationSpy: MockInstance;
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
  runSandboxDoctor: RunSandboxDoctor;
} {
  const provider = "ollama-local";
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
  const sandboxVerificationExec = requireDist("../../onboard/sandbox-verification-exec.js");
  const sandboxVersion = requireDist("../../sandbox/version.js");
  const shields = requireDist("../../shields/index.js");
  const registry = requireDist("../../state/registry.js");
  const statusCommandDeps = requireDist("../../status-command-deps.js");
  const tunnelServices = requireDist("../../tunnel/services.js");
  const doctorHostCommand = requireDist("./doctor-host-command.js");
  const doctorToolScope = requireDist("./doctor-tool-scope.js");
  const inferenceRouteHealth = requireDist("./inference-route-health.js");

  const getSandboxSpy = vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "alpha",
    agent: "openclaw",
    model: "registry-model",
    provider,
    openshellDriver: "docker",
    gatewayName: "nemoclaw-19080",
    gatewayPort: 19080,
    messaging: undefined,
  });
  const configuredMessagingChannelsSpy = vi
    .spyOn(registry, "getConfiguredMessagingChannelsFromEntry")
    .mockReturnValue([]);
  vi.spyOn(registry, "getDisabledMessagingChannelsFromEntry").mockReturnValue([]);
  const resolveOpenShellSpy = vi
    .spyOn(resolve, "resolveOpenshell")
    .mockReturnValue("/usr/bin/openshell");
  vi.spyOn(gatewayBinding, "resolveSandboxGatewayName").mockReturnValue("nemoclaw-19080");
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
    runSandboxDoctor,
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

  it.each([
    "openclaw",
    "hermes",
  ] as const)("keeps serving-process health explicitly unchecked for the %s gateway (#7003)", async (agent) => {
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
  });

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
      ["sandbox", "list"],
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
