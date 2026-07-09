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
  return {
    suppressInferenceProbe: true,
    deps: {
      getSandbox: () =>
        entry
          ? ({ name: "alpha", agent: "openclaw", policies: [], ...entry } as SandboxEntry)
          : null,
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
    });
    expect(snapshot.currentProvider).toBe("openai");
    expect(snapshot.currentModel).toBe("gpt-5.2");
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
    });
    expect(snapshot.currentProvider).toBe("openai");
    expect(snapshot.currentModel).toBe("gpt-5.2");
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
  });
});
