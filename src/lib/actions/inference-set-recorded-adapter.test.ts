// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenShellInferenceRouteMutator } from "../adapters/openshell/inference-route";
import { buildHttpsPinRouteBaseUrl } from "../inference/https-pin-runtime";
import { runInferenceSet } from "./inference-set";
import {
  baseSession,
  createCompatibleProviderCapture,
  createDeps,
  HERMES_TARGET,
  nativeLocalTestReceipt,
} from "../../../test/helpers/inference-set";

const ADAPTER_URL = buildHttpsPinRouteBaseUrl("a".repeat(64));
const GATEWAY_NAME = "nemoclaw-18085";
const PREVIOUS_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const LIVE_PREVIOUS_MODEL = "observed-previous-model";
const TARGET_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
const PROVIDERS = [
  {
    provider: "compatible-endpoint",
    credentialEnv: "COMPATIBLE_API_KEY",
    inferenceApi: "openai-completions",
    type: "openai",
    configKey: "OPENAI_BASE_URL",
    modelNamespace: "inference",
  },
  {
    provider: "compatible-anthropic-endpoint",
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    inferenceApi: "anthropic-messages",
    type: "anthropic",
    configKey: "ANTHROPIC_BASE_URL",
    modelNamespace: "anthropic",
  },
] as const;

function recordedRouteDeps(
  route: (typeof PROVIDERS)[number],
  endpointUrl = ADAPTER_URL,
  agent: "openclaw" | "hermes" = "openclaw",
) {
  const capture = createCompatibleProviderCapture({ ...route, name: route.provider });
  const metadata = {
    provider: route.provider,
    model: PREVIOUS_MODEL,
    endpointUrl,
    endpointSource: "inference-set" as const,
    credentialEnv: route.credentialEnv,
    preferredInferenceApi: route.inferenceApi,
  };
  return createDeps({
    config:
      agent === "hermes"
        ? {
            model: {
              default: PREVIOUS_MODEL,
              provider: "custom",
              base_url: "https://inference.local/v1",
            },
          }
        : {
            agents: {
              defaults: { model: { primary: `${route.modelNamespace}/${PREVIOUS_MODEL}` } },
            },
            models: {
              providers: { [route.modelNamespace]: { api: route.inferenceApi, models: [] } },
            },
          },
    target: agent === "hermes" ? HERMES_TARGET : undefined,
    entry: {
      name: "alpha",
      agent,
      gatewayName: GATEWAY_NAME,
      gatewayPort: 18085,
      ...metadata,
      ...(agent === "hermes"
        ? {
            nativeLocalProviderAttachment: nativeLocalTestReceipt(route.provider, endpointUrl, {
              agent: "hermes",
              gatewayName: GATEWAY_NAME,
            }),
          }
        : {}),
    },
    session: baseSession({
      agent,
      ...metadata,
      metadata: { gatewayName: GATEWAY_NAME, fromDockerfile: null },
    }),
    captureOpenshell: (args, options) => {
      const hostVerification =
        endpointUrl === ADAPTER_URL &&
        args[0] === "inference" &&
        args[1] === "set" &&
        !args.includes("--no-verify");
      const detail = `Error: failed to verify inference endpoint at '${ADAPTER_URL}': failed to connect`;
      return hostVerification
        ? { status: 1, output: detail, stdout: "", stderr: detail }
        : capture(args, options);
    },
  });
}

function routeSelections(deps: ReturnType<typeof recordedRouteDeps>) {
  return deps.calls.captureOpenshell.mock.calls
    .map(([args]) => args as string[])
    .filter((args) => args[0] === "inference" && args[1] === "set");
}

function expectRecordedBindingUnchanged(deps: ReturnType<typeof recordedRouteDeps>) {
  expect(deps.calls.resolveCredentialValue).not.toHaveBeenCalled();
  expect(deps.calls.ensureHttpsPinRuntimeAdapter).not.toHaveBeenCalled();
  expect(deps.calls.revokeHttpsPinRuntimeAdapterRoute).not.toHaveBeenCalled();
  expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
  expect(
    deps.calls.captureOpenshell.mock.calls.filter(
      ([args]) => args[0] === "provider" && ["create", "update", "delete"].includes(args[1]),
    ),
  ).toEqual([]);
}

describe("recorded compatible adapter model changes", () => {
  it("verifies a reused Hermes adapter before writing its model configuration (#13095)", async () => {
    const route = PROVIDERS[0];
    const deps = recordedRouteDeps(route, ADAPTER_URL, "hermes");
    const attachment = deps.getSandbox("alpha")!.nativeLocalProviderAttachment!;
    vi.spyOn(deps, "prepareNativeLocalSwitch").mockResolvedValue({
      receipt: attachment,
      changed: false,
      previousDetached: false,
    });

    await expect(
      runInferenceSet({ provider: route.provider, model: TARGET_MODEL }, deps),
    ).resolves.toMatchObject({
      model: TARGET_MODEL,
      inSandboxConfigSynced: true,
      sessionUpdated: false,
    });

    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
      gatewayName: GATEWAY_NAME,
      agentName: "hermes",
      provider: route.provider,
      model: TARGET_MODEL,
      preferredInferenceApi: route.inferenceApi,
      nativeProvider: true,
      registeredInferenceProviderAttachment: undefined,
      nativeLocalProviderAttachment: attachment,
      nativeEndpointUrl: ADAPTER_URL,
    });
    expect(deps.calls.probeSandboxRoute.mock.invocationCallOrder[0]).toBeLessThan(
      deps.calls.writeSandboxConfig.mock.invocationCallOrder[0],
    );
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      HERMES_TARGET,
      expect.objectContaining({
        model: expect.objectContaining({
          default: TARGET_MODEL,
          base_url: ADAPTER_URL,
          api_key: "openshell:resolve:env:v1_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
        }),
      }),
      { deferReload: true, gatewayName: GATEWAY_NAME },
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ model: TARGET_MODEL, endpointUrl: ADAPTER_URL }),
    );
    expect(deps.getSession()).toMatchObject({
      agent: "hermes",
      model: PREVIOUS_MODEL,
      endpointUrl: ADAPTER_URL,
    });
    expect(deps.calls.updateSession).not.toHaveBeenCalled();
    expectRecordedBindingUnchanged(deps);
  });

  it.each(PROVIDERS.flatMap((route) => [false, true].map((noVerify) => ({ ...route, noVerify }))))(
    "verifies a reused $provider adapter before publishing the model with noVerify=$noVerify (#13095)",
    async (route) => {
      const deps = recordedRouteDeps(route);

      await expect(
        runInferenceSet(
          {
            provider: route.provider,
            model: TARGET_MODEL,
            ...(route.noVerify ? { noVerify: true } : {}),
          },
          deps,
        ),
      ).resolves.toMatchObject({ provider: route.provider, model: TARGET_MODEL });

      expect(routeSelections(deps)).toEqual([
        [
          "inference",
          "set",
          "-g",
          GATEWAY_NAME,
          "--no-verify",
          "--provider",
          route.provider,
          "--model",
          TARGET_MODEL,
        ],
      ]);
      expect(deps.calls.probeSandboxRoute).toHaveBeenCalledExactlyOnceWith({
        sandboxName: "alpha",
        gatewayName: GATEWAY_NAME,
        agentName: "openclaw",
        provider: route.provider,
        model: TARGET_MODEL,
        preferredInferenceApi: route.inferenceApi,
      });
      expect(deps.calls.probeSandboxRoute.mock.invocationCallOrder[0]).toBeLessThan(
        deps.calls.updateSandbox.mock.invocationCallOrder[0],
      );
      expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({ model: TARGET_MODEL, endpointUrl: ADAPTER_URL }),
      );
      expect(deps.calls.setOpenClawConfigValues).toHaveBeenCalledWith(
        "alpha",
        expect.arrayContaining([
          {
            dotpath: "agents.defaults.model.primary",
            value: `${route.modelNamespace}/${TARGET_MODEL}`,
          },
        ]),
        GATEWAY_NAME,
      );
      expect(deps.getSession()).toMatchObject({ model: TARGET_MODEL, endpointUrl: ADAPTER_URL });
      expectRecordedBindingUnchanged(deps);
    },
  );

  it.each(PROVIDERS)(
    "restores the previous $provider model when sandbox verification rejects the target (#13095)",
    async (route) => {
      const deps = recordedRouteDeps(route);
      deps.inferenceRouteObserver = {
        observeInferenceRoute: async () => ({
          ok: true,
          value: {
            state: "configured",
            route: { provider: route.provider, model: LIVE_PREVIOUS_MODEL },
          },
        }),
      };
      deps.calls.probeSandboxRoute.mockResolvedValue({
        ok: false,
        httpStatus: 401,
        detail: "HTTP 401",
      });

      await expect(
        runInferenceSet({ provider: route.provider, model: TARGET_MODEL }, deps),
      ).rejects.toThrow(/Sandbox-side verification rejected.*HTTP 401.*restored/s);

      expect(routeSelections(deps)).toEqual(
        [TARGET_MODEL, LIVE_PREVIOUS_MODEL].map((model) => [
          "inference",
          "set",
          "-g",
          GATEWAY_NAME,
          "--no-verify",
          "--provider",
          route.provider,
          "--model",
          model,
        ]),
      );
      expect(deps.calls.probeSandboxRoute).toHaveBeenCalledOnce();
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
      expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
      expect(deps.calls.updateSession).not.toHaveBeenCalled();
      expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
      expect(deps.getSession()).toMatchObject({ model: PREVIOUS_MODEL, endpointUrl: ADAPTER_URL });
      expectRecordedBindingUnchanged(deps);
    },
  );

  it("reports failed model restoration without committing local state (#13095)", async () => {
    const route = PROVIDERS[0];
    const deps = recordedRouteDeps(route);
    const setInferenceRoute = vi
      .fn<OpenShellInferenceRouteMutator["setInferenceRoute"]>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValue({
        ok: false,
        ambiguous: false,
        error: { kind: "command", reason: "failed", exitCode: 1, message: "restore failed" },
      });
    deps.inferenceRouteMutator = { setInferenceRoute };
    deps.calls.probeSandboxRoute.mockResolvedValue({
      ok: false,
      httpStatus: 401,
      detail: "HTTP 401",
    });

    await expect(
      runInferenceSet({ provider: route.provider, model: TARGET_MODEL }, deps),
    ).rejects.toThrow(/Failed to restore the previous OpenShell inference selection.*status 1/s);

    expect(setInferenceRoute).toHaveBeenNthCalledWith(2, {
      target: { kind: "named", gatewayName: GATEWAY_NAME },
      route: { provider: route.provider, model: PREVIOUS_MODEL },
      verification: "skip",
    });
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
    expect(deps.calls.updateSession).not.toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
    expectRecordedBindingUnchanged(deps);
  });

  it("retains host verification for a recorded direct HTTPS endpoint (#13095)", async () => {
    const route = PROVIDERS[0];
    const deps = recordedRouteDeps(route, "https://compatible.example/v1");

    await expect(
      runInferenceSet({ provider: route.provider, model: TARGET_MODEL }, deps),
    ).resolves.toMatchObject({ model: TARGET_MODEL });

    expect(routeSelections(deps)).toEqual([
      [
        "inference",
        "set",
        "-g",
        GATEWAY_NAME,
        "--provider",
        route.provider,
        "--model",
        TARGET_MODEL,
      ],
    ]);
    expect(deps.calls.probeSandboxRoute).not.toHaveBeenCalled();
    expectRecordedBindingUnchanged(deps);
  });

  it("retains adapter validation when explicitly configuring an HTTPS endpoint (#13095)", async () => {
    const route = PROVIDERS[0];
    const deps = recordedRouteDeps(route);
    deps.calls.ensureHttpsPinRuntimeAdapter.mockResolvedValue({
      baseUrl: ADAPTER_URL,
      credentialEnv: route.credentialEnv,
      token: "test-adapter-token",
      routeId: "a".repeat(64),
    });

    await expect(
      runInferenceSet(
        {
          provider: route.provider,
          model: TARGET_MODEL,
          endpointUrl: "https://compatible.example/v1",
          credentialEnv: route.credentialEnv,
          inferenceApi: route.inferenceApi,
        },
        deps,
      ),
    ).resolves.toMatchObject({ model: TARGET_MODEL });

    expect(deps.calls.ensureHttpsPinRuntimeAdapter).toHaveBeenCalledOnce();
    expect(deps.calls.resolveCredentialValue).toHaveBeenCalledExactlyOnceWith(route.credentialEnv);
    expect(deps.calls.probeSandboxRoute).not.toHaveBeenCalled();
    expect(deps.calls.captureOpenshell).toHaveBeenCalledWith(
      expect.arrayContaining(["provider", "update", `OPENAI_BASE_URL=${ADAPTER_URL}`]),
      expect.any(Object),
    );
  });
});
