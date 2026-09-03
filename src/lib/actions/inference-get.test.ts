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
  listSandboxes: ReturnType<typeof vi.fn>;
} {
  const captureOpenshell = vi.fn(() => ({ status, output }));
  const getSandboxTargetGatewayName = vi.fn(() => "nemoclaw");
  const listSandboxes = vi.fn(() => []);
  const log = vi.fn();
  return {
    captureOpenshell: captureOpenshell as unknown as InferenceGetDeps["captureOpenshell"] &
      ReturnType<typeof vi.fn>,
    getSandboxTargetGatewayName:
      getSandboxTargetGatewayName as unknown as InferenceGetDeps["getSandboxTargetGatewayName"] &
        ReturnType<typeof vi.fn>,
    listSandboxes: listSandboxes as unknown as InferenceGetDeps["listSandboxes"] &
      ReturnType<typeof vi.fn>,
    log: log as unknown as InferenceGetDeps["log"] & ReturnType<typeof vi.fn>,
  };
}

function recordRoute(
  deps: ReturnType<typeof createDeps>,
  route: { endpointUrl: string; model?: string; name?: string; provider: string },
): void {
  const name = route.name ?? "custom";
  deps.listSandboxes.mockReturnValue([
    {
      name,
      provider: route.provider,
      model: route.model ?? "custom/model",
      endpointUrl: route.endpointUrl,
    },
  ]);
}

const ENDPOINT_OMISSION_CASES = [
  {
    name: "conflicting same-gateway URLs",
    endpoints: ["https://inference-a.example.test/v1", "https://inference-b.example.test/v1"],
  },
  {
    name: "a non-HTTP URL",
    endpoints: ["ftp://inference.example.test/v1"],
  },
  {
    name: "a URL containing a control character",
    endpoints: ["https://inference.example.test/v1\u0007"],
  },
];

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

  it("prints the persisted compatible endpoint in human-readable output (#10784)", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    recordRoute(deps, {
      provider: "compatible-endpoint",
      endpointUrl: "https://inference.example.test/v1",
    });

    await expect(runInferenceGet({ sandboxName: "custom" }, deps)).resolves.toEqual({
      provider: "compatible-endpoint",
      model: "custom/model",
      endpointUrl: "https://inference.example.test/v1",
    });
    expect(deps.log.mock.calls.map(([line]) => line)).toEqual([
      "Provider: compatible-endpoint",
      "Model:    custom/model",
      "Endpoint: https://inference.example.test/v1",
    ]);
  });

  it.each([
    { label: "direct lookup with a stale model", sandboxName: undefined, persistedModel: "stale/model" },
    { label: "sandbox lookup with a stale model", sandboxName: "custom", persistedModel: "stale/model" },
    { label: "direct lookup with missing model metadata", sandboxName: undefined },
  ])("omits a persisted endpoint for $label (#10784)", async ({ sandboxName, persistedModel }) => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: live/model\n",
    );
    deps.listSandboxes.mockReturnValue([
      {
        name: "custom",
        provider: "compatible-endpoint",
        ...(persistedModel === undefined ? {} : { model: persistedModel }),
        endpointUrl: "https://stale.example.test/v1",
      },
    ]);

    await expect(runInferenceGet({ json: true, sandboxName }, deps)).resolves.toEqual({
      provider: "compatible-endpoint",
      model: "live/model",
    });
    expect(deps.log.mock.calls[0][0]).not.toContain("stale.example.test");
  });

  it.each(["compatible-endpoint", "compatible-anthropic-endpoint"])(
    "includes the persisted endpoint in JSON output for %s (#10784)",
    async (provider) => {
      const deps = createDeps(
        `Gateway inference:\n  Provider: ${provider}\n  Model: custom/model\n`,
      );
      recordRoute(deps, {
        provider,
        endpointUrl: "https://inference.example.test/v1",
      });

      await runInferenceGet({ json: true }, deps);

      expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual({
        provider,
        model: "custom/model",
        endpointUrl: "https://inference.example.test/v1",
      });
    },
  );

  it("omits a persisted endpoint for a managed provider (#10784)", async () => {
    const deps = createDeps("Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/model\n");
    recordRoute(deps, {
      name: "managed",
      provider: "nvidia-prod",
      model: "nvidia/model",
      endpointUrl: "https://managed.example.test/v1",
    });

    await expect(runInferenceGet({ json: true }, deps)).resolves.toEqual({
      provider: "nvidia-prod",
      model: "nvidia/model",
    });
    expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual({
      provider: "nvidia-prod",
      model: "nvidia/model",
    });
    expect(deps.listSandboxes).not.toHaveBeenCalled();
  });

  it("omits a credential-bearing compatible endpoint (#10784)", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    recordRoute(deps, {
      provider: "compatible-endpoint",
      endpointUrl: "https://operator:secret@inference.example.test/v1?token=secret",
    });

    await expect(runInferenceGet({ json: true, sandboxName: "custom" }, deps)).resolves.toEqual({
      provider: "compatible-endpoint",
      model: "custom/model",
    });
    expect(deps.log.mock.calls[0][0]).not.toContain("secret");
    expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual({
      provider: "compatible-endpoint",
      model: "custom/model",
    });
  });

  it.each(ENDPOINT_OMISSION_CASES)(
    "omits $name from human-readable output",
    async ({ endpoints }) => {
      const deps = createDeps(
        "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
      );
      deps.listSandboxes.mockReturnValue(
        endpoints.map((endpointUrl, index) => ({
          name: `custom-${String(index + 1)}`,
          provider: "compatible-endpoint",
          model: "custom/model",
          endpointUrl,
        })),
      );

      await expect(runInferenceGet({}, deps)).resolves.toEqual({
        provider: "compatible-endpoint",
        model: "custom/model",
      });
      expect(deps.log.mock.calls.map(([line]) => line)).toEqual([
        "Provider: compatible-endpoint",
        "Model:    custom/model",
      ]);
      const output = deps.log.mock.calls.flat().join("\n");
      expect(output).not.toContain(endpoints[0]);
      expect(output).not.toContain(endpoints[1] ?? endpoints[0]);
    },
  );

  it.each(ENDPOINT_OMISSION_CASES)("omits $name from JSON output", async ({ endpoints }) => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    deps.listSandboxes.mockReturnValue(
      endpoints.map((endpointUrl, index) => ({
        name: `custom-${String(index + 1)}`,
        provider: "compatible-endpoint",
        model: "custom/model",
        endpointUrl,
      })),
    );

    const expected = {
      provider: "compatible-endpoint",
      model: "custom/model",
    };
    await expect(runInferenceGet({ json: true }, deps)).resolves.toEqual(expected);
    expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual(expected);
    expect(deps.log.mock.calls[0][0]).not.toContain(endpoints[0]);
    expect(deps.log.mock.calls[0][0]).not.toContain(endpoints[1] ?? endpoints[0]);
  });

  function recordGatewayRoutes(deps: ReturnType<typeof createDeps>): void {
    deps.getSandboxTargetGatewayName.mockReturnValue("nemoclaw-19090");
    deps.listSandboxes.mockReturnValue([
      {
        name: "selected-gateway",
        provider: "compatible-endpoint",
        model: "custom/model",
        endpointUrl: "https://selected.example.test/v1",
        gatewayName: "nemoclaw-19090",
        gatewayPort: 19090,
      },
      {
        name: "other-gateway",
        provider: "compatible-endpoint",
        model: "custom/model",
        endpointUrl: "https://other.example.test/v1",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      },
    ]);
  }

  function recordEquivalentEndpointRoutes(deps: ReturnType<typeof createDeps>): void {
    deps.listSandboxes.mockReturnValue([
      {
        name: "custom-a",
        provider: "compatible-endpoint",
        model: "custom/model",
        endpointUrl: "https://inference.example.test/v1",
      },
      {
        name: "custom-b",
        provider: "compatible-endpoint",
        model: "custom/model",
        endpointUrl: "https://inference.example.test/v1/",
      },
    ]);
  }

  it("reports only the selected non-default gateway endpoint in human-readable output (#10784)", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    recordGatewayRoutes(deps);

    await expect(runInferenceGet({}, deps)).resolves.toEqual({
      provider: "compatible-endpoint",
      model: "custom/model",
      endpointUrl: "https://selected.example.test/v1",
    });
    expect(deps.log.mock.calls.map(([line]) => line)).toEqual([
      "Provider: compatible-endpoint",
      "Model:    custom/model",
      "Endpoint: https://selected.example.test/v1",
    ]);
    expect(deps.log.mock.calls.flat().join("\n")).not.toContain("other.example.test");
  });

  it("reports only the selected non-default gateway endpoint in JSON output (#10784)", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    recordGatewayRoutes(deps);

    const expected = {
      provider: "compatible-endpoint",
      model: "custom/model",
      endpointUrl: "https://selected.example.test/v1",
    };
    await expect(runInferenceGet({ json: true }, deps)).resolves.toEqual(expected);
    expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual(expected);
    expect(deps.log.mock.calls[0][0]).not.toContain("other.example.test");
  });

  it("treats trailing-slash variants as one endpoint in human-readable output (#10784)", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    recordEquivalentEndpointRoutes(deps);

    await expect(runInferenceGet({}, deps)).resolves.toEqual({
      provider: "compatible-endpoint",
      model: "custom/model",
      endpointUrl: "https://inference.example.test/v1",
    });
    expect(deps.log.mock.calls.map(([line]) => line)).toEqual([
      "Provider: compatible-endpoint",
      "Model:    custom/model",
      "Endpoint: https://inference.example.test/v1",
    ]);
  });

  it("treats trailing-slash variants as one endpoint in JSON output (#10784)", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    recordEquivalentEndpointRoutes(deps);

    const expected = {
      provider: "compatible-endpoint",
      model: "custom/model",
      endpointUrl: "https://inference.example.test/v1",
    };
    await expect(runInferenceGet({ json: true }, deps)).resolves.toEqual(expected);
    expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual(expected);
  });

  it("omits an endpoint longer than the canonical endpoint boundary", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    recordRoute(deps, {
      provider: "compatible-endpoint",
      endpointUrl: `https://inference.example.test/${"a".repeat(2048)}`,
    });

    await expect(runInferenceGet({ json: true }, deps)).resolves.toEqual({
      provider: "compatible-endpoint",
      model: "custom/model",
    });
    expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual({
      provider: "compatible-endpoint",
      model: "custom/model",
    });
  });

  it("ignores a pending route reservation when selecting the endpoint (#10784)", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    deps.listSandboxes.mockReturnValue([
      {
        name: "published",
        provider: "compatible-endpoint",
        model: "custom/model",
        endpointUrl: "https://published.example.test/v1",
      },
      {
        name: "pending-create",
        provider: "compatible-endpoint",
        model: "custom/model",
        endpointUrl: "https://unpublished.example.test/v1",
        pendingRouteReservation: true,
      },
    ]);

    await expect(runInferenceGet({ json: true }, deps)).resolves.toEqual({
      provider: "compatible-endpoint",
      model: "custom/model",
      endpointUrl: "https://published.example.test/v1",
    });
    expect(deps.log.mock.calls[0][0]).not.toContain("unpublished.example.test");
  });

  it("omits an endpoint from an invalid persisted gateway binding", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    deps.listSandboxes.mockReturnValue([
      {
        name: "broken-binding",
        provider: "compatible-endpoint",
        model: "custom/model",
        endpointUrl: "https://inference.example.test/v1",
        gatewayName: "secret-invalid-gateway",
        gatewayPort: null,
      },
    ]);
    await expect(runInferenceGet({ json: true }, deps)).resolves.toEqual({
      provider: "compatible-endpoint",
      model: "custom/model",
    });
    expect(deps.log.mock.calls[0][0]).not.toContain("secret-invalid-gateway");
    expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual({
      provider: "compatible-endpoint",
      model: "custom/model",
    });
  });

  it("fails closed without exposing registry-read details for a compatible route", async () => {
    const deps = createDeps(
      "Gateway inference:\n  Provider: compatible-endpoint\n  Model: custom/model\n",
    );
    deps.getSandboxTargetGatewayName.mockReturnValue("nemoclaw-19090");
    deps.listSandboxes.mockImplementation(() => {
      throw new Error("secret registry path and contents");
    });

    await expect(
      runInferenceGet({ cliName: "nemoclaw", json: true, sandboxName: "custom" }, deps),
    ).rejects.toMatchObject({
      message:
        "NemoClaw could not read sandbox registry metadata for the compatible inference endpoint.",
    });
    expect(deps.log).not.toHaveBeenCalled();
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

  it("fails closed when a named sandbox has an invalid gateway binding", async () => {
    const deps = createDeps("");
    deps.getSandboxTargetGatewayName.mockImplementation(() => {
      throw new Error("invalid gatewayName secret-invalid-gateway and gatewayPort 31337");
    });

    const lookup = runInferenceGet({ sandboxName: "beta" }, deps);
    await expect(lookup).rejects.toMatchObject({
      message: "NemoClaw could not resolve the sandbox's recorded gateway.",
    });
    await expect(lookup).rejects.not.toThrow(/secret-invalid-gateway|31337/);
    expect(deps.captureOpenshell).not.toHaveBeenCalled();
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
