// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type RunResult, runUninstallPlan, type UninstallRunDeps } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function notFound(): RunResult {
  return { status: 1, stdout: "", stderr: "" };
}

function setupStateDir(): { tmpHome: string; stateDir: string } {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-registry-"));
  const stateDir = path.join(tmpHome, ".nemoclaw");
  fs.mkdirSync(path.join(stateDir, "rebuild-backups"), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "backups"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "sandboxes.json"), "[]");
  return { tmpHome, stateDir };
}

function preserveCaseDeps(
  tmpHome: string,
  logs: string[],
  warnings: string[],
  opts: { envOverrides?: Record<string, string> } = {},
): UninstallRunDeps {
  return {
    commandExists: () => false,
    env: {
      HOME: tmpHome,
      NEMOCLAW_NON_INTERACTIVE: "",
      NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "",
      ...(opts.envOverrides ?? {}),
    } as NodeJS.ProcessEnv,
    error: (line) => warnings.push(line),
    existsSync: (target: string) => target.startsWith(tmpHome) && fs.existsSync(target),
    isTty: false,
    log: (line) => logs.push(line),
    run: vi.fn(() => ok()),
    runDocker: () => ok(""),
  };
}

describe("uninstall messaging for a preserved-but-orphaned sandbox registry (#6520)", () => {
  it("uses the 'already removed' wording for provider and sandbox delete no-ops", () => {
    // Same defect family as the gateway wording fix (#3456 sub-bug 4): when
    // `openshell provider delete <name>` or `openshell sandbox delete --all`
    // no-ops (target already gone), `Deleted provider 'X' skipped` reads as if
    // the deletion both happened and was skipped.
    const warnings: string[] = [];
    const logs: string[] = [];
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: (command) => command !== "docker" && command !== "pgrep",
        env: { HOME: "/home/test", TMPDIR: "/tmp/test" } as NodeJS.ProcessEnv,
        error: (line) => warnings.push(line),
        existsSync: () => false,
        isTty: false,
        log: (line) => logs.push(line),
        rmSync: vi.fn(),
        run: (command, args) =>
          command === "openshell" ? notFound() : args[0] === "-c" ? ok("/fake/bin/tool\n") : ok(),
        runDocker: () => ok(""),
      },
    );

    expect(result.exitCode).toBe(0);
    const combined = `${warnings.join("\n")}\n${logs.join("\n")}`;
    expect(warnings.join("\n")).toContain("Provider 'nvidia-nim' already removed or unreachable");
    expect(warnings.join("\n")).toContain("OpenShell sandboxes already removed or unreachable");
    expect(combined).not.toContain("Deleted provider 'nvidia-nim' skipped");
    expect(combined).not.toContain("Deleted all OpenShell sandboxes skipped");
  });

  it("warns that preserved sandboxes.json cannot be auto-recovered after uninstall removes its dependencies", () => {
    // Uninstall keeps sandboxes.json but removes the gateway, provider
    // registrations, and Docker image its recorded sandboxes depend on. Say
    // so at the moment the preserve choice is made, with a remediation path,
    // instead of letting a later reinstall report false success.
    const { tmpHome } = setupStateDir();
    try {
      const logs: string[] = [];
      const warnings: string[] = [];
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        preserveCaseDeps(tmpHome, logs, warnings),
      );

      expect(result.exitCode).toBe(0);
      const joined = warnings.join("\n");
      expect(joined).toContain("sandboxes.json");
      expect(joined).toContain("cannot be recovered automatically");
      expect(joined).toContain("--destroy-user-data");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("warns on the interactive keep path when the purge prompt is declined", () => {
    const { tmpHome } = setupStateDir();
    try {
      const logs: string[] = [];
      const warnings: string[] = [];
      // First reply confirms the uninstall itself; the empty second reply
      // declines the purge prompt, keeping user data.
      const replies = ["yes", ""];
      const result = runUninstallPlan(
        { assumeYes: false, deleteModels: false, keepOpenShell: true },
        {
          ...preserveCaseDeps(tmpHome, logs, warnings),
          isTty: true,
          readLine: () => replies.shift() ?? null,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(logs).toContain("Keeping user data.");
      expect(warnings.join("\n")).toContain("cannot be recovered automatically");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not warn about unrecoverable sandboxes when user data is purged", () => {
    const { tmpHome } = setupStateDir();
    try {
      const logs: string[] = [];
      const warnings: string[] = [];
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        preserveCaseDeps(tmpHome, logs, warnings, {
          envOverrides: { NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "1" },
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(warnings.join("\n")).not.toContain("cannot be recovered automatically");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
