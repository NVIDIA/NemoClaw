// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
}));

vi.mock("../inference/local", () => ({
  DEFAULT_OLLAMA_MODEL: "llama3.1",
}));

import { runInferenceGet, type InferenceGetDeps } from "./inference-get";

function createDeps(
  output: string,
  status: number | null = 0,
): InferenceGetDeps & {
  log: ReturnType<typeof vi.fn>;
  captureOpenshell: ReturnType<typeof vi.fn>;
  getSandboxTargetGatewayName: ReturnType<typeof vi.fn>;
} {
  const captureOpenshell = vi.fn(() => ({ status, output }));
  const getSandboxTargetGatewayName = vi.fn(() => "nemoclaw");
  const log = vi.fn();
  return {
    captureOpenshell: captureOpenshell as unknown as InferenceGetDeps["captureOpenshell"] &
      ReturnType<typeof vi.fn>,
    getSandboxTargetGatewayName:
      getSandboxTargetGatewayName as unknown as InferenceGetDeps["getSandboxTargetGatewayName"] &
        ReturnType<typeof vi.fn>,
    log: log as unknown as InferenceGetDeps["log"] & ReturnType<typeof vi.fn>,
  };
}

describe("runInferenceGet", () => {
  it("prints the live provider and model", async () => {
    const deps = createDeps("Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/model\n");

    await expect(runInferenceGet({}, deps)).resolves.toEqual({
      provider: "nvidia-prod",
      model: "nvidia/model",
    });

    expect(deps.captureOpenshell).toHaveBeenCalledWith(
      ["inference", "get", "-g", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(deps.log.mock.calls.map(([line]) => line)).toEqual([
      "Provider: nvidia-prod",
      "Model:    nvidia/model",
    ]);
  });

  it("supports JSON output", async () => {
    const deps = createDeps("Gateway inference:\n  Provider: openai-api\n  Model: gpt-5.4\n");

    await runInferenceGet({ json: true }, deps);

    expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual({
      provider: "openai-api",
      model: "gpt-5.4",
    });
  });

  it("reports an attached llama.cpp endpoint for an aligned sandbox route", async () => {
    const deps = {
      ...createDeps("Gateway inference:\n  Provider: llama-cpp-local\n  Model: muse-glimmer\n"),
      getSandbox: () =>
        ({
          name: "llamacpp-env",
          provider: "llama-cpp-local",
          model: "muse-glimmer",
          endpointUrl: "http://127.0.0.1:8081/v1",
        }) as never,
    };

    await expect(runInferenceGet({ sandboxName: "llamacpp-env" }, deps)).resolves.toEqual({
      provider: "llama-cpp-local",
      model: "muse-glimmer",
      llamaCpp: { kind: "attached", endpointUrl: "http://127.0.0.1:8081/v1" },
    });
    expect(deps.log.mock.calls.map(([line]) => line)).toEqual([
      "Provider: llama-cpp-local",
      "Model:    muse-glimmer",
      "Llama.cpp: attached",
      "Endpoint:  http://127.0.0.1:8081/v1",
    ]);
  });

  it("reports unavailable managed ownership with safe recovery output", async () => {
    const deps = {
      ...createDeps("Gateway inference:\n  Provider: llama-cpp-local\n  Model: muse-glimmer\n"),
      getSandbox: () =>
        ({
          name: "llamacpp-env",
          provider: "llama-cpp-local",
          model: "muse-glimmer",
          endpointUrl: "http://127.0.0.1:8081/v1",
        }) as never,
      inspectManagedLlamaCppOwnership: () => "unknown" as const,
    };

    const result = await runInferenceGet({ sandboxName: "llamacpp-env" }, deps);

    expect(result.llamaCpp).toEqual({
      kind: "unavailable",
      diagnostic: "Managed llama.cpp ownership state is unavailable.",
      recovery: "Run nemoclaw doctor and correct the reported state before retrying.",
    });
    expect(deps.log.mock.calls.map(([line]) => line)).toContain(
      "Recovery:  Run nemoclaw doctor and correct the reported state before retrying.",
    );
    expect(JSON.stringify(result)).not.toContain("endpointUrl");
  });

  it("does not attribute a sandbox route when the gateway route drifted", async () => {
    const deps = {
      ...createDeps("Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/model\n"),
      getSandbox: () =>
        ({
          name: "llamacpp-env",
          provider: "llama-cpp-local",
          model: "muse-glimmer",
          endpointUrl: "http://127.0.0.1:8081/v1",
        }) as never,
    };

    await expect(runInferenceGet({ sandboxName: "llamacpp-env", quiet: true }, deps)).resolves.toEqual({
      provider: "nvidia-prod",
      model: "nvidia/model",
    });
  });

  it("queries the gateway recorded for the sandbox (#10671)", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    deps.getSandboxTargetGatewayName.mockReturnValue("nemoclaw-19090");

    await expect(runInferenceGet({ quiet: true, sandboxName: "beta" }, deps)).resolves.toEqual({
      provider: "compatible-endpoint",
      model: "custom/model",
    });

    expect(deps.getSandboxTargetGatewayName).toHaveBeenCalledWith("beta");
    expect(deps.captureOpenshell).toHaveBeenCalledWith(
      ["inference", "get", "-g", "nemoclaw-19090"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("sanitizes route values only for human-readable output", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: openai\u001b[2J\n  Model: gpt\u0007-5.4\r\n",
    );

    await expect(runInferenceGet({}, deps)).resolves.toEqual({
      provider: "openai\u001b[2J",
      model: "gpt\u0007-5.4",
    });

    expect(deps.log.mock.calls.map(([line]) => line)).toEqual([
      "Provider: openai[2J",
      "Model:    gpt-5.4",
    ]);
  });

  it("can return the route without rendering output for oclif JSON handling", async () => {
    const deps = createDeps("Gateway inference:\n  Provider: openai-api\n  Model: gpt-5.4\n");

    await expect(runInferenceGet({ quiet: true }, deps)).resolves.toEqual({
      provider: "openai-api",
      model: "gpt-5.4",
    });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("fails when no route is configured", async () => {
    const deps = createDeps("Gateway inference:\n\n  Not configured\n");
    deps.getSandboxTargetGatewayName.mockReturnValue("nemoclaw-19090");

    await expect(runInferenceGet({}, deps)).rejects.toThrow(
      "OpenShell inference route is not configured for gateway 'nemoclaw-19090'.",
    );
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("keeps the legacy unconfigured response in the route absence branch (#10671)", async () => {
    const deps = createDeps("Inference:\n\n  Not configured");

    await expect(runInferenceGet({}, deps)).rejects.toThrow(
      "OpenShell inference route is not configured for gateway 'nemoclaw'.",
    );
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("reports unrecognized gateway output without rendering it (#10671)", async () => {
    const deps = createDeps("Gateway inference:\n  Unexpected: secret output");
    deps.getSandboxTargetGatewayName.mockReturnValue("nemoclaw-19090");

    await expect(runInferenceGet({ sandboxName: "beta" }, deps)).rejects.toMatchObject({
      message:
        "OpenShell inference route lookup for gateway 'nemoclaw-19090' returned output NemoClaw could not interpret. Run 'nemoclaw beta status' to diagnose the sandbox's recorded gateway.",
    });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("reports a partial gateway route without rendering it (#10671)", async () => {
    const deps = createDeps("Gateway inference:\n  Provider: secret-partial-provider");
    deps.getSandboxTargetGatewayName.mockReturnValue("nemoclaw-19090");

    await expect(runInferenceGet({ sandboxName: "beta" }, deps)).rejects.toMatchObject({
      message:
        "OpenShell inference route lookup for gateway 'nemoclaw-19090' returned output NemoClaw could not interpret. Run 'nemoclaw beta status' to diagnose the sandbox's recorded gateway.",
    });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("reports the gateway and timeout without command output (#10671)", async () => {
    const deps = createDeps("", null);
    deps.getSandboxTargetGatewayName.mockReturnValue("nemoclaw-19090");
    deps.captureOpenshell.mockReturnValue({
      status: null,
      output: "secret stderr must not be rendered",
      error: Object.assign(new Error("secret timeout detail"), { code: "ETIMEDOUT" }),
      signal: "SIGKILL",
    });

    await expect(runInferenceGet({ sandboxName: "beta" }, deps)).rejects.toMatchObject({
      message:
        "OpenShell inference route lookup for gateway 'nemoclaw-19090' timed out. Run 'nemoclaw beta status' to diagnose the sandbox's recorded gateway.",
    });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("reports the gateway and exit status without command output (#10671)", async () => {
    const deps = createDeps("secret stderr must not be rendered", 7);
    deps.getSandboxTargetGatewayName.mockReturnValue("nemoclaw-19090");

    await expect(runInferenceGet({}, deps)).rejects.toMatchObject({
      message:
        "OpenShell inference route lookup for gateway 'nemoclaw-19090' failed with exit status 7. Run 'nemoclaw status' to diagnose the selected gateway.",
    });
    expect(deps.log).not.toHaveBeenCalled();
  });

  it("reports sandbox diagnosis guidance when a lookup has no exit status (#10671)", async () => {
    const deps = createDeps("", null);
    deps.getSandboxTargetGatewayName.mockReturnValue("nemoclaw-19090");
    deps.captureOpenshell.mockReturnValue({
      status: null,
      output: "secret stderr must not be rendered",
      error: new Error("secret execution detail"),
      signal: null,
    });

    await expect(runInferenceGet({ sandboxName: "beta" }, deps)).rejects.toMatchObject({
      message:
        "OpenShell inference route lookup for gateway 'nemoclaw-19090' failed before an exit status was available. Run 'nemoclaw beta status' to diagnose the sandbox's recorded gateway.",
    });
    expect(deps.log).not.toHaveBeenCalled();
  });
});
