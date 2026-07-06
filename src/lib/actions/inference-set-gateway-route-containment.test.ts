// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SandboxEntry } from "../state/registry";
import { runInferenceSet } from "./inference-set";
import { createDeps } from "./inference-set.test-support";

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
});
