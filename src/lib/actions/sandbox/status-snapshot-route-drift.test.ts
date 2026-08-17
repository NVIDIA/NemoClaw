// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../adapters/openshell/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../adapters/openshell/runtime")>();
  return { ...actual, captureOpenshellForStatus: vi.fn() };
});

import { captureOpenshellForStatus } from "../../adapters/openshell/runtime";
import type { SandboxEntry } from "../../state/registry";
import { collectSandboxStatusSnapshot } from "./status-snapshot";

const capture = vi.mocked(captureOpenshellForStatus);

function liveGatewayInference(provider: string, model: string, gatewayName = "nemoclaw"): void {
  capture.mockImplementation(async (args) =>
    args.join("\0") === ["inference", "get", "-g", gatewayName].join("\0")
      ? ({
          status: 0,
          output: `Gateway inference:\n  Provider: ${provider}\n  Model: ${model}\n`,
        } as Awaited<ReturnType<typeof captureOpenshellForStatus>>)
      : ({ status: 1, output: "" } as Awaited<ReturnType<typeof captureOpenshellForStatus>>),
  );
}

function snapshotDeps(entry: Partial<SandboxEntry> | null) {
  const sandbox = entry
    ? ({ name: "alpha", agent: "openclaw", policies: [], ...entry } as SandboxEntry)
    : null;
  return {
    suppressInferenceProbe: true,
    deps: {
      getSandbox: () => sandbox,
      listSandboxes: () => ({
        sandboxes: sandbox ? [sandbox] : [],
        defaultSandbox: sandbox ? sandbox.name : null,
      }),
      reconcile: async () => ({ state: "present", output: "Phase: Ready" }),
    },
  };
}

describe("collectSandboxStatusSnapshot route drift", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports drift when the live gateway route differs from the recorded route (#6315)", async () => {
    liveGatewayInference("openai", "gpt-5.2");

    const snapshot = await collectSandboxStatusSnapshot(
      "alpha",
      snapshotDeps({ provider: "nvidia", model: "nvidia/nemotron" }),
    );

    expect(snapshot.routeDrift).toEqual({
      live: { provider: "openai", model: "gpt-5.2" },
      recorded: { provider: "nvidia", model: "nvidia/nemotron" },
      canConnect: true,
    });
    expect(snapshot.liveRoute).toEqual({ provider: "openai", model: "gpt-5.2" });
    expect(snapshot.recordedRoute).toEqual({ provider: "nvidia", model: "nvidia/nemotron" });
    expect(snapshot.currentProvider).toBe("nvidia");
    expect(snapshot.currentModel).toBe("nvidia/nemotron");
  });

  it("reads the sandbox's non-default gateway before computing drift (#6315)", async () => {
    liveGatewayInference("openai", "gpt-5.2", "nemoclaw-9090");

    const snapshot = await collectSandboxStatusSnapshot(
      "alpha",
      snapshotDeps({
        gatewayPort: 9090,
        provider: "nvidia",
        model: "nvidia/nemotron",
      }),
    );

    expect(snapshot.routeDrift).toEqual({
      live: { provider: "openai", model: "gpt-5.2" },
      recorded: { provider: "nvidia", model: "nvidia/nemotron" },
      canConnect: true,
    });
    expect(snapshot.currentProvider).toBe("nvidia");
    expect(snapshot.currentModel).toBe("nvidia/nemotron");
  });

  it("does not fall back to the default gateway for an invalid persisted binding (#6315)", async () => {
    liveGatewayInference("openai", "gpt-5.2");

    const snapshot = await collectSandboxStatusSnapshot(
      "alpha",
      snapshotDeps({
        gatewayPort: 0,
        provider: "nvidia",
        model: "nvidia/nemotron",
      }),
    );

    expect(snapshot.routeDrift).toBeNull();
    expect(snapshot.currentProvider).toBe("nvidia");
    expect(snapshot.currentModel).toBe("nvidia/nemotron");
  });

  it("reports no drift when the live route matches the recorded route (#6315)", async () => {
    liveGatewayInference("nvidia", "nvidia/nemotron");

    const snapshot = await collectSandboxStatusSnapshot(
      "alpha",
      snapshotDeps({ provider: "nvidia", model: "nvidia/nemotron" }),
    );

    expect(snapshot.routeDrift).toBeNull();
  });

  it("reports no drift when the live route is unreadable — repair, not divergence (#6315)", async () => {
    capture.mockResolvedValue({
      status: 1,
      output: "",
    } as Awaited<ReturnType<typeof captureOpenshellForStatus>>);

    const snapshot = await collectSandboxStatusSnapshot(
      "alpha",
      snapshotDeps({ provider: "nvidia", model: "nvidia/nemotron" }),
    );

    expect(snapshot.routeDrift).toBeNull();
    expect(snapshot.currentProvider).toBe("nvidia");
    expect(snapshot.currentModel).toBe("nvidia/nemotron");
  });

  it("reports no drift when the registry entry has no recorded route (#6315)", async () => {
    liveGatewayInference("openai", "gpt-5.2");

    const snapshot = await collectSandboxStatusSnapshot("alpha", snapshotDeps({}));

    expect(snapshot.routeDrift).toBeNull();
    expect(snapshot.currentProvider).toBe("unknown");
    expect(snapshot.currentModel).toBe("unknown");
  });

  it("does not mix partial recorded metadata with the live route (#6315)", async () => {
    liveGatewayInference("openai", "gpt-5.2");

    const snapshot = await collectSandboxStatusSnapshot(
      "alpha",
      snapshotDeps({ provider: "nvidia" }),
    );

    expect(snapshot.routeDrift).toBeNull();
    expect(snapshot.currentProvider).toBe("nvidia");
    expect(snapshot.currentModel).toBe("unknown");
  });

  it("does not advertise connect for a legacy custom-provider identity conflict (#6315)", async () => {
    liveGatewayInference("compatible-endpoint", "live/model");
    const target = {
      provider: "compatible-endpoint",
      model: "recorded/model",
      endpointUrl: "https://target.example/v1",
      credentialEnv: "TARGET_KEY",
      preferredInferenceApi: "openai-completions",
    } satisfies Partial<SandboxEntry>;
    const peer: SandboxEntry = {
      name: "peer",
      gatewayName: "nemoclaw",
      provider: "compatible-endpoint",
      model: "peer/model",
      endpointUrl: "https://peer.example/v1",
      credentialEnv: "PEER_KEY",
      preferredInferenceApi: "openai-completions",
    };
    const options = snapshotDeps(target);
    options.deps.listSandboxes = () => ({
      sandboxes: [options.deps.getSandbox() as SandboxEntry, peer],
      defaultSandbox: "alpha",
    });

    const snapshot = await collectSandboxStatusSnapshot("alpha", options);

    expect(snapshot.routeDrift).toMatchObject({ canConnect: false });
  });
});

describe("collectSandboxStatusSnapshot inference invocation route (#9302)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Capture the route the in-sandbox invocation probe is asked to exercise.
   * The probe reports the health that decides `status --json`'s exit code.
   */
  async function captureInvocationRoute(
    entry: Partial<SandboxEntry>,
  ): Promise<Record<string, unknown> | null> {
    let seen: Record<string, unknown> | null = null;
    const sandbox = {
      name: "alpha",
      agent: "openclaw",
      policies: [],
      gatewayName: "nemoclaw",
      ...entry,
    } as SandboxEntry;
    await collectSandboxStatusSnapshot("alpha", {
      deps: {
        getSandbox: () => sandbox,
        listSandboxes: () => ({ sandboxes: [sandbox], defaultSandbox: "alpha" }),
        reconcile: async () => ({ state: "present", output: "Phase: Ready" }),
        probeProviderHealthImpl: () => null,
        probeSandboxInferenceGatewayHealthImpl: async () => ({
          ok: true,
          endpoint: "https://inference.local/v1/models",
          detail: "reachable",
          httpStatus: 200,
        }),
        probeSandboxInferenceInvocationImpl: (input: Record<string, unknown>) => {
          seen = input;
          return { ok: true };
        },
      },
    } as never);
    return seen;
  }

  const recorded = {
    provider: "compatible-endpoint",
    model: "recorded/model",
    endpointUrl: "https://target.example/v1",
    credentialEnv: "TARGET_KEY",
    preferredInferenceApi: "openai-responses",
  } satisfies Partial<SandboxEntry>;

  it("keeps the recorded API family when only the model drifted", async () => {
    // The recorded family describes the provider, which has not changed, so
    // dropping it would probe /v1/chat/completions against a responses-only
    // endpoint and report a healthy route as unhealthy.
    liveGatewayInference("compatible-endpoint", "live/model");

    expect(await captureInvocationRoute(recorded)).toMatchObject({
      provider: "compatible-endpoint",
      model: "live/model",
      preferredInferenceApi: "openai-responses",
    });
  });

  it("keeps the recorded API family when the route is aligned", async () => {
    liveGatewayInference("compatible-endpoint", "recorded/model");

    expect(await captureInvocationRoute(recorded)).toMatchObject({
      model: "recorded/model",
      preferredInferenceApi: "openai-responses",
    });
  });

  it("drops the recorded API family when the provider itself drifted", async () => {
    // Regression lock: one provider's family must never be carried onto
    // another that may have no such endpoint.
    liveGatewayInference("nvidia-prod", "nvidia/nemotron");

    expect(await captureInvocationRoute(recorded)).toMatchObject({
      provider: "nvidia-prod",
      model: "nvidia/nemotron",
      preferredInferenceApi: null,
    });
  });
});
