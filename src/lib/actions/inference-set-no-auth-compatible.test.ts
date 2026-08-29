// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxEntry } from "../state/registry";
import { runInferenceSet } from "./inference-set";
import {
  baseSession,
  createCompatibleProviderCapture,
  createDeps,
} from "./inference-set.test-support";

// Port 11434 is one of the loopback ports NemoClaw publishes on the OpenShell
// sandbox bridge, so it selects the same no-auth proxy route the reporter's
// vLLM-port endpoint used, without depending on NEMOCLAW_VLLM_PORT.
const NO_AUTH_ENDPOINT_URL = "http://127.0.0.1:11434/v1";
const NO_AUTH_CREDENTIAL_ENV = "NEMOCLAW_OLLAMA_PROXY_TOKEN";

const CONFIG = {
  agents: { defaults: { model: { primary: "inference/model-a" } } },
  models: { providers: { inference: { api: "openai-completions", models: [] } } },
};

function noAuthEntry(): SandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    provider: "compatible-endpoint",
    model: "model-a",
    endpointUrl: NO_AUTH_ENDPOINT_URL,
    endpointSource: "onboard",
    credentialEnv: NO_AUTH_CREDENTIAL_ENV,
    preferredInferenceApi: "openai-completions",
  } as SandboxEntry;
}

function noAuthSession() {
  return baseSession({
    provider: "compatible-endpoint",
    model: "model-a",
    endpointUrl: NO_AUTH_ENDPOINT_URL,
    credentialEnv: NO_AUTH_CREDENTIAL_ENV,
    preferredInferenceApi: "openai-completions",
  });
}

function noAuthProviderCapture(
  options: { credentialEnv?: string; initiallyPresent?: boolean } = {},
) {
  return createCompatibleProviderCapture({
    name: "compatible-endpoint",
    type: "openai",
    credentialEnv: options.credentialEnv ?? NO_AUTH_CREDENTIAL_ENV,
    configKey: "OPENAI_BASE_URL",
    initiallyPresent: options.initiallyPresent ?? true,
  });
}

function inferenceSetArgs(captureOpenshell: ReturnType<typeof noAuthProviderCapture>): string[][] {
  return captureOpenshell.mock.calls
    .filter(([args]) => args[0] === "inference" && args[1] === "set")
    .map(([args]) => args);
}

function providerMutationArgs(
  captureOpenshell: ReturnType<typeof noAuthProviderCapture>,
): string[][] {
  return captureOpenshell.mock.calls
    .filter(([args]) => args[0] === "provider" && (args[1] === "create" || args[1] === "update"))
    .map(([args]) => args);
}

describe("runInferenceSet on a loopback no-auth compatible endpoint", () => {
  it("accepts the recorded provider, model, and endpoint URL without replacing the provider", async () => {
    const captureOpenshell = noAuthProviderCapture();
    const deps = createDeps({
      config: CONFIG,
      entry: noAuthEntry(),
      session: noAuthSession(),
      captureOpenshell,
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "model-b",
        endpointUrl: NO_AUTH_ENDPOINT_URL,
      },
      deps,
    );

    expect(providerMutationArgs(captureOpenshell)).toEqual([]);
    // The gateway route is the proxy's sandbox-bridge address, so host-side
    // verification is replaced by the sandbox-side invocation probe.
    expect(inferenceSetArgs(captureOpenshell)).toEqual([
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "compatible-endpoint",
        "--model",
        "model-b",
        "--no-verify",
      ],
    ]);
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      model: "model-b",
      preferredInferenceApi: "openai-completions",
    });
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-endpoint",
        model: "model-b",
        endpointUrl: NO_AUTH_ENDPOINT_URL,
        credentialEnv: NO_AUTH_CREDENTIAL_ENV,
        preferredInferenceApi: "openai-completions",
      }),
    ]);
  });

  it("skips host-side verification when no endpoint options are passed", async () => {
    const captureOpenshell = noAuthProviderCapture();
    const deps = createDeps({
      config: CONFIG,
      entry: noAuthEntry(),
      session: noAuthSession(),
      captureOpenshell,
    });

    await runInferenceSet({ provider: "compatible-endpoint", model: "model-b" }, deps);

    expect(inferenceSetArgs(captureOpenshell)).toEqual([
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "compatible-endpoint",
        "--model",
        "model-b",
        "--no-verify",
      ],
    ]);
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalled();
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({ credentialEnv: NO_AUTH_CREDENTIAL_ENV }),
    ]);
  });

  it("refuses a foreign live binding before selecting the route with no endpoint options", async () => {
    const captureOpenshell = noAuthProviderCapture({ credentialEnv: "COMPATIBLE_API_KEY" });
    const deps = createDeps({
      config: CONFIG,
      entry: noAuthEntry(),
      session: noAuthSession(),
      captureOpenshell,
    });

    await expect(
      runInferenceSet({ provider: "compatible-endpoint", model: "model-b" }, deps),
    ).rejects.toThrow(/malformed, foreign/);

    expect(inferenceSetArgs(captureOpenshell)).toEqual([]);
    expect(providerMutationArgs(captureOpenshell)).toEqual([]);
    expect(deps.calls.probeSandboxRoute).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("refuses an absent provider before selecting the route with no endpoint options", async () => {
    const captureOpenshell = noAuthProviderCapture({ initiallyPresent: false });
    const deps = createDeps({
      config: CONFIG,
      entry: noAuthEntry(),
      session: noAuthSession(),
      captureOpenshell,
    });

    await expect(
      runInferenceSet({ provider: "compatible-endpoint", model: "model-b" }, deps),
    ).rejects.toThrow(/Re-run onboarding to restore the provider/);

    expect(inferenceSetArgs(captureOpenshell)).toEqual([]);
    expect(providerMutationArgs(captureOpenshell)).toEqual([]);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("retries the sandbox probe when it fails before reaching an HTTP status", async () => {
    const captureOpenshell = noAuthProviderCapture();
    const probeSandboxRoute = vi
      .fn()
      .mockReturnValueOnce({
        ok: false as const,
        detail: "sandbox inference invocation probe exited with status 6",
        httpStatus: null,
      })
      .mockReturnValue({ ok: true as const });
    const deps = createDeps({
      config: CONFIG,
      entry: noAuthEntry(),
      session: noAuthSession(),
      captureOpenshell,
      probeSandboxRoute,
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "model-b",
        endpointUrl: NO_AUTH_ENDPOINT_URL,
      },
      deps,
    );

    expect(probeSandboxRoute).toHaveBeenCalledTimes(2);
    expect(deps.calls.sleep.mock.calls).toEqual([[6_000], [2_000]]);
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({ model: "model-b", credentialEnv: NO_AUTH_CREDENTIAL_ENV }),
    ]);
  });

  it("rejects an explicit credential-env that is not the recorded no-auth binding", async () => {
    const captureOpenshell = noAuthProviderCapture();
    const deps = createDeps({
      config: CONFIG,
      entry: noAuthEntry(),
      session: noAuthSession(),
      captureOpenshell,
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "model-b",
          endpointUrl: NO_AUTH_ENDPOINT_URL,
          credentialEnv: "COMPATIBLE_API_KEY",
        },
        deps,
      ),
    ).rejects.toThrow(
      /credential-env for 'compatible-endpoint' must be 'NEMOCLAW_OLLAMA_PROXY_TOKEN'/,
    );

    expect(providerMutationArgs(captureOpenshell)).toEqual([]);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("still refuses a live provider whose binding does not match the recorded provenance", async () => {
    const captureOpenshell = noAuthProviderCapture({ credentialEnv: "COMPATIBLE_API_KEY" });
    const deps = createDeps({
      config: CONFIG,
      entry: noAuthEntry(),
      session: noAuthSession(),
      captureOpenshell,
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "model-b",
          endpointUrl: NO_AUTH_ENDPOINT_URL,
        },
        deps,
      ),
    ).rejects.toThrow(/malformed, foreign/);

    expect(providerMutationArgs(captureOpenshell)).toEqual([]);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("refuses to recreate a provider whose no-auth binding only onboarding can rebuild", async () => {
    const captureOpenshell = noAuthProviderCapture({ initiallyPresent: false });
    const deps = createDeps({
      config: CONFIG,
      entry: noAuthEntry(),
      session: noAuthSession(),
      captureOpenshell,
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "model-b",
          endpointUrl: NO_AUTH_ENDPOINT_URL,
        },
        deps,
      ),
    ).rejects.toThrow(/Re-run onboarding to restore the provider/);

    expect(providerMutationArgs(captureOpenshell)).toEqual([]);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("keeps host-side verification and the canonical credential for an authenticated endpoint", async () => {
    const captureOpenshell = createCompatibleProviderCapture({
      name: "compatible-endpoint",
      type: "openai",
      credentialEnv: "COMPATIBLE_API_KEY",
      configKey: "OPENAI_BASE_URL",
    });
    const deps = createDeps({
      config: CONFIG,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://compatible.example/v1",
        endpointSource: "onboard",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      } as SandboxEntry,
      session: baseSession({
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://compatible.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
      captureOpenshell,
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "model-b",
        endpointUrl: "https://compatible.example/v1",
      },
      deps,
    );

    expect(providerMutationArgs(captureOpenshell)).toEqual([]);
    expect(inferenceSetArgs(captureOpenshell)).toEqual([
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "compatible-endpoint",
        "--model",
        "model-b",
      ],
    ]);
    expect(deps.calls.probeSandboxRoute).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({ credentialEnv: "COMPATIBLE_API_KEY" }),
    ]);
  });
});
