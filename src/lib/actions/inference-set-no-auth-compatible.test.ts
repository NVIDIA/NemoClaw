// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxEntry } from "../state/registry";
import { runInferenceSet } from "./inference-set";
import {
  baseSession,
  createCompatibleProviderCapture,
  createDeps,
  nativeLocalTestReceipt,
} from "./inference-set.test-support";

const CONFIG = {
  agents: { defaults: { model: { primary: "inference/model-a" } } },
  models: { providers: { inference: { api: "openai-completions", models: [] } } },
};
const NO_AUTH_ENDPOINT_URL = "http://127.0.0.1:11434/v1";
const NO_AUTH_CREDENTIAL_ENV = "NEMOCLAW_OLLAMA_PROXY_TOKEN";
function noAuthEntry() {
  return {
    name: "alpha",
    agent: "openclaw",
    provider: "compatible-endpoint",
    model: "model-a",
    endpointUrl: NO_AUTH_ENDPOINT_URL,
    endpointSource: "onboard" as const,
    credentialEnv: NO_AUTH_CREDENTIAL_ENV,
    preferredInferenceApi: "openai-completions" as const,
  };
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
function inferenceSetArgs(capture: ReturnType<typeof noAuthProviderCapture>) {
  return capture.mock.calls
    .filter(([args]) => args[0] === "inference" && args[1] === "set")
    .map(([args]) => args);
}
function providerMutationArgs(capture: ReturnType<typeof noAuthProviderCapture>) {
  return capture.mock.calls
    .filter(([args]) => args[0] === "provider" && ["create", "update"].includes(args[1]))
    .map(([args]) => args);
}

describe("inference selection for existing no-auth endpoints", () => {
  it("requires recreation before migrating a beta sandbox's local route (#12558)", async () => {
    const deps = createDeps({
      config: CONFIG,
      entry: noAuthEntry(),
      session: baseSession(noAuthEntry()),
    });
    await expect(
      runInferenceSet({ provider: "compatible-endpoint", model: "model-b" }, deps),
    ).rejects.toThrow("Recreate this beta sandbox");
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });
  it("reuses native custody for model changes without reading the host credential (#12558)", async () => {
    const receipt = nativeLocalTestReceipt("compatible-endpoint");
    const entry = { ...noAuthEntry(), nativeLocalProviderAttachment: receipt };
    const deps = createDeps({
      config: structuredClone(CONFIG),
      entry,
      session: baseSession(entry),
    });
    const prepare = vi.spyOn(deps, "prepareNativeLocalSwitch");
    const resolve = vi.spyOn(deps, "resolveCredentialValue");
    await runInferenceSet({ provider: "compatible-endpoint", model: "model-b" }, deps);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ previous: receipt, binding: null }),
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(deps.calls.captureOpenshell.mock.calls.some(([args]) => args[0] === "inference")).toBe(
      false,
    );
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "model-b",
        nativeLocalProviderAttachment: expect.objectContaining({ providerId: receipt.providerId }),
      }),
    );
  });
  it("does not fall back to the managed route when native inference fails (#12558)", async () => {
    const entry = {
      ...noAuthEntry(),
      nativeLocalProviderAttachment: nativeLocalTestReceipt("compatible-endpoint"),
    };
    const deps = createDeps({
      config: structuredClone(CONFIG),
      entry,
      session: baseSession(entry),
      probeSandboxRoute: async () => ({ ok: false, detail: "native rejected", httpStatus: 401 }),
    });
    await expect(
      runInferenceSet({ provider: "compatible-endpoint", model: "model-b" }, deps),
    ).rejects.toThrow("native rejected");
    expect(deps.calls.captureOpenshell.mock.calls.some(([args]) => args[0] === "inference")).toBe(
      false,
    );
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });
  it("rejects an explicit credential binding that differs from recorded no-auth ownership (#12558)", async () => {
    const entry = {
      ...noAuthEntry(),
      nativeLocalProviderAttachment: nativeLocalTestReceipt("compatible-endpoint"),
    };
    const deps = createDeps({
      config: structuredClone(CONFIG),
      entry,
      session: baseSession(entry),
    });
    const prepare = vi.spyOn(deps, "prepareNativeLocalSwitch");
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "model-b",
          endpointUrl: NO_AUTH_ENDPOINT_URL,
          credentialEnv: "FOREIGN_TOKEN",
        },
        deps,
      ),
    ).rejects.toThrow(/credential/);
    expect(prepare).not.toHaveBeenCalled();
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
    expect(
      deps.calls.updateSandbox.mock.calls
        .filter(([, fields]) => fields.provider !== undefined)
        .at(-1),
    ).toEqual(["alpha", expect.objectContaining({ credentialEnv: "COMPATIBLE_API_KEY" })]);
  });
});
