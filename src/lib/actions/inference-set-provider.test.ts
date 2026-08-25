// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/provider-command";
import type { InferenceSetDeps } from "./inference-set";
import { __test, prepareInferenceSetProviderBinding } from "./inference-set-provider";
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

describe("inference set provider binding", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("updates an owned provider with only the route token in invocation-local env", () => {
    vi.stubEnv("COMPATIBLE_API_KEY", "real-upstream-secret");
    const before = providerOutput({ resourceVersion: 4 });
    const after = providerOutput({ resourceVersion: 5 });
    const capture = captureSequence([
      { status: 0, stdout: before, stderr: "", output: before },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: after, stderr: "", output: after },
    ]);

    const mutation = prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      captureOpenshell: capture,
    });
    mutation.commit();

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

  it("creates an absent provider and verifies its new identity", () => {
    const after = providerOutput({ resourceVersion: 1 });
    const capture = captureSequence([
      { status: 1, stdout: "", stderr: "Provider 'compatible-endpoint' not found" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: after, stderr: "" },
    ]);

    expect(() =>
      prepareInferenceSetProviderBinding({
        gatewayName: "nemoclaw",
        providerName: "compatible-endpoint",
        binding: binding(),
        captureOpenshell: capture,
      }),
    ).not.toThrow();
    expect(capture.mock.calls[1][0]).toContain("profile");
    expect(capture.mock.calls[2][0]).toContain("create");
  });

  it("stops before an OpenAI provider mutation when profile registration fails (#9895)", () => {
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

    const mutation = prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      captureOpenshell: capture,
    });

    expect(() => mutation.commit()).toThrow(
      "could not import the checked-in 'openai' inference provider profile",
    );
    expect(capture.mock.calls.map(([args]) => args[1])).toEqual(["get", "profile", "profile"]);
  });

  it("does not register the OpenAI profile before an Anthropic provider mutation", () => {
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

    prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-anthropic-endpoint",
      binding: binding({ providerType: "anthropic", credentialEnv: "ANTHROPIC_API_KEY" }),
      captureOpenshell: capture,
    });

    expect(capture.mock.calls.map(([args]) => args[1])).toEqual(["get", "create", "get"]);
  });

  it("creates a provider after the OpenShell 0.0.99 generic lookup miss (#7725)", () => {
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

    const mutation = prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      captureOpenshell: capture,
    });

    expect(mutation.action).toBe("create");
    expect(capture.mock.calls[1][0]).toContain("profile");
    expect(capture.mock.calls[2][0]).toContain("create");
  });

  it("removes a newly created provider when the caller rolls back", () => {
    const after = providerOutput({ resourceVersion: 1 });
    const capture = captureSequence([
      { status: 1, stdout: "", stderr: "Provider 'compatible-endpoint' not found" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: after, stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "Provider 'compatible-endpoint' not found" },
    ]);

    const mutation = prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      captureOpenshell: capture,
    });
    mutation.rollback();

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
  ])("fails closed on update identity drift: %s", (_label, id, resourceVersion) => {
    const capture = captureSequence([
      { status: 0, stdout: providerOutput({ resourceVersion: 4 }), stderr: "" },
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: providerOutput({ id, resourceVersion }), stderr: "" },
    ]);

    expect(() =>
      prepareInferenceSetProviderBinding({
        gatewayName: "nemoclaw",
        providerName: "compatible-endpoint",
        binding: binding(),
        captureOpenshell: capture,
      }).commit(),
    ).toThrow("may be partial");
  });

  it("fails closed when provider metadata is malformed or foreign", () => {
    const malformed = providerOutput({ resourceVersion: 4, credentialKey: "FOREIGN_TOKEN" });
    const capture = captureSequence([{ status: 0, stdout: malformed, stderr: "" }]);

    expect(() =>
      prepareInferenceSetProviderBinding({
        gatewayName: "nemoclaw",
        providerName: "compatible-endpoint",
        binding: binding(),
        captureOpenshell: capture,
      }),
    ).toThrow("malformed, foreign");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("treats a nonzero mutation as ambiguous and never infers success from post-state", () => {
    const before = providerOutput({ resourceVersion: 4 });
    const after = providerOutput({ resourceVersion: 5 });
    const capture = captureSequence([
      { status: 0, stdout: before, stderr: "" },
      { status: 1, stdout: "", stderr: "transient failure" },
      { status: 0, stdout: after, stderr: "" },
    ]);

    expect(() =>
      prepareInferenceSetProviderBinding({
        gatewayName: "nemoclaw",
        providerName: "compatible-endpoint",
        binding: binding(),
        captureOpenshell: capture,
      }).commit(),
    ).toThrow("may have partially applied");
  });

  it("keeps route credentials isolated across independent invocations", () => {
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

    prepareInferenceSetProviderBinding({
      gatewayName: "gateway-a",
      providerName: "compatible-endpoint",
      binding: binding({ token: "route-token-a" }),
      captureOpenshell: makeCapture("aaaaaaaa-2222-4333-8444-555555555555"),
    }).commit();
    prepareInferenceSetProviderBinding({
      gatewayName: "gateway-b",
      providerName: "compatible-endpoint",
      binding: binding({ token: "route-token-b", routeId: "route-b" }),
      captureOpenshell: makeCapture("bbbbbbbb-2222-4333-8444-555555555555"),
    }).commit();

    expect(mutations).toEqual([
      { COMPATIBLE_API_KEY: "route-token-a" },
      { COMPATIBLE_API_KEY: "route-token-b" },
    ]);
  });

  it("parses styled identity fields but rejects duplicates and invalid versions", () => {
    expect(
      __test.parseProviderVersion(
        "\u001b[2mId:\u001b[0m 11111111-2222-4333-8444-555555555555\n\u001b[2mResource version:\u001b[0m 7",
      ),
    ).toEqual({ id: PROVIDER_ID, resourceVersion: 7 });
    expect(
      __test.parseProviderVersion(`Id: ${PROVIDER_ID}\nId: ${PROVIDER_ID}\nResource version: 7`),
    ).toBeNull();
    expect(__test.parseProviderVersion(`Id: ${PROVIDER_ID}\nResource version: 0`)).toBeNull();
  });
});
