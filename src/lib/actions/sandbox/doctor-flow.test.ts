// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import { compileTelegramPlanForTests } from "../../messaging/__test-utils__/telegram-plan";

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
    runSandboxDoctor: requireDist(doctorModulePath).runSandboxDoctor,
  };
}

type TelegramInputOverride = {
  inputId: string;
  value?: unknown;
};

function telegramDoctorPlan(options: {
  agent: "openclaw" | "hermes";
  inputs?: ReadonlyArray<TelegramInputOverride>;
}) {
  return {
    schemaVersion: 1 as const,
    sandboxName: "alpha",
    agent: options.agent,
    workflow: "onboard" as const,
    channels: [
      {
        channelId: "telegram",
        displayName: "telegram",
        authMode: "token-paste" as const,
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: (options.inputs ?? []).map((override) => ({
          channelId: "telegram",
          inputId: override.inputId,
          kind: "config" as const,
          required: false,
          ...(override.value === undefined ? {} : { value: override.value }),
        })),
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function mockTelegramDoctorRegistry(options: {
  agent: "openclaw" | "hermes";
  inputs?: ReadonlyArray<TelegramInputOverride>;
}): void {
  const registry = requireDist("../../state/registry.js");
  vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
  vi.spyOn(registry, "getDisabledMessagingChannelsFromEntry").mockReturnValue([]);
  vi.spyOn(registry, "getMessagingPlanFromEntry").mockReturnValue(telegramDoctorPlan(options));
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
          expect.objectContaining({ group: "Inference", label: "Provider health", status: "ok" }),
          expect.objectContaining({
            group: "Inference",
            label: "Provider health (gateway)",
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

  it("surfaces Telegram visible config inputs in the Messaging doctor section", async () => {
    const harness = createDoctorHarness();
    mockTelegramDoctorRegistry({
      agent: "openclaw",
      inputs: [{ inputId: "requireMention", value: "0" }],
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "Messaging",
          label: "Telegram group mention mode",
          status: "ok",
          detail: "all group messages (TELEGRAM_REQUIRE_MENTION=0)",
        }),
        expect.objectContaining({
          group: "Messaging",
          label: "Telegram group policy",
          status: "info",
          detail: "open (default)",
        }),
      ]),
    );
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");
    const sensitiveLabels = ["Bot Token", "User ID", "secret"];
    const leakedLabel = messagingChecks.find((check) =>
      sensitiveLabels.some((sensitive) =>
        check.label.toLowerCase().includes(sensitive.toLowerCase()),
      ),
    );
    expect(leakedLabel).toBeUndefined();
  });

  it("hides the OpenClaw-only Telegram group policy when the sandbox runs Hermes", async () => {
    const harness = createDoctorHarness();
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      agent: "hermes",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "docker",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      messaging: undefined,
    });
    mockTelegramDoctorRegistry({ agent: "hermes" });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");

    expect(messagingChecks.some((check) => check.label === "Telegram group policy")).toBe(false);
    expect(
      messagingChecks.find((check) => check.label === "Telegram group mention mode"),
    ).toMatchObject({ status: "info", detail: "mention-only (default)" });
  });

  it("falls back to OpenClaw visible config when a legacy SandboxEntry omits the agent field", async () => {
    const harness = createDoctorHarness();
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "docker",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      messaging: undefined,
    });
    mockTelegramDoctorRegistry({ agent: "openclaw" });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");

    expect(messagingChecks.find((check) => check.label === "Telegram group policy")).toMatchObject({
      status: "info",
      detail: "open (default)",
    });
    expect(
      messagingChecks.find((check) => check.label === "Telegram group mention mode"),
    ).toMatchObject({ status: "info", detail: "mention-only (default)" });
  });

  it("flags an invalid persisted Telegram group policy without echoing the raw value", async () => {
    const harness = createDoctorHarness();
    mockTelegramDoctorRegistry({
      agent: "openclaw",
      inputs: [{ inputId: "groupPolicy", value: "definitely-not-a-policy" }],
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const policyCheck = (report?.checks ?? []).find(
      (check) => check.group === "Messaging" && check.label === "Telegram group policy",
    );

    expect(policyCheck).toBeDefined();
    expect(policyCheck?.status).toBe("warn");
    expect(policyCheck?.detail).toMatch(
      /invalid persisted value \(expected: open \| allowlist \| disabled\)/,
    );
    expect(policyCheck?.detail).not.toContain("definitely-not-a-policy");
  });

  it("flags a present-but-empty Telegram mention-mode value as invalid rather than defaulting", async () => {
    const harness = createDoctorHarness();
    mockTelegramDoctorRegistry({
      agent: "openclaw",
      inputs: [{ inputId: "requireMention", value: "" }],
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const mentionCheck = (report?.checks ?? []).find(
      (check) => check.group === "Messaging" && check.label === "Telegram group mention mode",
    );

    expect(mentionCheck).toBeDefined();
    expect(mentionCheck?.status).toBe("warn");
    expect(mentionCheck?.detail).toMatch(/invalid persisted value/);
    expect(mentionCheck?.detail).not.toMatch(/default/);
  });

  it("surfaces Telegram visible config from a plan compiled out of process env through doctor", async () => {
    const harness = createDoctorHarness();
    const compiledPlan = await compileTelegramPlanForTests({
      envOverrides: { TELEGRAM_GROUP_POLICY: "allowlist" },
    });
    const registry = requireDist("../../state/registry.js");
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
    vi.spyOn(registry, "getDisabledMessagingChannelsFromEntry").mockReturnValue([]);
    vi.spyOn(registry, "getMessagingPlanFromEntry").mockReturnValue(compiledPlan);

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");

    expect(messagingChecks.find((check) => check.label === "Telegram group policy")).toMatchObject({
      status: "ok",
      detail: "allowlist",
    });
    expect(
      messagingChecks.find((check) => check.label === "Telegram group mention mode"),
    ).toMatchObject({
      status: "ok",
      detail: "mention-only (TELEGRAM_REQUIRE_MENTION=1)",
    });
  });

  it("reads Telegram visible config from a non-interactive compact registry entry through the real plan reader", async () => {
    const harness = createDoctorHarness();
    const registryMessaging = requireDist("../../state/registry-messaging.js");
    const realGetMessagingPlanFromEntry = registryMessaging.getMessagingPlanFromEntry;
    const compiledPlan = await compileTelegramPlanForTests({
      envOverrides: { TELEGRAM_GROUP_POLICY: "allowlist", TELEGRAM_REQUIRE_MENTION: "0" },
      isInteractive: false,
    });
    const onDisk = registryMessaging.serializeSandboxMessagingStateForDisk({
      schemaVersion: 1,
      plan: compiledPlan,
    });
    expect(onDisk).toBeDefined();
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "docker",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      messaging: onDisk,
    });
    const registry = requireDist("../../state/registry.js");
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
    vi.spyOn(registry, "getDisabledMessagingChannelsFromEntry").mockReturnValue([]);
    vi.spyOn(registry, "getMessagingPlanFromEntry").mockImplementation((entry) =>
      realGetMessagingPlanFromEntry(entry),
    );

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");

    expect(messagingChecks.find((check) => check.label === "Telegram group policy")).toMatchObject({
      status: "ok",
      detail: "allowlist",
    });
    expect(
      messagingChecks.find((check) => check.label === "Telegram group mention mode"),
    ).toMatchObject({
      status: "ok",
      detail: "all group messages (TELEGRAM_REQUIRE_MENTION=0)",
    });
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
          label: "Provider health (gateway)",
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
    const processRecovery = requireDist("./process-recovery.js");
    vi.mocked(processRecovery.probeSandboxInferenceGatewayHealth).mockResolvedValue({
      ok: true,
      endpoint: "http://127.0.0.1:19000/v1/chat/completions",
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

  it("skips OpenClaw tool-scope checks for other agents", async () => {
    const harness = createDoctorHarness();
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      agent: "hermes",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "docker",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });

    await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(harness.buildToolScopeChecksSpy).not.toHaveBeenCalled();
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
        label: "Provider health (gateway)",
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
