// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  tryCleanupOrphanedDashboardForward,
  type OrphanedDashboardForwardDeps,
} from "../../../dist/lib/onboard/orphaned-dashboard-forward";

function forwardListWith(
  entries: Array<{ sandbox: string; port: number; status?: string }>,
): string {
  const header = "SANDBOX   BIND        PORT   PID    STATUS";
  const rows = entries.map(
    (e) => `${e.sandbox}  127.0.0.1   ${e.port}   1234   ${e.status ?? "running"}`,
  );
  return [header, ...rows].join("\n");
}

interface MakeDepsOverrides {
  cmdline?: string;
  listFn?: () => string;
  portCheckResult?: { ok: boolean; process?: string; pid?: number | null; reason?: string };
}

function makeDeps(overrides: MakeDepsOverrides = {}) {
  const calls = {
    captureProcessArgs: vi.fn((_pid: number) => overrides.cmdline ?? "ssh -L openshell-forward 18789:..."),
    runCaptureOpenshell: vi.fn(
      overrides.listFn ?? (() => forwardListWith([])),
    ) as OrphanedDashboardForwardDeps["runCaptureOpenshell"],
    run: vi.fn() as unknown as OrphanedDashboardForwardDeps["run"],
    sleepSeconds: vi.fn() as OrphanedDashboardForwardDeps["sleepSeconds"],
    checkPortAvailable: vi.fn(async () => overrides.portCheckResult ?? { ok: true }) as unknown as OrphanedDashboardForwardDeps["checkPortAvailable"],
    log: vi.fn(),
  };
  const deps: OrphanedDashboardForwardDeps = {
    port: 18789,
    pid: 4321,
    label: "Test dashboard",
    captureProcessArgs: calls.captureProcessArgs,
    runCaptureOpenshell: calls.runCaptureOpenshell,
    run: calls.run,
    sleepSeconds: calls.sleepSeconds,
    checkPortAvailable: calls.checkPortAvailable,
    log: calls.log,
  };
  return { deps, calls };
}

describe("tryCleanupOrphanedDashboardForward", () => {
  it("returns not-openshell when the listener is unrelated SSH", async () => {
    const { deps, calls } = makeDeps({ cmdline: "ssh -L 18789:remote-host:80 user@bastion" });
    const outcome = await tryCleanupOrphanedDashboardForward(deps);
    expect(outcome).toEqual({ kind: "not-openshell" });
    expect(calls.runCaptureOpenshell).not.toHaveBeenCalled();
    expect(calls.run).not.toHaveBeenCalled();
  });

  it("returns list-failed and skips the kill when forward list throws", async () => {
    const { deps, calls } = makeDeps({
      listFn: () => {
        throw new Error("gateway probe timed out");
      },
    });
    const outcome = await tryCleanupOrphanedDashboardForward(deps);
    expect(outcome).toEqual({ kind: "list-failed" });
    expect(calls.run).not.toHaveBeenCalled();
    expect(calls.checkPortAvailable).not.toHaveBeenCalled();
    expect(calls.log).toHaveBeenCalledWith(
      expect.stringContaining("Could not enumerate OpenShell forwards"),
    );
  });

  it("does not pass ignoreError to runCaptureOpenshell (failures must throw to be classified list-failed)", async () => {
    const { deps, calls } = makeDeps();
    await tryCleanupOrphanedDashboardForward(deps);
    expect(calls.runCaptureOpenshell).toHaveBeenCalledWith(
      ["forward", "list"],
      expect.objectContaining({ timeout: 10_000, suppressOutput: true }),
    );
    expect(calls.runCaptureOpenshell).not.toHaveBeenCalledWith(
      ["forward", "list"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("returns owned-by-live when another live sandbox owns the port", async () => {
    const { deps, calls } = makeDeps({
      listFn: () => forwardListWith([{ sandbox: "other-sandbox", port: 18789 }]),
    });
    const outcome = await tryCleanupOrphanedDashboardForward(deps);
    expect(outcome).toEqual({ kind: "owned-by-live", owner: "other-sandbox" });
    expect(calls.run).not.toHaveBeenCalled();
    expect(calls.checkPortAvailable).not.toHaveBeenCalled();
  });

  it("returns killed-cleared when the kill frees the port", async () => {
    const { deps, calls } = makeDeps({ portCheckResult: { ok: true } });
    const outcome = await tryCleanupOrphanedDashboardForward(deps);
    expect(outcome).toEqual({ kind: "killed-cleared" });
    expect(calls.run).toHaveBeenCalledWith(["kill", "4321"], { ignoreError: true });
    expect(calls.sleepSeconds).toHaveBeenCalledWith(1);
    expect(calls.checkPortAvailable).toHaveBeenCalledWith(18789, undefined);
  });

  it("returns killed-still-blocked when the kill ran but the port stayed blocked", async () => {
    const refreshedCheck = { ok: false, process: "ssh", pid: 4321, reason: "still busy" };
    const { deps, calls } = makeDeps({ portCheckResult: refreshedCheck });
    const outcome = await tryCleanupOrphanedDashboardForward(deps);
    expect(outcome).toEqual({ kind: "killed-still-blocked", portCheck: refreshedCheck });
    expect(calls.run).toHaveBeenCalledTimes(1);
  });

  it("ignores non-live forward statuses when deciding ownership", async () => {
    const { deps, calls } = makeDeps({
      listFn: () => forwardListWith([{ sandbox: "other-sandbox", port: 18789, status: "stopped" }]),
    });
    const outcome = await tryCleanupOrphanedDashboardForward(deps);
    expect(outcome.kind).toBe("killed-cleared");
    expect(calls.run).toHaveBeenCalledTimes(1);
  });
});
