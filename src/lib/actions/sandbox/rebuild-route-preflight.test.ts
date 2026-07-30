// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry, SandboxRegistry } from "../../state/registry/types";
import {
  commitRebuildRoutePreflight,
  type RebuildRoutePreflightReceipt,
  revalidateRebuildRouteBeforeDelete,
} from "./rebuild-preflight-guards";

const { LOCAL_INFERENCE_PROVIDERS, REMOTE_PROVIDER_CONFIG } =
  require("../../onboard/providers") as {
    LOCAL_INFERENCE_PROVIDERS: string[];
    REMOTE_PROVIDER_CONFIG: Record<
      string,
      {
        providerName: string;
        credentialEnv: string | null;
        endpointUrl?: string | null;
      }
    >;
  };

function sandbox(
  name: string,
  provider: string,
  overrides: Partial<SandboxEntry> = {},
): SandboxEntry {
  const custom = provider.includes("compatible");
  return {
    name,
    provider,
    model: "model-a",
    endpointUrl: custom ? "https://inference.example.test/v1" : null,
    preferredInferenceApi:
      provider === "compatible-anthropic-endpoint"
        ? "anthropic-messages"
        : custom
          ? "openai-completions"
          : null,
    credentialEnv: null,
    gatewayName: "nemoclaw",
    ...overrides,
  };
}

function registry(...entries: SandboxEntry[]): SandboxRegistry {
  return {
    sandboxes: Object.fromEntries(entries.map((entry) => [entry.name, entry])),
    defaultSandbox: entries[0]?.name ?? null,
  };
}

function transactionDependencies(initial: SandboxRegistry) {
  let persisted = structuredClone(initial);
  const save = vi.fn((next: SandboxRegistry) => {
    persisted = structuredClone(next);
  });
  return {
    dependencies: {
      withLock: <T>(fn: () => T): T => fn(),
      load: () => structuredClone(persisted),
      save,
    },
    persisted: () => persisted,
    save,
  };
}

function targetUpdate(entry: SandboxEntry): Partial<Omit<SandboxEntry, "name">> {
  return {
    provider: entry.provider,
    model: entry.model,
    endpointUrl: entry.endpointUrl,
    preferredInferenceApi: entry.preferredInferenceApi,
    credentialEnv: entry.credentialEnv,
  };
}

const remoteProviders = [
  ...Object.values(REMOTE_PROVIDER_CONFIG),
  {
    providerName: "nvidia-nim",
    credentialEnv: REMOTE_PROVIDER_CONFIG.build?.credentialEnv ?? null,
  },
].filter(
  (provider): provider is typeof provider & { credentialEnv: string } =>
    typeof provider.credentialEnv === "string" && provider.credentialEnv.length > 0,
);

describe("commitRebuildRoutePreflight", () => {
  it("includes a credential-bearing provider in the migration matrix (#7798)", () => {
    expect(remoteProviders.length).toBeGreaterThan(0);
  });

  it.each(
    remoteProviders,
  )("migrates missing shared-gateway credential identity for $providerName (#7798)", (providerConfig) => {
    const target = sandbox("target", providerConfig.providerName, {
      credentialEnv: providerConfig.credentialEnv,
    });
    const peer = sandbox("peer", providerConfig.providerName);
    const state = transactionDependencies(registry(target, peer));

    const result = commitRebuildRoutePreflight(
      {
        sandboxName: target.name,
        gatewayName: "nemoclaw",
        targetUpdate: targetUpdate(target),
      },
      state.dependencies,
    );

    expect(result).toMatchObject({
      ok: true,
      receipt: {
        migratedSandboxNames: ["peer"],
      },
    });
    expect(state.persisted().sandboxes.target?.credentialEnv).toBe(providerConfig.credentialEnv);
    expect(state.persisted().sandboxes.peer?.credentialEnv).toBe(providerConfig.credentialEnv);
    expect(state.save).toHaveBeenCalledOnce();
  });

  it("migrates two missing credential identities across sequential shared-route rebuilds (#7615, #7798)", () => {
    const credentialEnv = "NVIDIA_INFERENCE_API_KEY";
    const alpha = sandbox("alpha", "nvidia-prod");
    const beta = sandbox("beta", "nvidia-prod");
    const state = transactionDependencies(registry(alpha, beta));

    const results = [alpha, beta].map((entry) =>
      commitRebuildRoutePreflight(
        {
          sandboxName: entry.name,
          gatewayName: "nemoclaw",
          targetUpdate: targetUpdate({ ...entry, credentialEnv }),
        },
        state.dependencies,
      ),
    );

    expect(results).toMatchObject([
      { ok: true, receipt: { sandboxName: "alpha", migratedSandboxNames: ["beta"] } },
      { ok: true, receipt: { sandboxName: "beta", migratedSandboxNames: [] } },
    ]);
    expect(
      [alpha.name, beta.name].map(
        (sandboxName) => state.persisted().sandboxes[sandboxName]?.credentialEnv,
      ),
    ).toEqual([credentialEnv, credentialEnv]);
    expect(state.save).toHaveBeenCalledTimes(2);
  });

  it.each(
    LOCAL_INFERENCE_PROVIDERS,
  )("keeps credential-free local provider %s compatible (#7798)", (provider) => {
    const target = sandbox("target", provider);
    const peer = sandbox("peer", provider);
    const state = transactionDependencies(registry(target, peer));

    const result = commitRebuildRoutePreflight(
      {
        sandboxName: target.name,
        gatewayName: "nemoclaw",
        targetUpdate: targetUpdate(target),
      },
      state.dependencies,
    );

    expect(result).toMatchObject({
      ok: true,
      receipt: { migratedSandboxNames: [] },
    });
    expect(state.persisted().sandboxes.peer?.credentialEnv).toBeNull();
  });

  it("keeps credential-free routed inference compatible (#7798)", () => {
    const target = sandbox("target", "nvidia-router");
    const peer = sandbox("peer", "nvidia-router");
    const state = transactionDependencies(registry(target, peer));

    const result = commitRebuildRoutePreflight(
      {
        sandboxName: target.name,
        gatewayName: "nemoclaw",
        targetUpdate: targetUpdate(target),
      },
      state.dependencies,
    );

    expect(result).toMatchObject({
      ok: true,
      receipt: { migratedSandboxNames: [] },
    });
  });

  it("does not replace an explicit conflicting credential identity (#7798)", () => {
    const target = sandbox("target", "nvidia-prod", {
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    const peer = sandbox("peer", "nvidia-prod", { credentialEnv: "OPENAI_API_KEY" });
    const state = transactionDependencies(registry(target, peer));

    const result = commitRebuildRoutePreflight(
      {
        sandboxName: target.name,
        gatewayName: "nemoclaw",
        targetUpdate: targetUpdate(target),
      },
      state.dependencies,
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.message).toContain("credential identity");
    expect(state.save).not.toHaveBeenCalled();
  });

  it("does not migrate peers when the target gateway binding changed (#7798)", () => {
    const target = sandbox("target", "nvidia-prod", {
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });
    const peer = sandbox("peer", "nvidia-prod");
    const state = transactionDependencies(registry(target, peer));

    const result = commitRebuildRoutePreflight(
      {
        sandboxName: target.name,
        gatewayName: "nemoclaw",
        targetUpdate: targetUpdate(target),
      },
      state.dependencies,
    );

    expect(result).toEqual({
      ok: false,
      message: "Sandbox gateway binding changed during rebuild route preflight.",
    });
    expect(state.save).not.toHaveBeenCalled();
  });

  it("does not hide a custom endpoint conflict while migrating credentials (#7798)", () => {
    const target = sandbox("target", "compatible-endpoint", {
      credentialEnv: "COMPATIBLE_API_KEY",
    });
    const peer = sandbox("peer", "compatible-endpoint", {
      endpointUrl: "https://other.example.test/v1",
    });
    const state = transactionDependencies(registry(target, peer));

    const result = commitRebuildRoutePreflight(
      {
        sandboxName: target.name,
        gatewayName: "nemoclaw",
        targetUpdate: targetUpdate(target),
      },
      state.dependencies,
    );

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.message).toContain("endpoint");
    expect(state.save).not.toHaveBeenCalled();
  });

  it("migrates stopped peers and leaves another gateway untouched (#7798)", () => {
    const target = sandbox("target", "nvidia-prod", {
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    const stoppedPeer = sandbox("stopped-peer", "nvidia-prod");
    const otherGateway = sandbox("other-gateway", "nvidia-prod", {
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });
    const state = transactionDependencies(registry(target, stoppedPeer, otherGateway));

    const result = commitRebuildRoutePreflight(
      {
        sandboxName: target.name,
        gatewayName: "nemoclaw",
        targetUpdate: targetUpdate(target),
      },
      state.dependencies,
    );

    expect(result).toMatchObject({
      ok: true,
      receipt: { migratedSandboxNames: ["stopped-peer"] },
    });
    expect(state.persisted().sandboxes["stopped-peer"]?.credentialEnv).toBe(
      "NVIDIA_INFERENCE_API_KEY",
    );
    expect(state.persisted().sandboxes["other-gateway"]?.credentialEnv).toBeNull();
  });
});

describe("revalidateRebuildRouteBeforeDelete", () => {
  function receipt(route: SandboxEntry): RebuildRoutePreflightReceipt {
    return {
      sandboxName: route.name,
      gatewayName: "nemoclaw",
      route: targetUpdate(route),
      migratedSandboxNames: ["peer"],
    };
  }

  it("accepts the unchanged migrated shared route (#7798)", () => {
    const target = sandbox("target", "nvidia-prod", {
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    const peer = sandbox("peer", "nvidia-prod", {
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });

    expect(
      revalidateRebuildRouteBeforeDelete(receipt(target), {
        load: () => registry(target, peer),
      }),
    ).toMatchObject({ ok: true });
  });

  it("blocks deletion when a peer credential identity drifts after preflight (#7798)", () => {
    const target = sandbox("target", "nvidia-prod", {
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    const peer = sandbox("peer", "nvidia-prod", { credentialEnv: "OPENAI_API_KEY" });

    const result = revalidateRebuildRouteBeforeDelete(receipt(target), {
      load: () => registry(target, peer),
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.message).toContain("credential identity");
  });

  it("blocks deletion when the target route drifts after preflight (#7798)", () => {
    const target = sandbox("target", "nvidia-prod", {
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    const drifted = { ...target, model: "changed-model" };

    expect(
      revalidateRebuildRouteBeforeDelete(receipt(target), {
        load: () => registry(drifted),
      }),
    ).toEqual({
      ok: false,
      message: "Sandbox inference route changed before sandbox deletion.",
    });
  });
});
