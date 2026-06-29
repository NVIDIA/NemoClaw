// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import {
  createDoctorHarness as createDoctorHarnessShared,
  type DoctorHarness,
} from "./__test-utils__/doctor-harness";

const requireDist = createRequire(import.meta.url);
const doctorModulePath = "./doctor.js";

function createDoctorHarness(): DoctorHarness {
  return createDoctorHarnessShared(requireDist);
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
