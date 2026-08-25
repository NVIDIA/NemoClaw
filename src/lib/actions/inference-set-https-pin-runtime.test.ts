// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV } from "../inference/https-pin-runtime";
import type { ConfigObject } from "../security/credential-filter";
import type { InferenceSetDeps } from "./inference-set";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps, HERMES_TARGET } from "./inference-set.test-support";
import type { EnsureHttpsPinRuntimeAdapterOptions } from "./inference-set-route-containment";

const ADAPTER_TOKEN = "test-route-token";
const NEW_ROUTE_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OLD_ROUTE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADAPTER_BASE_URL = `http://host.openshell.internal:11438/route/${NEW_ROUTE_ID}`;
const OLD_ADAPTER_BASE_URL = `http://host.openshell.internal:11438/route/${OLD_ROUTE_ID}`;
const PROVIDER_ID = "11111111-2222-4333-8444-555555555555";
const OPENAI_PROFILE_OUTPUT = JSON.stringify({
  id: "openai",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: true,
});
const ANTHROPIC_PROFILE_OUTPUT = JSON.stringify({
  id: "anthropic",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: true,
});

function mockAdapter() {
  return vi.fn(async (_options: EnsureHttpsPinRuntimeAdapterOptions) => ({
    baseUrl: ADAPTER_BASE_URL,
    credentialEnv: HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
    token: ADAPTER_TOKEN,
    routeId: NEW_ROUTE_ID,
  }));
}

function providerCapture(options: {
  providerName: string;
  providerType: "openai" | "anthropic";
  credentialEnv: string;
}): InferenceSetDeps["captureOpenshell"] & ReturnType<typeof vi.fn> {
  let resourceVersion = 4;
  const configKey = options.providerType === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";
  const output = () =>
    [
      `Name: ${options.providerName}`,
      `Id: ${PROVIDER_ID}`,
      `Type: ${options.providerType}`,
      `Resource version: ${resourceVersion}`,
      `Credential keys: ${options.credentialEnv}`,
      `Config keys: ${configKey}`,
    ].join("\n");
  return vi.fn((args: string[]) => {
    switch (`${args[0]}:${args[1]}`) {
      case "provider:profile": {
        const profile =
          options.providerType === "anthropic" ? ANTHROPIC_PROFILE_OUTPUT : OPENAI_PROFILE_OUTPUT;
        return {
          status: 0,
          output: profile,
          stdout: profile,
          stderr: "",
        };
      }
      case "provider:get": {
        const text = output();
        return { status: 0, stdout: text, stderr: "", output: text };
      }
      case "provider:update":
        resourceVersion += 1;
        return { status: 0, stdout: "", stderr: "", output: "" };
      default:
        return { status: 0, stdout: "", stderr: "", output: "" };
    }
  }) as InferenceSetDeps["captureOpenshell"] & ReturnType<typeof vi.fn>;
}

function failRegistryRead(): never {
  throw new Error("registry unavailable");
}

function failRegistryReadAfterTwoCalls(
  originalListSandboxes: InferenceSetDeps["listSandboxes"],
): InferenceSetDeps["listSandboxes"] {
  let listCalls = 0;
  return () => (listCalls++ < 2 ? originalListSandboxes() : failRegistryRead());
}

describe("runInferenceSet HTTPS-pin route credential handoff (#6141)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env[HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV];
  });

  it.each([
    [
      "compatible-endpoint",
      "COMPATIBLE_API_KEY",
      "openai-completions",
      "openai",
      "OPENAI_BASE_URL",
    ],
    [
      "compatible-anthropic-endpoint",
      "COMPATIBLE_ANTHROPIC_API_KEY",
      "anthropic-messages",
      "anthropic",
      "ANTHROPIC_BASE_URL",
    ],
  ] as const)("keeps the upstream secret host-only and binds a route token for %s", async (provider, credentialEnv, inferenceApi, providerType, configKey) => {
    vi.stubEnv(credentialEnv, "real-upstream-secret");
    const adapter = mockAdapter();
    const capture = providerCapture({ providerName: provider, providerType, credentialEnv });
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      session: baseSession({ provider: "nvidia-prod", model: "nvidia/model-a" }),
      ensureHttpsPinRuntimeAdapter: adapter,
      captureOpenshell: capture,
    });

    await runInferenceSet(
      {
        provider,
        model: "mock-model",
        endpointUrl: "https://compatible.example/v1",
        credentialEnv,
        inferenceApi,
      },
      deps,
    );

    expect(adapter).toHaveBeenCalledWith(
      expect.objectContaining({ credentialValue: "real-upstream-secret", providerType }),
    );
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({ provider, endpointUrl: ADAPTER_BASE_URL, credentialEnv }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider,
      endpointUrl: ADAPTER_BASE_URL,
      credentialEnv,
    });
    expect(JSON.stringify(deps.calls.updateSandbox.mock.calls)).not.toContain("compatible.example");
    expect(JSON.stringify(deps.calls.updateSandbox.mock.calls)).not.toContain("/v1");
    expect(process.env[HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV]).toBeUndefined();

    const mutation = capture.mock.calls.find(
      ([args]) => args[0] === "provider" && args[1] === "update",
    );
    expect(mutation?.[0]).toContain(`${configKey}=${ADAPTER_BASE_URL}`);
    expect(mutation?.[1]).toEqual(
      expect.objectContaining({ env: { [credentialEnv]: ADAPTER_TOKEN } }),
    );
    expect(JSON.stringify(capture.mock.calls)).not.toContain("real-upstream-secret");
    expect(JSON.stringify(capture.mock.calls)).not.toContain("compatible.example");
    expect(capture).toHaveBeenCalledWith(
      expect.arrayContaining(["inference", "set", "--no-verify"]),
      expect.any(Object),
    );
    const inferenceSetIndex = capture.mock.calls.findIndex(
      ([args]) => args[0] === "inference" && args[1] === "set",
    );
    const providerUpdateIndex = capture.mock.calls.findIndex(
      ([args]) => args[0] === "provider" && args[1] === "update",
    );
    expect(inferenceSetIndex).toBeGreaterThanOrEqual(0);
    expect(providerUpdateIndex).toBeGreaterThan(inferenceSetIndex);
  });

  it("uses the OpenAI provider surface for a Hermes compatible-Anthropic route", async () => {
    vi.stubEnv("COMPATIBLE_ANTHROPIC_API_KEY", "real-hermes-upstream-secret");
    const adapter = mockAdapter();
    const capture = providerCapture({
      providerName: "compatible-anthropic-endpoint",
      providerType: "openai",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    });
    const deps = createDeps({
      config: { model: {} },
      entry: {
        name: "hermes",
        agent: "hermes",
        provider: "hermes-provider",
        model: "old-model",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({ agent: "hermes", sandboxName: "hermes" }),
      ensureHttpsPinRuntimeAdapter: adapter,
      captureOpenshell: capture,
    });

    await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "claude-proxy",
        sandboxName: "hermes",
        endpointUrl: "https://compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        inferenceApi: "openai-completions",
      },
      deps,
    );

    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({ providerType: "openai" }));
    const mutation = capture.mock.calls.find(
      ([args]) => args[0] === "provider" && args[1] === "update",
    );
    expect(mutation?.[0]).toContain(`OPENAI_BASE_URL=${ADAPTER_BASE_URL}`);
    expect(mutation?.[1]).toEqual(
      expect.objectContaining({
        env: { COMPATIBLE_ANTHROPIC_API_KEY: ADAPTER_TOKEN },
      }),
    );
  });

  it("leaves a distinct prior provider binding untouched when inference selection fails", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const capture = providerCapture({
      providerName: "compatible-endpoint",
      providerType: "openai",
      credentialEnv: "COMPATIBLE_API_KEY",
    });
    const original = capture.getMockImplementation() as InferenceSetDeps["captureOpenshell"];
    capture.mockImplementation((args, opts) =>
      args[0] === "inference" && args[1] === "set"
        ? { status: 1, stdout: "", stderr: "selection failed", output: "selection failed" }
        : original(args, opts),
    );
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: OLD_ADAPTER_BASE_URL,
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      ensureHttpsPinRuntimeAdapter: mockAdapter(),
      captureOpenshell: capture,
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new",
          endpointUrl: "https://compatible.example/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow(
      "The existing OpenShell provider binding and inference selection were not changed.",
    );
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    const providerUpdates = capture.mock.calls.filter(
      ([args]) => args[0] === "provider" && args[1] === "update",
    );
    expect(providerUpdates).toHaveLength(0);
  });

  it("restores the prior inference selection when the deferred provider update fails", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const capture = providerCapture({
      providerName: "compatible-endpoint",
      providerType: "openai",
      credentialEnv: "COMPATIBLE_API_KEY",
    });
    const original = capture.getMockImplementation() as InferenceSetDeps["captureOpenshell"];
    capture.mockImplementation((args, opts) =>
      args[0] === "provider" && args[1] === "update"
        ? {
            status: 1,
            stdout: "",
            stderr: "provider update failed",
            output: "provider update failed",
          }
        : original(args, opts),
    );
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "old-model",
      },
      ensureHttpsPinRuntimeAdapter: mockAdapter(),
      captureOpenshell: capture,
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new-model",
          endpointUrl: "https://compatible.example/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow(
      "The previous OpenShell inference selection was restored to 'nvidia-prod' / 'old-model'",
    );
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    const selectionMutations = capture.mock.calls.filter(
      ([args]) => args[0] === "inference" && args[1] === "set",
    );
    expect(selectionMutations).toHaveLength(2);
    expect(selectionMutations[0]?.[0]).toEqual(
      expect.arrayContaining([
        "--provider",
        "compatible-endpoint",
        "--model",
        "new-model",
        "--no-verify",
      ]),
    );
    expect(selectionMutations[1]?.[0]).toEqual(
      expect.arrayContaining(["--provider", "nvidia-prod", "--model", "old-model", "--no-verify"]),
    );
  });

  it("reports committed provider and selection state when registry convergence fails", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const capture = providerCapture({
      providerName: "compatible-endpoint",
      providerType: "openai",
      credentialEnv: "COMPATIBLE_API_KEY",
    });
    const deps = createDeps({
      config: {},
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "old" },
      ensureHttpsPinRuntimeAdapter: mockAdapter(),
      captureOpenshell: capture,
      updateSandbox: () => false,
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new",
          endpointUrl: "https://compatible.example/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow(
      "provider and inference selection remain committed to the safer HTTPS-pinned adapter",
    );
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("revokes a superseded adapter route only after both registry commits", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: OLD_ADAPTER_BASE_URL,
      },
      ensureHttpsPinRuntimeAdapter: mockAdapter(),
      captureOpenshell: providerCapture({
        providerName: "compatible-endpoint",
        providerType: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
      }),
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new",
        endpointUrl: "https://new.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      deps,
    );

    expect(deps.calls.updateSandbox).toHaveBeenCalledTimes(2);
    expect(deps.calls.revokeHttpsPinRuntimeAdapterRoute).toHaveBeenCalledWith(OLD_ROUTE_ID);
    expect(
      deps.calls.revokeHttpsPinRuntimeAdapterRoute.mock.invocationCallOrder[0],
    ).toBeGreaterThan(deps.calls.updateSandbox.mock.invocationCallOrder[1]);
  });

  it("revokes an adapter route when switching to a non-adapter provider", async () => {
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: OLD_ADAPTER_BASE_URL,
      },
    });

    await runInferenceSet({ provider: "nvidia-prod", model: "nvidia/new" }, deps);

    expect(deps.calls.revokeHttpsPinRuntimeAdapterRoute).toHaveBeenCalledWith(OLD_ROUTE_ID);
  });

  it("keeps a superseded route while another sandbox still references it", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const alpha = {
      name: "alpha",
      agent: "openclaw" as const,
      provider: "compatible-endpoint",
      model: "old",
      endpointUrl: OLD_ADAPTER_BASE_URL,
    };
    const peer = {
      name: "peer",
      agent: "openclaw" as const,
      provider: "compatible-endpoint",
      model: "old",
      endpointUrl: OLD_ADAPTER_BASE_URL,
    };
    const deps = createDeps({
      config: {},
      entries: [alpha],
      ensureHttpsPinRuntimeAdapter: mockAdapter(),
      captureOpenshell: providerCapture({
        providerName: "compatible-endpoint",
        providerType: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
      }),
    });
    let listCalls = 0;
    deps.listSandboxes = () => ({
      sandboxes: listCalls++ < 2 ? [alpha] : [alpha, peer],
      defaultSandbox: "alpha",
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new",
        endpointUrl: "https://new.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      deps,
    );

    expect(deps.calls.revokeHttpsPinRuntimeAdapterRoute).not.toHaveBeenCalled();
  });

  it.each([
    ["peer registry read", "list"],
    ["adapter DELETE", "revoke"],
  ] as const)("keeps the committed route when post-commit %s fails", async (_name, failure) => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: OLD_ADAPTER_BASE_URL,
      },
      ensureHttpsPinRuntimeAdapter: mockAdapter(),
      revokeHttpsPinRuntimeAdapterRoute:
        failure === "revoke"
          ? async () => {
              throw new Error("delete unavailable");
            }
          : undefined,
      captureOpenshell: providerCapture({
        providerName: "compatible-endpoint",
        providerType: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
      }),
    });
    deps.listSandboxes =
      failure === "list" ? failRegistryReadAfterTwoCalls(deps.listSandboxes) : deps.listSandboxes;

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new",
          endpointUrl: "https://new.example/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).resolves.toMatchObject({ sandboxName: "alpha", provider: "compatible-endpoint" });
    expect(deps.calls.updateSandbox).toHaveBeenCalledTimes(2);
    expect(deps.calls.log).toHaveBeenCalledWith(expect.stringContaining("could not be revoked"));
  });

  it("does not revoke when re-registration keeps the same route id", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const sameRouteAdapter = vi.fn(async () => ({
      baseUrl: OLD_ADAPTER_BASE_URL,
      credentialEnv: HTTPS_PIN_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV,
      token: ADAPTER_TOKEN,
      routeId: OLD_ROUTE_ID,
    }));
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "old",
        endpointUrl: OLD_ADAPTER_BASE_URL,
      },
      ensureHttpsPinRuntimeAdapter: sameRouteAdapter,
      captureOpenshell: providerCapture({
        providerName: "compatible-endpoint",
        providerType: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
      }),
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new",
        endpointUrl: "https://same.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      deps,
    );

    expect(deps.calls.revokeHttpsPinRuntimeAdapterRoute).not.toHaveBeenCalled();
  });
});
