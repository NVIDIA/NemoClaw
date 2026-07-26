// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  livePolicy: "",
  run: vi.fn(),
  runCapture: vi.fn(),
}));

vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  run: harness.run,
  runCapture: harness.runCapture,
}));

vi.mock("../adapters/openshell/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/resolve")>()),
  resolveOpenshell: vi.fn(() => "/usr/bin/openshell"),
}));

const originalHome = process.env.HOME;
const temporaryHomes: string[] = [];

afterEach(() => {
  process.env.HOME = originalHome;
  vi.restoreAllMocks();
  vi.resetModules();
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("baseline exclusion journal integration", () => {
  it("reloads and finalizes a real persisted journal after interrupted commit (#7178)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-baseline-journal-"));
    temporaryHomes.push(home);
    process.env.HOME = home;
    vi.resetModules();

    const registry = await import("../state/registry");
    const baseline = await import("./baseline-exclusion");
    const policy = await import("./index");
    registry.registerSandbox({
      name: "alpha",
      agent: "hermes",
      gatewayName: "nemoclaw",
    });

    harness.livePolicy = `version: 1
network_policies:
  nous_research:
    endpoints:
      - host: nousresearch.com
        port: 443
`;
    const entry = baseline.getBaselineEntry(harness.livePolicy, "nous_research");
    expect(entry).not.toBeNull();
    const digest = baseline.digestBaselineEntry(entry!);
    harness.runCapture.mockImplementation(() => harness.livePolicy);
    harness.run.mockImplementation((command: readonly string[]) => {
      const policyIndex = command.indexOf("--policy");
      harness.livePolicy = fs.readFileSync(command[policyIndex + 1], "utf8");
      return { status: 0 };
    });
    const interruptedCommit = vi
      .spyOn(registry, "commitBaselineExclusionTransition")
      .mockReturnValueOnce(false);

    expect(policy.excludeBaselineEntry("alpha", "nous_research", digest, { nonFatal: true })).toBe(
      false,
    );
    expect(harness.livePolicy).not.toContain("nous_research:");
    expect(registry.getBaselineExclusionTransition("alpha")).toEqual(
      expect.objectContaining({
        operation: "exclude",
        exclusion: expect.objectContaining({ digest }),
      }),
    );
    expect(registry.getBaselineExclusions("alpha")).toEqual([]);
    interruptedCommit.mockRestore();

    // Simulate a new CLI process: reload both the registry and policy modules
    // from the same temp HOME, then retry against the exact live target.
    vi.resetModules();
    const reloadedRegistry = await import("../state/registry");
    const reloadedPolicy = await import("./index");
    expect(reloadedPolicy.excludeBaselineEntry("alpha", "nous_research", digest)).toBe(true);
    expect(reloadedRegistry.getBaselineExclusionTransition("alpha")).toBeNull();
    expect(reloadedRegistry.getBaselineExclusions("alpha")).toEqual([
      expect.objectContaining({ key: "nous_research", digest }),
    ]);
  });
});
