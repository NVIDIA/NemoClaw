// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { DCODE_MANAGED_EXEC_LAUNCHER } from "./connect-inference-route-probe";
import type { OpenShellSandboxBufferedCommandExecutor } from "../../adapters/openshell/sandbox-command";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
import {
  createBoundLaunchReadinessDeps,
  requireNativeInferenceHealth,
} from "./launch-readiness/health";
const ambient = vi.hoisted(() => ({ provider: vi.fn(), execute: vi.fn() }));
vi.mock("../../adapters/openshell/provider-command", async (original) => ({
  ...(await original<typeof import("../../adapters/openshell/provider-command")>()),
  runOpenshellProviderCommand: ambient.provider,
}));
vi.mock("../../adapters/sandbox/command-transport", async (original) => {
  const real = await original<typeof import("../../adapters/sandbox/command-transport")>();
  return {
    ...real,
    executeSandboxExecCommand: (...args: Parameters<typeof real.executeSandboxExecCommand>) =>
      args[3]?.commandExecutor ? real.executeSandboxExecCommand(...args) : ambient.execute(...args),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function fixture() {
  const f = registeredInferenceFixture(true);
  const responses: Record<string, string> = {
    "provider:get": [
      "Name: native-extra",
      "Id: operator-provider-id",
      "Type: operator-inference",
      "Resource version: 4",
      "Credential keys: VENDOR_API_KEY",
      "Config keys: <none>",
    ].join("\n"),
    "provider:profile": JSON.stringify(f.profile),
    "sandbox:provider":
      "NAME  TYPE  CREDENTIAL_KEYS  CONFIG_KEYS\nnative-extra  operator-inference  1  0\n",
  };
  const capture = vi.fn((args: string[]) => {
    const stdout =
      responses[`${args[0]}:${args[1]}`] ??
      (() => {
        throw new Error("Unexpected bound command: " + args.join(" "));
      })();
    return { status: 0, stdout, stderr: "", output: stdout };
  });
  const runBuffered = vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(async () => ({
    outcome: { kind: "completed" as const, exitCode: 0 },
    stdout: '__NEMOCLAW_SANDBOX_EXEC_STARTED__\n200\n{"choices":[{"message":{"content":"OK"}}]}',
    stderr: "",
  }));
  ambient.provider.mockReturnValue({
    status: 1,
    stdout: "",
    stderr: "wrong workspace",
    output: "wrong workspace",
  });
  ambient.execute.mockResolvedValue({ status: 1, stdout: "", stderr: "wrong workspace" });
  vi.stubEnv("OPENSHELL_WORKSPACE", "unrelated-workspace");
  const entry = {
    name: f.binding.sandboxName,
    gatewayName: f.binding.gatewayName,
    agent: "hermes",
    provider: f.binding.providerName,
    model: "vendor-model",
    endpointUrl: f.binding.endpointUrl,
    preferredInferenceApi: f.binding.inferenceApi,
    credentialEnv: f.binding.credentialEnv,
    registeredInferenceProviderAttachment: f.binding,
  };
  return {
    f,
    entry,
    capture,
    runBuffered,
    deps: createBoundLaunchReadinessDeps(capture, { runBuffered }),
  };
}
describe("receipt-bound native readiness observations", () => {
  it("verifies the registered provider through the bound gateway despite an unrelated ambient workspace", async () => {
    const f = fixture();
    await expect(
      requireNativeInferenceHealth({
        sandboxName: f.entry.name,
        gatewayName: f.entry.gatewayName,
        agentName: "hermes",
        entry: f.entry,
        deps: { ...f.deps, inferenceInvocationProbe: async () => ({ ok: true }) },
      }),
    ).resolves.toBe(true);
    expect(f.capture).toHaveBeenCalled();
    expect(ambient.provider).not.toHaveBeenCalled();
  });
  it.each([
    { agentName: "openclaw", marker: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\n", launcher: "/bin/bash" },
    { agentName: "hermes", marker: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\n", launcher: "/bin/bash" },
    { agentName: "langchain-deepagents-code", marker: "", launcher: DCODE_MANAGED_EXEC_LAUNCHER },
  ])(
    "sends the $agentName inference request through the bound sandbox executor despite an unrelated ambient workspace",
    async ({ agentName, marker, launcher }) => {
      const f = fixture();
      f.runBuffered.mockResolvedValue({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: marker + '200\n{"choices":[{"message":{"content":"OK"}}]}',
        stderr: "",
      });
      await expect(
        requireNativeInferenceHealth({
          sandboxName: f.entry.name,
          gatewayName: f.entry.gatewayName,
          agentName,
          entry: f.entry,
          deps: { ...f.deps, verifyRegisteredAttachment: async () => {} },
        }),
      ).resolves.toBe(true);
      expect(f.runBuffered).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxName: f.entry.name,
          target: { kind: "named", gatewayName: f.entry.gatewayName },
        }),
      );
      expect(ambient.execute).not.toHaveBeenCalled();
      expect(f.runBuffered.mock.calls[0][0]).not.toHaveProperty("environment");
      expect(f.runBuffered.mock.calls[0][0].command[0]).toBe(launcher);
    },
  );
  it("refuses an unverified provider without sending inference or using ambient transport", async () => {
    const f = fixture();
    f.capture.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "unavailable",
      output: "unavailable",
    });
    await expect(
      requireNativeInferenceHealth({
        sandboxName: f.entry.name,
        gatewayName: f.entry.gatewayName,
        agentName: "hermes",
        entry: f.entry,
        deps: f.deps,
      }),
    ).rejects.toThrow();
    expect(f.capture).toHaveBeenCalled();
    expect(f.runBuffered).not.toHaveBeenCalled();
    expect(ambient.provider).not.toHaveBeenCalled();
    expect(ambient.execute).not.toHaveBeenCalled();
  });
  it("keeps an inference refusal failed without falling back to ambient transport", async () => {
    const f = fixture();
    f.runBuffered.mockResolvedValue({
      outcome: { kind: "completed", exitCode: 1 },
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\n401\n",
      stderr: "",
    });
    await expect(
      requireNativeInferenceHealth({
        sandboxName: f.entry.name,
        gatewayName: f.entry.gatewayName,
        agentName: "hermes",
        entry: f.entry,
        deps: f.deps,
      }),
    ).rejects.toThrow("health");
    expect(f.runBuffered).toHaveBeenCalledTimes(1);
    expect(ambient.provider).not.toHaveBeenCalled();
    expect(ambient.execute).not.toHaveBeenCalled();
  });
});
