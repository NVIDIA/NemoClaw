// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withGatewayRouteMutationLock } from "../inference/gateway-route-mutation-lock";
import type { ConfigObject } from "../security/credential-filter";
import type { SandboxEntry } from "../state/registry";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps, HERMES_TARGET } from "./inference-set.test-support";
import {
  finalizeInferenceSetRoute,
  prepareInferenceSetRoute,
} from "./inference-set-route-containment";

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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects an ambient gateway endpoint before OpenShell prep or state mutation", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.example.test");
    const deps = createDeps({
      config: {},
      entries: [entry("alpha")],
      defaultSandbox: "alpha",
    });

    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-b", sandboxName: "alpha" },
        deps,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Unset OPENSHELL_GATEWAY_ENDPOINT"),
      exitCode: 2,
    });

    expect(deps.calls.prepareRunOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
    expect(deps.calls.readSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.recomputeSandboxConfigHash).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.updateSession).not.toHaveBeenCalled();
    expect(deps.calls.appendAuditEntry).not.toHaveBeenCalled();
  });

  it("rejects a pending onboarding route reservation before any mutation", async () => {
    const deps = createDeps({
      config: {},
      entries: [entry("alpha", { pendingRouteReservation: true })],
      defaultSandbox: "alpha",
    });

    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-b", sandboxName: "alpha" },
        deps,
      ),
    ).rejects.toThrow("still being created by onboarding");

    expect(deps.calls.prepareRunOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

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

  it("aborts before mutation when the target changes gateways while waiting", async () => {
    const alpha = entry("alpha");
    const deps = createDeps({
      config: {},
      entries: [alpha],
      defaultSandbox: alpha.name,
      withGatewayRouteMutationLock: async (gatewayName, operation) => {
        expect(gatewayName).toBe("nemoclaw");
        Object.assign(alpha, { gatewayName: "nemoclaw-9090", gatewayPort: 9090 });
        return await operation();
      },
    });

    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-b", sandboxName: alpha.name },
        deps,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("moved from OpenShell gateway 'nemoclaw'"),
      exitCode: 2,
    });

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
    expect(deps.calls.readSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.updateSession).not.toHaveBeenCalled();
    expect(deps.calls.appendAuditEntry).not.toHaveBeenCalled();
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

  it("refreshes peers after async endpoint validation before route mutation (#6315)", async () => {
    const alpha = entry("alpha");
    const peer = entry("late-peer", {
      provider: "compatible-endpoint",
      model: "custom/model",
      endpointUrl: "https://peer.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
    const deps = createDeps({ config: {}, entries: [alpha], defaultSandbox: "alpha" });
    const listSandboxes = vi
      .fn()
      .mockReturnValueOnce({ sandboxes: [alpha], defaultSandbox: "alpha" })
      .mockReturnValue({ sandboxes: [alpha, peer], defaultSandbox: "alpha" });
    deps.listSandboxes = listSandboxes;

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
    ).rejects.toThrow("late-peer");

    expect(listSandboxes).toHaveBeenCalledTimes(2);
    expect(deps.calls.rewriteConfigUrlsWithDnsPinning).toHaveBeenCalledOnce();
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.readSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks a DNS-normalized endpoint before route mutation (#6315)", async () => {
    const customRoute = {
      provider: "compatible-endpoint",
      model: "custom/model",
      endpointUrl: "http://public.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    } as const;
    const deps = createDeps({
      config: {},
      entries: [entry("alpha", customRoute), entry("custom-peer", customRoute)],
      defaultSandbox: "alpha",
      rewriteConfigUrlsWithDnsPinning: async (value) =>
        typeof value === "string" ? "http://203.0.113.10/v1" : value,
    });

    await expect(
      runInferenceSet(
        {
          ...customRoute,
          sandboxName: "alpha",
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("custom-peer");

    expect(deps.calls.rewriteConfigUrlsWithDnsPinning).toHaveBeenCalledOnce();
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.readSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("catches a DNS change between the preliminary and finalized gateway route checks", async () => {
    const firstEndpoint = "https://first.example.test/v1";
    const secondEndpoint = "https://second.example.test/v1";
    const customRoute = {
      provider: "compatible-endpoint",
      model: "custom/model",
      endpointUrl: firstEndpoint,
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    } as const;
    const alpha = entry("alpha", customRoute);
    const peer = entry("custom-peer", customRoute);
    const prepared = prepareInferenceSetRoute({
      entry: alpha,
      sandboxName: alpha.name,
      provider: customRoute.provider,
      model: customRoute.model,
      customRoute: {
        endpointUrl: firstEndpoint,
        credentialEnv: customRoute.credentialEnv,
        inferenceApi: customRoute.preferredInferenceApi,
      },
      session: null,
      sandboxes: [alpha, peer],
    });
    const rewriteUrlWithDnsPinning = vi.fn().mockResolvedValueOnce(secondEndpoint);

    await expect(
      finalizeInferenceSetRoute({
        prepared,
        sandboxName: alpha.name,
        provider: customRoute.provider,
        model: customRoute.model,
        canReuseRecordedRoute: false,
        getSandboxes: () => [alpha, peer],
        rewriteUrlWithDnsPinning,
      }),
    ).rejects.toThrow("custom-peer");

    expect(rewriteUrlWithDnsPinning).toHaveBeenCalledOnce();
    expect(rewriteUrlWithDnsPinning).toHaveBeenCalledWith(firstEndpoint);
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

  it("serializes same-gateway mutations and rejects a conflicting write", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-route-lock-"));
    try {
      const entries = [entry("route-lock-alpha"), entry("route-lock-beta")];
      const deps = createDeps({
        config: { agents: { defaults: { model: {} } } },
        entries,
        withGatewayRouteMutationLock: (gatewayName, operation) =>
          withGatewayRouteMutationLock(gatewayName, operation, {
            stateDir,
            pollIntervalMs: 1,
            timeoutMs: 5_000,
          }),
      });
      deps.calls.updateSandbox.mockImplementation(
        (sandboxName: string, updates: Partial<SandboxEntry>) => {
          const target = entries.find((candidate) => candidate.name === sandboxName);
          expect(target).toBeDefined();
          Object.assign(target!, updates);
          return true;
        },
      );

      const results = await Promise.allSettled([
        runInferenceSet(
          { provider: "nvidia-prod", model: "nvidia/model-a", sandboxName: entries[0].name },
          deps,
        ),
        runInferenceSet(
          { provider: "anthropic-prod", model: "claude-new", sandboxName: entries[1].name },
          deps,
        ),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(
        deps.calls.captureOpenshell.mock.calls.filter(
          ([args]) => args[0] === "inference" && args[1] === "set",
        ),
      ).toHaveLength(1);
      expect(entries).toEqual([
        expect.objectContaining({ provider: "nvidia-prod", model: "nvidia/model-a" }),
        expect.objectContaining({ provider: "nvidia-prod", model: "nvidia/model-a" }),
      ]);
      expect(deps.calls.withGatewayRouteMutationLock).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
