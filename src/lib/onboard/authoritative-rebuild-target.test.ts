// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AuthoritativeRebuildTargetDeps,
  preflightAuthoritativeRebuildTarget,
} from "./authoritative-rebuild-target";

const target = {
  sandboxName: "alpha",
  provider: "nvidia-prod",
  model: "nvidia/nemotron",
  targetGatewayName: "nemoclaw-12345",
  controlUiPort: 18789,
};
const originalGateway = process.env.OPENSHELL_GATEWAY;

function deps(overrides: Partial<AuthoritativeRebuildTargetDeps> = {}) {
  return {
    runFatalRuntimePreflight: vi.fn(),
    ensureOpenshell: vi.fn(),
    inferenceRouteReady: vi.fn(() => true),
    captureForwardList: vi.fn(() => "alpha 127.0.0.1 18789 42 active"),
    checkPort: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } satisfies AuthoritativeRebuildTargetDeps;
}

afterEach(() => {
  if (originalGateway === undefined) delete process.env.OPENSHELL_GATEWAY;
  else process.env.OPENSHELL_GATEWAY = originalGateway;
});

describe("authoritative rebuild target preflight", () => {
  it("pins the requested gateway for route and forward checks, then restores it", async () => {
    process.env.OPENSHELL_GATEWAY = "before";
    const seen: string[] = [];
    const checkPort = vi.fn();
    await preflightAuthoritativeRebuildTarget(
      target,
      deps({
        inferenceRouteReady: vi.fn(() => {
          seen.push(`route:${process.env.OPENSHELL_GATEWAY}`);
          return true;
        }),
        captureForwardList: vi.fn(() => {
          seen.push(`forward:${process.env.OPENSHELL_GATEWAY}`);
          return "alpha 127.0.0.1 18789 42 active";
        }),
        checkPort,
      }),
    );

    expect(seen).toEqual(["route:nemoclaw-12345", "forward:nemoclaw-12345"]);
    expect(checkPort).not.toHaveBeenCalled();
    expect(process.env.OPENSHELL_GATEWAY).toBe("before");
  });

  it("rejects an exact provider/model route mismatch", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({ inferenceRouteReady: vi.fn(() => false) }),
      ),
    ).rejects.toThrow("inference route does not match");
  });

  it("rejects a dashboard forward owned by another sandbox", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({ captureForwardList: vi.fn(() => "beta 127.0.0.1 18789 42 active") }),
      ),
    ).rejects.toThrow("belongs to sandbox 'beta'");
  });

  it("rejects an occupied dashboard port with no OpenShell owner", async () => {
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({
          captureForwardList: vi.fn(() => ""),
          checkPort: vi.fn(async () => ({ ok: false, process: "node", pid: 99, reason: "" })),
        }),
      ),
    ).rejects.toThrow("occupied by node (PID 99)");
  });

  it("restores gateway scope when a fatal runtime check throws", async () => {
    process.env.OPENSHELL_GATEWAY = "before";
    await expect(
      preflightAuthoritativeRebuildTarget(
        target,
        deps({
          runFatalRuntimePreflight: vi.fn(() => {
            throw new Error("fatal runtime gate");
          }),
        }),
      ),
    ).rejects.toThrow("fatal runtime gate");
    expect(process.env.OPENSHELL_GATEWAY).toBe("before");
  });
});
