// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getSandboxInventory,
  getStatusReport,
  listSandboxesCommand,
  showStatusCommand,
  type SandboxEntry,
} from "./index";

function deferredPolicyReads() {
  const releases = new Map<string, (policies: string[]) => void>();
  const getPolicyPresets = vi.fn(
    (sandboxName: string) =>
      new Promise<string[]>((resolve) => {
        releases.set(sandboxName, resolve);
      }),
  );
  return { getPolicyPresets, releases };
}

describe("inventory row behavior", () => {
  it("reads independent inventory policies concurrently while preserving sandbox order", async () => {
    const { getPolicyPresets, releases } = deferredPolicyReads();
    const pending = getSandboxInventory({
      recoverRegistryEntries: async () => ({
        sandboxes: [{ name: "alpha" }, { name: "beta" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      getPolicyPresets,
      loadLastSession: () => null,
    });

    await vi.waitFor(() => expect(getPolicyPresets).toHaveBeenCalledTimes(2));
    releases.get("beta")?.(["beta-policy"]);
    releases.get("alpha")?.(["alpha-policy"]);

    await expect(pending).resolves.toMatchObject({
      sandboxes: [
        { name: "alpha", policies: ["alpha-policy"] },
        { name: "beta", policies: ["beta-policy"] },
      ],
    });
  });

  it("reads independent status policies concurrently while preserving sandbox order", async () => {
    const { getPolicyPresets, releases } = deferredPolicyReads();
    const pending = getStatusReport({
      listSandboxes: () => ({
        sandboxes: [{ name: "alpha" }, { name: "beta" }],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => null,
      getPolicyPresets,
      showServiceStatus: vi.fn(),
    });

    await vi.waitFor(() => expect(getPolicyPresets).toHaveBeenCalledTimes(2));
    releases.get("beta")?.(["beta-policy"]);
    releases.get("alpha")?.(["alpha-policy"]);

    await expect(pending).resolves.toMatchObject({
      sandboxes: [
        { name: "alpha", policies: ["alpha-policy"] },
        { name: "beta", policies: ["beta-policy"] },
      ],
    });
  });

  it("redacts every public sandbox field", async () => {
    const secret = 'api_key="example-not-a-real-value-1"';
    const sandboxName = `alpha ${secret}`;
    const sandbox: SandboxEntry = {
      name: sandboxName,
      provider: `nvidia-prod ${secret}`,
      model: `nvidia/test ${secret}`,
      agent: `openclaw ${secret}`,
      openshellVersion: `0.0.110 ${secret}`,
      recoveredFromGateway: true,
      livePhase: `Ready ${secret}`,
    };
    const getPolicyPresets = () => [`pypi ${secret}`];
    const inventory = await getSandboxInventory({
      recoverRegistryEntries: async () => ({ sandboxes: [sandbox], defaultSandbox: sandboxName }),
      getLiveInference: () => null,
      getPolicyPresets,
      loadLastSession: () => null,
    });
    const status = await getStatusReport({
      listSandboxes: () => ({ sandboxes: [sandbox], defaultSandbox: sandboxName }),
      getLiveInference: () => null,
      getPolicyPresets,
      showServiceStatus: vi.fn(),
    });

    expect(inventory.sandboxes[0]).toMatchObject(status.sandboxes[0]!);
    expect(inventory.defaultSandbox).toBe(status.defaultSandbox);
    expect(JSON.stringify(inventory)).not.toContain("example-not-a-real-value-1");
  });

  it("redacts matching live gateway inference without reporting false drift", async () => {
    const lines: string[] = [];
    const secret = 'api_key="example-not-a-real-value-1"';
    await listSandboxesCommand({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          {
            name: "alpha",
            model: `configured-alpha ${secret}`,
            provider: `configured-provider ${secret}`,
            gpuEnabled: true,
          },
        ],
        defaultSandbox: "alpha",
      }),
      getLiveInference: () => ({
        provider: `configured-provider ${secret}`,
        model: `configured-alpha ${secret}`,
      }),
      loadLastSession: () => null,
      log: (message = "") => lines.push(message),
    });

    expect(lines.join("\n")).not.toContain("example-not-a-real-value-1");
    expect(lines.some((line) => line.includes("onboarded"))).toBe(false);
  });

  it("redacts sandbox and inference fields in global status text", async () => {
    const lines: string[] = [];
    const secret = 'api_key="example-not-a-real-value-1"';
    await showStatusCommand({
      listSandboxes: () => ({
        sandboxes: [
          {
            name: `alpha ${secret}`,
            model: `configured-model ${secret}`,
            provider: `configured-provider ${secret}`,
          },
        ],
        defaultSandbox: `alpha ${secret}`,
      }),
      getLiveInference: () => ({
        model: `live-model ${secret}`,
        provider: `live-provider ${secret}`,
      }),
      showServiceStatus: vi.fn(),
      log: (message = "") => lines.push(message),
    });

    expect(lines.join("\n")).not.toContain("example-not-a-real-value-1");
  });

  it("redacts completed and incomplete onboarding sandbox names", async () => {
    const secret = 'api_key="example-not-a-real-value-1"';
    const sandboxName = `alpha ${secret}`;
    const completed = await getSandboxInventory({
      recoverRegistryEntries: async () => ({ sandboxes: [], defaultSandbox: null }),
      getLiveInference: () => null,
      loadLastSession: () => ({ sandboxName, steps: { sandbox: { status: "complete" } } }),
    });
    const incomplete = await getSandboxInventory({
      recoverRegistryEntries: async () => ({
        sandboxes: [
          { name: sandboxName, pendingRouteReservation: true, reservationSessionId: "session" },
        ],
        defaultSandbox: sandboxName,
      }),
      getLiveInference: () => null,
      loadLastSession: () => ({
        sessionId: "session",
        sandboxName,
        status: "failed",
        resumable: true,
        failure: { step: "inference", interrupted: true },
      }),
    });
    const incompleteStatus = await getStatusReport({
      listSandboxes: () => ({
        sandboxes: [
          { name: sandboxName, pendingRouteReservation: true, reservationSessionId: "session" },
        ],
        defaultSandbox: sandboxName,
      }),
      getLiveInference: () => null,
      loadLastSession: () => ({
        sessionId: "session",
        sandboxName,
        status: "failed",
        resumable: true,
        failure: { step: "inference", interrupted: true },
      }),
      showServiceStatus: vi.fn(),
    });

    expect(completed.lastOnboardedSandbox).not.toContain("example-not-a-real-value-1");
    expect(incomplete.incompleteOnboarding?.name).not.toContain("example-not-a-real-value-1");
    expect(incompleteStatus.incompleteOnboarding).toEqual(incomplete.incompleteOnboarding);
    expect(JSON.stringify(incompleteStatus)).not.toContain("example-not-a-real-value-1");
  });
});
