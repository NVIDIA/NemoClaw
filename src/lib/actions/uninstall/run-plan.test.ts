// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { buildRunPlan, runUninstallPlan, type RunResult } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

describe("uninstall run plan", () => {
  it("builds a plan using host paths and shim classification", () => {
    const { paths, plan } = buildRunPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: false },
      {
        env: { HOME: "/home/test", TMPDIR: "/tmp/test" } as NodeJS.ProcessEnv,
        fs: {
          lstatSync: (() => ({ isFile: () => false, isSymbolicLink: () => true })) as never,
        },
      },
    );

    expect(paths.nemoclawShimPath).toBe("/home/test/.local/bin/nemoclaw");
    expect(plan.steps.map((step) => step.name)).toContain("NemoClaw CLI");
    expect(plan.steps.flatMap((step) => step.actions)).toEqual(
      expect.arrayContaining([{ kind: "delete-shim", reason: "shim path is a symlink" }]),
    );
  });

  it("applies a non-destructive uninstall run with fake tools", () => {
    const logs: string[] = [];
    const run = vi.fn((_command: string, args: string[]) => {
      if (args[0] === "-c") return ok("/fake/bin/tool\n");
      if (args[0] === "-f") return ok("");
      return ok();
    });
    const dockerCalls: string[][] = [];
    const runDocker = vi.fn((args: string[]) => {
      dockerCalls.push(args);
      if (args[0] === "ps") return ok("abc openclaw:latest openshell-cluster-nemoclaw\n");
      if (args[0] === "images") return ok("img1 ghcr.io/nvidia/nemoclaw:test\n");
      return ok();
    });

    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: { HOME: "/tmp/nemoclaw-uninstall-test", TMPDIR: "/tmp/nemoclaw-uninstall-test" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: false,
        kill: () => true,
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run,
        runDocker,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(logs).toContain("Claws retracted. Until next time.");
    expect(dockerCalls).toEqual(expect.arrayContaining([["rm", "-f", "abc"], ["rmi", "-f", "img1"]]));
    expect(dockerCalls.some((args) => args.join(" ") === "volume rm -f openshell-cluster-nemoclaw")).toBe(true);
  });

  it("accepts typed interactive confirmation", () => {
    const logs: string[] = [];
    const run = vi.fn((_command: string, args: string[]) => {
      if (args[0] === "-c") return ok("/fake/bin/tool\n");
      if (args[0] === "-f") return ok("");
      return ok();
    });

    const result = runUninstallPlan(
      { assumeYes: false, deleteModels: false, keepOpenShell: true },
      {
        env: { HOME: "/tmp/nemoclaw-uninstall-test" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        isTty: true,
        log: (line) => logs.push(line),
        readLine: () => "yes",
        run,
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(logs).toContain("Proceed? [y/N]");
    expect(logs).toContain("Claws retracted. Until next time.");
  });

  it("aborts without applying the plan when confirmation is declined", () => {
    const logs: string[] = [];
    const run = vi.fn();
    const result = runUninstallPlan(
      { assumeYes: false, deleteModels: false, keepOpenShell: true },
      {
        env: { HOME: "/tmp/nemoclaw-uninstall-test" } as NodeJS.ProcessEnv,
        log: (line) => logs.push(line),
        readLine: () => "no",
        run,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(logs).toContain("Aborted.");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not report swap cleanup success when swapoff fails", () => {
    const warnings: string[] = [];
    const logs: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command !== "docker" && command !== "pgrep",
        env: { HOME: "/home/test", TMPDIR: "/tmp/test" } as NodeJS.ProcessEnv,
        error: (line) => warnings.push(line),
        existsSync: (target) => target === "/swapfile" || target === "/home/test/.nemoclaw/managed_swap",
        isTty: true,
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run: (_command, args) => {
          if (args[0] === "swapoff") return { status: 1, stdout: "", stderr: "swapoff failed" };
          return ok();
        },
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(warnings).toContain("Failed to disable /swapfile; skipping swap cleanup.");
    expect(logs).not.toContain("Swap file removed");
  });
});
