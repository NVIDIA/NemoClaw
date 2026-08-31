// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { createCliOpenShellProviderAdapter } from "../adapters/openshell/provider-adapter-cli";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/provider-command";
import type { InferenceSetDeps } from "./inference-set";
import { prepareInferenceSetProviderBinding } from "./inference-set-provider";
import type { HttpsPinProviderBinding } from "./inference-set-route-containment";

const PROVIDER_ID = "11111111-2222-4333-8444-555555555555";
const OPENAI_ENDPOINTLESS_PROFILE = JSON.stringify({
  id: "openai",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: true,
});

const OPENAI_ENDPOINTLESS_PROFILE_RESULT = {
  status: 0,
  stdout: OPENAI_ENDPOINTLESS_PROFILE,
  stderr: "",
  output: OPENAI_ENDPOINTLESS_PROFILE,
};

function binding(overrides: Partial<HttpsPinProviderBinding> = {}): HttpsPinProviderBinding {
  return {
    baseUrl: "http://host.openshell.internal:11438/route/route-a/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    token: "route-token-a",
    routeId: "route-a",
    providerType: "openai",
    ...overrides,
  };
}

function providerOutput(options: {
  id?: string;
  resourceVersion: number;
  providerName?: string;
  type?: string;
  credentialKey?: string;
  configKey?: string;
}): string {
  return [
    `Name: ${options.providerName ?? "compatible-endpoint"}`,
    `Id: ${options.id ?? PROVIDER_ID}`,
    `Type: ${options.type ?? "openai"}`,
    `Resource version: ${options.resourceVersion}`,
    `Credential keys: ${options.credentialKey ?? "COMPATIBLE_API_KEY"}`,
    `Config keys: ${options.configKey ?? "OPENAI_BASE_URL"}`,
  ].join("\n");
}

function captureSequence(
  results: Array<{ status: number; stdout?: string; stderr?: string; output?: string }>,
): InferenceSetDeps["captureOpenshell"] & ReturnType<typeof vi.fn> {
  return vi.fn(
    (args: string[]) =>
      (args[0] === "provider" && args[1] === "profile"
        ? OPENAI_ENDPOINTLESS_PROFILE_RESULT
        : results.shift()) ??
      (() => {
        throw new Error("unexpected OpenShell call");
      })(),
  ) as InferenceSetDeps["captureOpenshell"] & ReturnType<typeof vi.fn>;
}

function providerAdapterFromCapture(
  captureOpenshell: InferenceSetDeps["captureOpenshell"],
): OpenShellProviderAdapter {
  return createCliOpenShellProviderAdapter({
    run: (args, options) =>
      captureOpenshell(args, {
        ...(options.env ? { env: options.env } : {}),
        ignoreError: true,
        includeStreams: true,
        ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
        timeout: options.timeout,
      }),
  });
}

describe("inference set provider binding", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("updates an owned provider with only the route token in invocation-local env", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const before = providerOutput({ resourceVersion: 4 });
    const after = providerOutput({ resourceVersion: 5 });
    const capture = captureSequence([
      { status: 0, stdout: before, stderr: "", output: before },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: after, stderr: "", output: after },
    ]);

    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapterFromCapture(capture),
    });
    await mutation.commit();

    expect(capture.mock.calls[1][0]).toEqual([
      "provider",
      "profile",
      "-g",
      "nemoclaw",
      "export",
      "openai",
      "--output",
      "json",
    ]);
    expect(capture.mock.calls[1][1]).toEqual({
      ignoreError: true,
      includeStreams: true,
      maxBuffer: 64 * 1024,
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    expect(capture.mock.calls[2]).toEqual([
      [
        "provider",
        "update",
        "-g",
        "nemoclaw",
        "compatible-endpoint",
        "--credential",
        "COMPATIBLE_API_KEY",
        "--config",
        "OPENAI_BASE_URL=http://host.openshell.internal:11438/route/route-a/v1",
      ],
      expect.objectContaining({ env: { COMPATIBLE_API_KEY: "route-token-a" } }),
    ]);
    expect(JSON.stringify(capture.mock.calls)).not.toContain("real-upstream-secret");
    expect(process.env.COMPATIBLE_API_KEY).toBe("real-upstream-secret");
    expect(JSON.stringify(binding())).not.toContain("real-upstream-secret");
  });

  it("creates an absent provider and verifies its new identity", async () => {
    const after = providerOutput({ resourceVersion: 1 });
    const capture = captureSequence([
      { status: 1, stdout: "", stderr: "Provider 'compatible-endpoint' not found" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: after, stderr: "" },
    ]);

    await expect(
      prepareInferenceSetProviderBinding({
        gatewayName: "nemoclaw",
        providerName: "compatible-endpoint",
        binding: binding(),
        providerAdapter: providerAdapterFromCapture(capture),
      }),
    ).resolves.toBeDefined();
    expect(capture.mock.calls[1][0]).toContain("profile");
    expect(capture.mock.calls[2][0]).toContain("create");
  });

  it("stops before an OpenAI provider mutation when profile registration fails (#9895)", async () => {
    const before = providerOutput({ resourceVersion: 4 });
    const responses = [
      { status: 0, stdout: before, stderr: "", output: before },
      { status: 1, stdout: "", stderr: "provider profile not found" },
      { status: 1, stdout: "", stderr: "sensitive profile failure" },
    ];
    const capture = vi.fn(
      () =>
        responses.shift() ??
        (() => {
          throw new Error("provider mutation must not run");
        })(),
    ) as InferenceSetDeps["captureOpenshell"] & ReturnType<typeof vi.fn>;

    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapterFromCapture(capture),
    });

    await expect(mutation.commit()).rejects.toThrow(
      "could not import the checked-in 'openai' inference provider profile",
    );
    expect(capture.mock.calls.map(([args]) => args[1])).toEqual(["get", "profile", "profile"]);
  });

  it("does not register the OpenAI profile before an Anthropic provider mutation", async () => {
    const after = providerOutput({
      resourceVersion: 1,
      providerName: "compatible-anthropic-endpoint",
      type: "anthropic",
      credentialKey: "ANTHROPIC_API_KEY",
      configKey: "ANTHROPIC_BASE_URL",
    });
    const capture = captureSequence([
      { status: 1, stdout: "", stderr: "Provider 'compatible-anthropic-endpoint' not found" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: after, stderr: "", output: after },
    ]);

    await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-anthropic-endpoint",
      binding: binding({ providerType: "anthropic", credentialEnv: "ANTHROPIC_API_KEY" }),
      providerAdapter: providerAdapterFromCapture(capture),
    });

    expect(capture.mock.calls.map(([args]) => args[1])).toEqual(["get", "create", "get"]);
  });

  it("creates a provider after the OpenShell 0.0.99 generic lookup miss (#7725)", async () => {
    const after = providerOutput({ resourceVersion: 1 });
    const capture = captureSequence([
      {
        status: 1,
        stdout: "",
        stderr:
          "Error: code: 'Some requested entity was not found', message: \"provider not found\"",
      },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: after, stderr: "" },
    ]);

    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapterFromCapture(capture),
    });

    expect(mutation.action).toBe("create");
    expect(capture.mock.calls[1][0]).toContain("profile");
    expect(capture.mock.calls[2][0]).toContain("create");
  });

  it("removes a newly created provider when the caller rolls back", async () => {
    const after = providerOutput({ resourceVersion: 1 });
    const capture = captureSequence([
      { status: 1, stdout: "", stderr: "Provider 'compatible-endpoint' not found" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: after, stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "Provider 'compatible-endpoint' not found" },
    ]);

    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapterFromCapture(capture),
    });
    await mutation.rollback();

    expect(mutation.action).toBe("create");
    expect(capture.mock.calls[4][0]).toEqual([
      "provider",
      "delete",
      "-g",
      "nemoclaw",
      "compatible-endpoint",
    ]);
  });

  it.each([
    ["same resource version", PROVIDER_ID, 4],
    ["delete and recreate", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 5],
  ])("fails closed on update identity drift: %s", async (_label, id, resourceVersion) => {
    const capture = captureSequence([
      { status: 0, stdout: providerOutput({ resourceVersion: 4 }), stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: providerOutput({ id, resourceVersion }), stderr: "" },
    ]);

    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapterFromCapture(capture),
    });
    await expect(mutation.commit()).rejects.toThrow("may be partial");
  });

  it("fails closed when provider metadata is malformed or foreign", async () => {
    const malformed = providerOutput({ resourceVersion: 4, credentialKey: "FOREIGN_TOKEN" });
    const capture = captureSequence([{ status: 0, stdout: malformed, stderr: "" }]);

    await expect(
      prepareInferenceSetProviderBinding({
        gatewayName: "nemoclaw",
        providerName: "compatible-endpoint",
        binding: binding(),
        providerAdapter: providerAdapterFromCapture(capture),
      }),
    ).rejects.toThrow("malformed, foreign");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("treats a nonzero mutation as ambiguous and never infers success from post-state", async () => {
    const before = providerOutput({ resourceVersion: 4 });
    const after = providerOutput({ resourceVersion: 5 });
    const capture = captureSequence([
      { status: 0, stdout: before, stderr: "" },
      { status: 1, stdout: "", stderr: "transient failure" },
      { status: 0, stdout: after, stderr: "" },
    ]);

    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapterFromCapture(capture),
    });
    await expect(mutation.commit()).rejects.toThrow("may have partially applied");
  });

  it("keeps route credentials isolated across independent invocations", async () => {
    const mutations: Array<NodeJS.ProcessEnv | undefined> = [];
    const makeCapture = (id: string): InferenceSetDeps["captureOpenshell"] => {
      let version = 1;
      return (args, opts) => {
        switch (args[1]) {
          case "profile":
            return OPENAI_ENDPOINTLESS_PROFILE_RESULT;
          case "get": {
            const output = providerOutput({ id, resourceVersion: version });
            return { status: 0, stdout: output, stderr: "", output };
          }
          default:
            mutations.push(opts?.env);
            version += 1;
            return { status: 0, stdout: "", stderr: "", output: "" };
        }
      };
    };

    const first = await prepareInferenceSetProviderBinding({
      gatewayName: "gateway-a",
      providerName: "compatible-endpoint",
      binding: binding({ token: "route-token-a" }),
      providerAdapter: providerAdapterFromCapture(
        makeCapture("aaaaaaaa-2222-4333-8444-555555555555"),
      ),
    });
    await first.commit();
    const second = await prepareInferenceSetProviderBinding({
      gatewayName: "gateway-b",
      providerName: "compatible-endpoint",
      binding: binding({ token: "route-token-b", routeId: "route-b" }),
      providerAdapter: providerAdapterFromCapture(
        makeCapture("bbbbbbbb-2222-4333-8444-555555555555"),
      ),
    });
    await second.commit();

    expect(mutations).toEqual([
      { COMPATIBLE_API_KEY: "route-token-a" },
      { COMPATIBLE_API_KEY: "route-token-b" },
    ]);
  });

  it("makes update decisions from typed provider results (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          name: "compatible-endpoint",
          type: "openai",
          credentialKeys: ["COMPATIBLE_API_KEY"],
          configKeys: ["OPENAI_BASE_URL"],
          revision: { id: PROVIDER_ID, resourceVersion: 4 },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          name: "compatible-endpoint",
          type: "openai",
          credentialKeys: ["COMPATIBLE_API_KEY"],
          configKeys: ["OPENAI_BASE_URL"],
          revision: { id: PROVIDER_ID, resourceVersion: 5 },
        },
      });
    const updateProvider = vi.fn<OpenShellProviderAdapter["updateProvider"]>(async () => ({
      ok: true,
      value: { state: "updated" },
    }));
    const providerAdapter = {
      getProvider,
      updateProvider,
      ensureEndpointlessProviderProfile: vi.fn(async () => ({
        ok: true as const,
        value: { state: "ready" as const },
      })),
    } as unknown as OpenShellProviderAdapter;

    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw-18080",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter,
    });
    await mutation.commit();

    expect(updateProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw-18080" },
      providerName: "compatible-endpoint",
      credentials: [{ name: "COMPATIBLE_API_KEY", value: "route-token-a" }],
      config: [
        {
          key: "OPENAI_BASE_URL",
          value: "http://host.openshell.internal:11438/route/route-a/v1",
        },
      ],
    });
  });

  it("does not infer absence from a typed authentication failure (#9806)", async () => {
    const providerAdapter = {
      getProvider: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "authentication" as const,
          message: "OpenShell could not authenticate the provider operation.",
        },
      })),
    } as unknown as OpenShellProviderAdapter;

    await expect(
      prepareInferenceSetProviderBinding({
        gatewayName: "nemoclaw",
        providerName: "compatible-endpoint",
        binding: binding(),
        providerAdapter,
      }),
    ).rejects.toThrow("no provider mutation was attempted");
  });

  it("stops before update when typed metadata has no revision evidence (#9806)", async () => {
    const providerAdapter = {
      getProvider: vi.fn(async () => ({
        ok: true as const,
        value: {
          name: "compatible-endpoint",
          type: "openai",
          credentialKeys: ["COMPATIBLE_API_KEY"],
          configKeys: ["OPENAI_BASE_URL"],
          revision: null,
        },
      })),
    } as unknown as OpenShellProviderAdapter;

    await expect(
      prepareInferenceSetProviderBinding({
        gatewayName: "nemoclaw",
        providerName: "compatible-endpoint",
        binding: binding(),
        providerAdapter,
      }),
    ).rejects.toThrow("without a revision");
  });
});
