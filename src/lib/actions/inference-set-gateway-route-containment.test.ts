// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ConfigObject } from "../security/credential-filter";
import type { SandboxEntry } from "../state/registry";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps, HERMES_TARGET } from "./inference-set.test-support";

const entry = (name: string, overrides: Partial<SandboxEntry> = {}): SandboxEntry => ({
  name,
  agent: "openclaw",
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  provider: "nvidia-prod",
  model: "nvidia/model-a",
  ...overrides,
});

describe("runtime shared gateway route containment", () => {
  it("rejects a same-gateway conflict before OpenShell, config, or registry mutation (#6315)", async () => {
    const deps = createDeps({
      config: {},
      entries: [entry("alpha"), entry("stopped-peer")],
      defaultSandbox: "alpha",
    });

    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-b", sandboxName: "alpha" },
        deps,
      ),
    ).rejects.toThrow("stopped-peer");

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.readSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.updateSession).not.toHaveBeenCalled();
    expect(deps.calls.appendAuditEntry).not.toHaveBeenCalled();
  });

  it("targets the selected sandbox gateway and allows a conflicting route elsewhere (#6315)", async () => {
    const deps = createDeps({
      config: {},
      entries: [
        entry("alpha", { gatewayName: "nemoclaw-9090", gatewayPort: 9090 }),
        entry("default-gateway-peer"),
      ],
      defaultSandbox: "alpha",
      contextWindow: 32_768,
    });

    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-b", sandboxName: "alpha" },
        deps,
      ),
    ).resolves.toMatchObject({ sandboxName: "alpha", model: "nvidia/model-b" });

    expect(deps.calls.captureOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw-9090",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/model-b",
      ],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("blocks a custom endpoint conflict before DNS validation or mutation (#6315)", async () => {
    const deps = createDeps({
      config: {},
      entries: [
        entry("alpha", {
          provider: "compatible-endpoint",
          model: "custom/model",
          endpointUrl: "https://alpha.example.test/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: "openai-completions",
        }),
        entry("custom-peer", {
          provider: "compatible-endpoint",
          model: "custom/model",
          endpointUrl: "https://peer.example.test/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: "openai-completions",
        }),
      ],
      defaultSandbox: "alpha",
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "custom/model",
          sandboxName: "alpha",
          endpointUrl: "https://alpha.example.test/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("custom-peer");

    expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.readSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("blocks an incomplete legacy custom target even without a peer (#6315)", async () => {
    const deps = createDeps({
      config: {},
      entries: [
        entry("alpha", {
          provider: "compatible-endpoint",
          model: "custom/model",
          endpointUrl: null,
          preferredInferenceApi: null,
        }),
      ],
      defaultSandbox: "alpha",
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "custom/model",
          sandboxName: "alpha",
        },
        deps,
      ),
    ).rejects.toThrow("requested custom route lacks durable endpoint or API-family metadata");

    expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.readSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("scopes Hermes provider inspection and route mutation to a non-default gateway", async () => {
    const config: ConfigObject = { model: {} };
    const deps = createDeps({
      config,
      entry: {
        name: "hermes",
        agent: "hermes",
        gatewayName: "nemoclaw-9090",
        gatewayPort: 9090,
        provider: "compatible-anthropic-endpoint",
        model: "old-model",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({ agent: "hermes", sandboxName: "hermes" }),
    });
    deps.calls.captureOpenshell.mockImplementation((args: string[]) =>
      args[0] === "provider"
        ? {
            status: 0,
            output:
              "Name: compatible-anthropic-endpoint\nType: openai\nCredential keys: COMPATIBLE_ANTHROPIC_API_KEY\nConfig keys: OPENAI_BASE_URL",
            stdout: "",
            stderr: "",
          }
        : { status: 0, output: "", stdout: "", stderr: "" },
    );

    await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "new-model",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    expect(deps.calls.captureOpenshell).toHaveBeenCalledWith(
      ["provider", "get", "-g", "nemoclaw-9090", "compatible-anthropic-endpoint"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(deps.calls.captureOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw-9090",
        "--provider",
        "compatible-anthropic-endpoint",
        "--model",
        "new-model",
        "--no-verify",
      ],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("blocks a stopped legacy Hermes Anthropic route before gateway inspection", async () => {
    const deps = createDeps({
      config: { model: {} },
      entries: [
        entry("hermes", { agent: "hermes", provider: "hermes-provider", model: "old-model" }),
        entry("stopped-hermes-peer", {
          agent: "hermes",
          provider: "compatible-anthropic-endpoint",
          model: "new-model",
          endpointUrl: "https://anthropic-compatible.example/v1",
          credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
          preferredInferenceApi: "anthropic-messages",
        }),
      ],
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({
        agent: "hermes",
        sandboxName: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "new-model",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-anthropic-endpoint",
          model: "new-model",
          sandboxName: "hermes",
        },
        deps,
      ),
    ).rejects.toThrow("stopped-hermes-peer");

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.readSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });
});
