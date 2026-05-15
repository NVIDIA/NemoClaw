// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { OpenShellStateRpcIssue } from "../../adapters/openshell/gateway-drift";

type RebuildSandbox = typeof import("../../../../dist/lib/actions/sandbox/rebuild")["rebuildSandbox"];

const requireDist = createRequire(import.meta.url);

const driftIssue: OpenShellStateRpcIssue = {
  kind: "image_drift",
  drift: {
    containerName: "openshell-cluster-nemoclaw",
    currentImage: "ghcr.io/nvidia/openshell/cluster:0.0.36",
    currentVersion: "0.0.36",
    expectedVersion: "0.0.37",
  },
};

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
}

describe("rebuild gateway drift preflight", () => {
  let rebuildSandbox: RebuildSandbox;
  let exitSpy: ReturnType<typeof mockExit>;
  let errorSpy: MockInstance;
  let spies: MockInstance[];
  let checkAgentVersionSpy: MockInstance;
  let printIssueSpy: MockInstance;

  beforeEach(async () => {
    spies = [];
    exitSpy = mockExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const gatewayDrift = requireDist("../../../../dist/lib/adapters/openshell/gateway-drift.js");
    const registry = requireDist("../../../../dist/lib/state/registry.js");
    const resolve = requireDist("../../../../dist/lib/adapters/openshell/resolve.js");
    const sandboxSession = requireDist("../../../../dist/lib/state/sandbox-session.js");
    const sandboxVersion = requireDist("../../../../dist/lib/sandbox/version.js");

    printIssueSpy = vi
      .spyOn(gatewayDrift, "printOpenShellStateRpcIssue")
      .mockImplementation(() => undefined);
    checkAgentVersionSpy = vi
      .spyOn(sandboxVersion, "checkAgentVersion")
      .mockReturnValue({ expectedVersion: "0.1.0", sandboxVersion: "0.0.1" } as never);

    spies.push(
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(driftIssue),
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null),
      printIssueSpy,
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        provider: "nvidia-prod",
        model: "nvidia/nemotron",
        policies: [],
        nimContainer: null,
        agent: null,
      } as never),
      vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null),
      vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
        detected: false,
        sessions: [],
      }),
      checkAgentVersionSpy,
    );

    ({ rebuildSandbox } = requireDist("../../../../dist/lib/actions/sandbox/rebuild.js"));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails before version or liveness RPCs when gateway image drift is detected", async () => {
    await expect(rebuildSandbox("alpha", ["--yes"])).rejects.toThrow("process.exit(1)");

    expect(printIssueSpy).toHaveBeenCalledWith(
      driftIssue,
      expect.objectContaining({ command: "nemoclaw alpha rebuild" }),
    );
    expect(checkAgentVersionSpy).not.toHaveBeenCalled();
  });
});
