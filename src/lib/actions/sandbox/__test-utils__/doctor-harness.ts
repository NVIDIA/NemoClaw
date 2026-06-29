// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type MockInstance, vi } from "vitest";

import {
  mockTelegramDoctorRegistry as applyTelegramDoctorRegistryMocks,
  type ChannelInputOverride,
  type CompactTelegramEntryOptions,
  compactTelegramEntryFromEnv,
} from "./index";

type RunSandboxDoctor = typeof import("../doctor")["runSandboxDoctor"];

type DistRequire = (id: string) => any;

export interface DoctorHarness {
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
}

const DOCTOR_MODULE_PATH = "./doctor.js";

export function createDoctorHarness(
  requireDist: DistRequire & { resolve: (id: string) => string },
): DoctorHarness {
  delete require.cache[requireDist.resolve(DOCTOR_MODULE_PATH)];

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
  const processRecovery = requireDist("./process-recovery.js");

  const getSandboxSpy = vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "alpha",
    agent: "openclaw",
    model: "registry-model",
    provider: "ollama-local",
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
        return { status: 0, output: "Provider: ollama-local\nModel: live-model\n" };
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
    .spyOn(processRecovery, "probeSandboxInferenceGatewayHealth")
    .mockResolvedValue({
      ok: false,
      endpoint: "http://127.0.0.1:19000/v1/chat/completions",
      detail: "gateway refused connection",
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
    runSandboxDoctor: (requireDist(DOCTOR_MODULE_PATH) as { runSandboxDoctor: RunSandboxDoctor })
      .runSandboxDoctor,
  };
}

export function mockTelegramDoctorRegistryForHarness(
  requireDist: DistRequire,
  options: {
    agent: "openclaw" | "hermes";
    inputs?: ReadonlyArray<ChannelInputOverride>;
  },
): void {
  applyTelegramDoctorRegistryMocks(requireDist("../../state/registry.js"), options);
}

export async function setupDoctorRealPlanReader(
  requireDist: DistRequire,
  harness: { getSandboxSpy: MockInstance },
  options: CompactTelegramEntryOptions,
): Promise<void> {
  const { entry } = await compactTelegramEntryFromEnv(options);
  harness.getSandboxSpy.mockReturnValue({
    name: "alpha",
    agent: options.agentName ?? "openclaw",
    model: "registry-model",
    provider: "ollama-local",
    openshellDriver: "docker",
    gatewayName: "nemoclaw-19080",
    gatewayPort: 19080,
    messaging: (entry as { messaging: unknown }).messaging,
  });
  const registry = requireDist("../../state/registry.js");
  const registryMessaging = requireDist("../../state/registry-messaging.js");
  vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
  vi.spyOn(registry, "getDisabledMessagingChannelsFromEntry").mockReturnValue([]);
  vi.spyOn(registry, "getMessagingPlanFromEntry").mockImplementation((entry: unknown) =>
    registryMessaging.getMessagingPlanFromEntry(entry),
  );
}
