// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(options, {
    resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: gatewayPort === 8080 ? "packaged-service" : "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
    ...deps,
  });
}

function okWithKnownGatewayList(command: string, args: readonly string[]): RunResult {
  return command === "openshell" && args[0] === "gateway" && args[1] === "list"
    ? ok(JSON.stringify([{ name: "nemoclaw" }]))
    : ok();
}

describe("uninstall run plan", () => {
  describe("user-data preservation under ~/.nemoclaw/", () => {
    function setupStateDir(): { tmpHome: string; stateDir: string } {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-preserve-"));
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(path.join(stateDir, "rebuild-backups", "sb1", "20260101"), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "rebuild-backups", "sb1", "20260101", "manifest.json"),
        "{}",
      );
      fs.mkdirSync(path.join(stateDir, "backups", "20260320-120000"), { recursive: true });
      fs.writeFileSync(path.join(stateDir, "backups", "20260320-120000", "USER.md"), "hello");
      fs.writeFileSync(
        path.join(stateDir, "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: "sb1",
          sandboxes: { sb1: { name: "sb1", gatewayName: "nemoclaw", gatewayPort: 8080 } },
        }),
      );
      fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "1234");
      fs.writeFileSync(path.join(stateDir, "openrouter-runtime-adapter.pid"), "1235");
      fs.writeFileSync(path.join(stateDir, "openrouter-runtime-adapter.json"), "{}");
      fs.writeFileSync(path.join(stateDir, "openrouter-runtime-adapter.lock"), "lock");
      fs.writeFileSync(path.join(stateDir, "openrouter-runtime-adapter.log"), "{}\n");
      fs.writeFileSync(path.join(stateDir, "https-pin-runtime-adapter.pid"), "1236");
      fs.writeFileSync(path.join(stateDir, "https-pin-runtime-adapter-token"), "secret");
      fs.writeFileSync(path.join(stateDir, "https-pin-runtime-adapter.json"), "{}");
      fs.writeFileSync(path.join(stateDir, "https-pin-runtime-adapter.lock"), "lock");
      fs.writeFileSync(path.join(stateDir, "https-pin-runtime-adapter.log"), "{}\n");
      fs.mkdirSync(path.join(stateDir, "source"));
      return { tmpHome, stateDir };
    }

    function tempScopedExistsSync(tmpHome: string): (target: string) => boolean {
      return (target: string) => target.startsWith(tmpHome) && fs.existsSync(target);
    }

    function preserveCaseDeps(
      tmpHome: string,
      logs: string[],
      opts: {
        envOverrides?: Record<string, string>;
        isTty?: boolean;
        readLine?: UninstallRunDeps["readLine"];
        warnings?: string[];
      } = {},
    ): UninstallRunDeps {
      return {
        commandExists: (command) => command === "openshell",
        env: {
          HOME: tmpHome,
          NEMOCLAW_NON_INTERACTIVE: "",
          NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "",
          ...(opts.envOverrides ?? {}),
        } as NodeJS.ProcessEnv,
        error: (line) => opts.warnings?.push(line),
        existsSync: tempScopedExistsSync(tmpHome),
        isTty: opts.isTty ?? false,
        log: (line) => logs.push(line),
        ...(opts.readLine ? { readLine: opts.readLine } : {}),
        run: vi.fn(okWithKnownGatewayList),
        runDocker: () => ok(""),
      };
    }

    function expectPreservedEntries(stateDir: string): void {
      expect(
        fs.existsSync(path.join(stateDir, "rebuild-backups", "sb1", "20260101", "manifest.json")),
      ).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "backups", "20260320-120000", "USER.md"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(stateDir, "sandboxes.json"))).toBe(true);
    }

    function expectNoPreserveSignals(logs: string[]): void {
      expect(logs.every((line) => !line.startsWith("Preserving "))).toBe(true);
      expect(logs.every((line) => !line.includes("preserved:"))).toBe(true);
    }

    it("preserves rebuild-backups/, backups/, and sandboxes.json by default in non-interactive runs", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const warnings: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { warnings }),
        );

        expect(result.exitCode).toBe(0);
        expectPreservedEntries(stateDir);
        expect(fs.existsSync(path.join(stateDir, "ollama-auth-proxy.pid"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "openrouter-runtime-adapter.pid"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "openrouter-runtime-adapter.json"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "openrouter-runtime-adapter.lock"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "openrouter-runtime-adapter.log"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "https-pin-runtime-adapter.pid"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "https-pin-runtime-adapter-token"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "https-pin-runtime-adapter.json"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "https-pin-runtime-adapter.lock"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "https-pin-runtime-adapter.log"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "source"))).toBe(false);
        expect(logs).toContain(
          `Preserving rebuild-backups, backups, sandboxes.json under ${stateDir}.`,
        );
        expect(
          logs.some((line) => line.includes("preserved: rebuild-backups, backups, sandboxes.json")),
        ).toBe(true);
        const warningText = warnings.join("\n");
        expect(warningText).toContain("sandboxes.json");
        expect(warningText).toContain("cannot be recovered automatically");
        expect(warningText).toContain("--destroy-user-data");
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("purges the whole state dir when NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1 is set", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            envOverrides: { NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "1" },
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain(`Removed ${stateDir}`);
        expect(logs).toContain(
          "NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1 set; purging user data under ~/.nemoclaw/.",
        );
        expectNoPreserveSignals(logs);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("purges the whole state dir when destroyUserData is set, even with --yes on a non-TTY", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const warnings: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { warnings }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain(`Removed ${stateDir}`);
        expect(logs).toContain("--destroy-user-data set; purging user data under ~/.nemoclaw/.");
        expectNoPreserveSignals(logs);
        expect(warnings.join("\n")).not.toContain("cannot be recovered automatically");
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("destroyUserData purges on a TTY without prompting", () => {
      const { tmpHome, stateDir } = setupStateDir();
      const readLine = vi.fn(() => "y");
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { isTty: true, readLine }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain("--destroy-user-data set; purging user data under ~/.nemoclaw/.");
        expect(logs.every((line) => line !== "Also remove them? [y/N]")).toBe(true);
        expect(readLine).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("destroyUserData without --yes renders a purge-aware global confirmation and skips the user-data prompt", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, destroyUserData: true, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { isTty: true, readLine: () => "y" }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain(
          "  · ~/.nemoclaw (removes rebuild-backups/, backups/, sandboxes.json: --destroy-user-data set)",
        );
        expect(
          logs.every(
            (line) =>
              line !==
              "  · ~/.nemoclaw (preserves rebuild-backups/, backups/, sandboxes.json by default)",
          ),
        ).toBe(true);
        expect(logs.every((line) => line !== "Also remove them? [y/N]")).toBe(true);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("env var without --yes renders a purge-aware global confirmation", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            envOverrides: { NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "1" },
            isTty: true,
            readLine: () => "y",
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain(
          "  · ~/.nemoclaw (removes rebuild-backups/, backups/, sandboxes.json: NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1)",
        );
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("destroyUserData takes precedence over NEMOCLAW_UNINSTALL_DESTROY_USER_DATA env var", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            envOverrides: { NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "1" },
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain("--destroy-user-data set; purging user data under ~/.nemoclaw/.");
        expect(
          logs.every(
            (line) =>
              line !==
              "NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1 set; purging user data under ~/.nemoclaw/.",
          ),
        ).toBe(true);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("non-interactive hint mentions --destroy-user-data alongside the env var on non-TTY without --yes", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { readLine: () => "y" }),
        );

        expect(result.exitCode).toBe(0);
        expectPreservedEntries(stateDir);
        expect(
          logs.some(
            (line) =>
              line.includes("--destroy-user-data") &&
              line.includes("NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1"),
          ),
        ).toBe(true);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("purges via interactive y/N prompt when user answers yes", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const replies = ["yes", "y"];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            isTty: true,
            readLine: () => replies.shift() ?? null,
          }),
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain("Also remove them? [y/N]");
        expect(logs).toContain("Acknowledged; purging user data.");
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("keeps user data when interactive prompt is declined", () => {
      const { tmpHome, stateDir } = setupStateDir();
      try {
        const logs: string[] = [];
        const warnings: string[] = [];
        const replies = ["yes", ""];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            isTty: true,
            readLine: () => replies.shift() ?? null,
            warnings,
          }),
        );

        expect(result.exitCode).toBe(0);
        expectPreservedEntries(stateDir);
        expect(logs).toContain("Keeping user data.");
        expect(warnings.join("\n")).toContain("cannot be recovered automatically");
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("preserves entries on a TTY when NEMOCLAW_NON_INTERACTIVE=1 is set instead of --yes", () => {
      const { tmpHome, stateDir } = setupStateDir();
      const readLine = vi.fn(() => "yes");
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: false, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, {
            envOverrides: { NEMOCLAW_NON_INTERACTIVE: "1" },
            isTty: true,
            readLine,
          }),
        );

        expect(result.exitCode).toBe(0);
        expectPreservedEntries(stateDir);
        expect(logs).toContain(
          `Preserving rebuild-backups, backups, sandboxes.json under ${stateDir}.`,
        );
        expect(logs.every((line) => line !== "Also remove them? [y/N]")).toBe(true);
        expect(readLine).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("fails closed before cleanup when ~/.nemoclaw cannot be inspected", () => {
      const { tmpHome, stateDir } = setupStateDir();
      const realLstat = fs.lstatSync;
      const inspectError = new Error("permission denied") as NodeJS.ErrnoException;
      inspectError.code = "EACCES";
      const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation((p: fs.PathLike) =>
        String(p) === stateDir
          ? (() => {
              throw inspectError;
            })()
          : realLstat(p),
      );
      try {
        const logs: string[] = [];
        const warnings: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            ...preserveCaseDeps(tmpHome, logs),
            error: (line) => warnings.push(line),
          },
        );

        expect(result.exitCode).toBe(1);
        expect(warnings.some((line) => line.includes("permission denied"))).toBe(true);
        expect(logs).not.toContain("Claws retracted. Until next time.");
        expect(
          fs.existsSync(path.join(stateDir, "rebuild-backups", "sb1", "20260101", "manifest.json")),
        ).toBe(true);
      } finally {
        lstatSpy.mockRestore();
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("fails without following a state-directory replacement during cleanup", () => {
      const { tmpHome, stateDir } = setupStateDir();
      const replacementTarget = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-uninstall-replacement-target-"),
      );
      const originalStateDir = path.join(tmpHome, "original-state");
      const protectedFile = path.join(replacementTarget, "keep.txt");
      fs.writeFileSync(protectedFile, "keep");
      const renameSync = fs.renameSync;
      const replacements = new Map<string, (destination: fs.PathLike) => void>();
      replacements.set(stateDir, (destination) => {
        replacements.delete(stateDir);
        expect(String(destination)).toContain(".nemoclaw-cleanup-");
        renameSync(stateDir, originalStateDir);
        fs.symlinkSync(replacementTarget, stateDir);
      });
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        replacements.get(String(source))?.(destination);
        return renameSync(source, destination);
      });
      try {
        const logs: string[] = [];
        const warnings: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { warnings }),
        );

        expect(result.exitCode).toBe(1);
        expect(fs.readFileSync(protectedFile, "utf8")).toBe("keep");
        expect(
          fs.existsSync(
            path.join(originalStateDir, "rebuild-backups", "sb1", "20260101", "manifest.json"),
          ),
        ).toBe(true);
        expect(warnings.join("\n")).toContain("directory changed before cleanup");
        expect(logs).not.toContain("Claws retracted. Until next time.");
      } finally {
        renameSpy.mockRestore();
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(replacementTarget, { recursive: true, force: true });
      }
    });

    it("reports how to restore preserved state when restoration fails", () => {
      const { tmpHome, stateDir } = setupStateDir();
      const renameSync = fs.renameSync;
      const restoreError = new Error("restore denied");
      const renameHandlers = new Map<string, (destination: fs.PathLike) => void>();
      let stagedTarget = "";
      renameHandlers.set(stateDir, (destination) => {
        stagedTarget = String(destination);
        renameHandlers.set(stagedTarget, () => {
          throw restoreError;
        });
      });
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        renameHandlers.get(String(source))?.(destination);
        return renameSync(source, destination);
      });
      try {
        const logs: string[] = [];
        const warnings: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { warnings }),
        );

        expect(result.exitCode).toBe(1);
        expect(stagedTarget).not.toBe("");
        expect(fs.existsSync(stateDir)).toBe(false);
        expectPreservedEntries(stagedTarget);
        const warningText = warnings.join("\n");
        expect(warningText).toContain(`Cleanup did not restore ${stateDir}`);
        expect(warningText).toContain(`Unreconciled staging remains at ${stagedTarget}`);
        expect(warningText).toContain(
          "It contains preserved entries: rebuild-backups, backups, sandboxes.json.",
        );
        expect(warningText).toContain("Do not retry uninstall");
        expect(warningText).toContain(`move it back to ${stateDir}`);
        expect(logs).not.toContain("Claws retracted. Until next time.");
      } finally {
        renameSpy.mockRestore();
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("reports abandoned staged state before an uninstall retry", () => {
      const { tmpHome, stateDir } = setupStateDir();
      const stagingRoot = fs.mkdtempSync(
        path.join(tmpHome, `.${path.basename(stateDir)}-cleanup-`),
      );
      const stagedTarget = path.join(stagingRoot, "content");
      fs.renameSync(stateDir, stagedTarget);
      try {
        const logs: string[] = [];
        const warnings: string[] = [];
        const run = vi.fn(okWithKnownGatewayList);
        const runDocker = vi.fn(() => ok(""));
        const rmSync = vi.fn(fs.rmSync);
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            ...preserveCaseDeps(tmpHome, logs, { warnings }),
            rmSync,
            run,
            runDocker,
          },
        );

        expect(result.exitCode).toBe(1);
        expect(fs.existsSync(stateDir)).toBe(false);
        expectPreservedEntries(stagedTarget);
        const warningText = warnings.join("\n");
        expect(warningText).toContain(`Cleanup cannot continue for ${stateDir}`);
        expect(warningText).toContain(`unreconciled staging remains at ${stagedTarget}`);
        expect(warningText).toContain("Do not retry uninstall");
        expect(warningText).toContain(`move it back to ${stateDir}`);
        expect(logs.some((line) => /^\[\d+\/\d+\]/u.test(line))).toBe(false);
        expect(rmSync).not.toHaveBeenCalled();
        expect(runDocker).not.toHaveBeenCalled();
        expect(
          run.mock.calls.every(
            ([command, args]) =>
              command === "openshell" && args[0] === "gateway" && args[1] === "list",
          ),
        ).toBe(true);
        expect(logs).not.toContain("Claws retracted. Until next time.");
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("reports every abandoned staging path before choosing a restore source", () => {
      const { tmpHome, stateDir } = setupStateDir();
      const firstStagingRoot = fs.mkdtempSync(
        path.join(tmpHome, `.${path.basename(stateDir)}-cleanup-`),
      );
      const firstStagedTarget = path.join(firstStagingRoot, "content");
      fs.renameSync(stateDir, firstStagedTarget);
      const secondStagingRoot = fs.mkdtempSync(
        path.join(tmpHome, `.${path.basename(stateDir)}-cleanup-`),
      );
      const secondStagedTarget = path.join(secondStagingRoot, "content");
      fs.mkdirSync(secondStagedTarget);
      fs.writeFileSync(path.join(secondStagedTarget, "rebuild-backups"), "second candidate");
      try {
        const logs: string[] = [];
        const warnings: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { warnings }),
        );

        expect(result.exitCode).toBe(1);
        expect(fs.existsSync(stateDir)).toBe(false);
        const warningText = warnings.join("\n");
        expect(warningText).toContain(`the canonical target ${stateDir}`);
        expect(warningText).toContain(firstStagedTarget);
        expect(warningText).toContain(secondStagedTarget);
        expect(warningText).toContain("every listed staging path without following links");
        expect(warningText).toContain(
          "Inspect every listed staging path before deciding whether one entry is the intended directory",
        );
        expect(logs.some((line) => /^\[\d+\/\d+\]/u.test(line))).toBe(false);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("reports empty interrupted staging when the canonical directory is absent", () => {
      const { tmpHome, stateDir } = setupStateDir();
      fs.rmSync(stateDir, { recursive: true });
      const stagingRoot = fs.mkdtempSync(
        path.join(tmpHome, `.${path.basename(stateDir)}-cleanup-`),
      );
      try {
        const logs: string[] = [];
        const warnings: string[] = [];
        const run = vi.fn(okWithKnownGatewayList);
        const runDocker = vi.fn(() => ok(""));
        const rmSync = vi.fn(fs.rmSync);
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            ...preserveCaseDeps(tmpHome, logs, { warnings }),
            rmSync,
            run,
            runDocker,
          },
        );

        expect(result.exitCode).toBe(1);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(fs.readdirSync(stagingRoot)).toEqual([]);
        const warningText = warnings.join("\n");
        expect(warningText).toContain(`Cleanup cannot continue for ${stateDir}`);
        expect(warningText).toContain(`unreconciled staging remains at ${stagingRoot}`);
        expect(warningText).toContain("The canonical path is absent");
        expect(warningText).toContain("Do not retry uninstall");
        expect(warningText).toContain(`move it back to ${stateDir}`);
        expect(logs.some((line) => /^\[\d+\/\d+\]/u.test(line))).toBe(false);
        expect(rmSync).not.toHaveBeenCalled();
        expect(runDocker).not.toHaveBeenCalled();
        expect(
          run.mock.calls.every(
            ([command, args]) =>
              command === "openshell" && args[0] === "gateway" && args[1] === "list",
          ),
        ).toBe(true);
        expect(logs).not.toContain("Claws retracted. Until next time.");
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("reports abandoned staged state when the canonical directory also exists", () => {
      const { tmpHome, stateDir } = setupStateDir();
      const stagingRoot = fs.mkdtempSync(
        path.join(tmpHome, `.${path.basename(stateDir)}-cleanup-`),
      );
      const stagedTarget = path.join(stagingRoot, "content");
      fs.renameSync(stateDir, stagedTarget);
      fs.mkdirSync(stateDir);
      const canonicalFile = path.join(stateDir, "canonical.txt");
      fs.writeFileSync(canonicalFile, "canonical");
      try {
        const logs: string[] = [];
        const warnings: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          preserveCaseDeps(tmpHome, logs, { warnings }),
        );

        expect(result.exitCode).toBe(1);
        expect(fs.readFileSync(canonicalFile, "utf8")).toBe("canonical");
        expectPreservedEntries(stagedTarget);
        const warningText = warnings.join("\n");
        expect(warningText).toContain(`Cleanup cannot continue for ${stateDir}`);
        expect(warningText).toContain(`unreconciled staging remains at ${stagedTarget}`);
        expect(warningText).toContain("Do not retry uninstall");
        expect(warningText).toContain(`The canonical path ${stateDir} also exists`);
        expect(warningText).toContain("Do not move the canonical path or any staging entry");
        expect(warningText).toContain(
          "Reconcile the canonical path and each staging entry before continuing",
        );
        expect(warningText).not.toContain(`move it back to ${stateDir}`);
        expect(logs).not.toContain("Claws retracted. Until next time.");
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("refuses to follow or remove ~/.nemoclaw when it is a symlink", () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-preserve-"));
      const realTarget = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-uninstall-preserve-target-"),
      );
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.symlinkSync(realTarget, stateDir);
      // Symlink target intentionally non-empty so that following it would
      // tempt the selective-wipe path; lstat must short-circuit that.
      fs.writeFileSync(path.join(realTarget, "rebuild-backups"), "should not be followed");
      try {
        const logs: string[] = [];
        const errors: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            commandExists: (command) => command === "openshell",
            env: { HOME: tmpHome } as NodeJS.ProcessEnv,
            existsSync: (target: string) => target.startsWith(tmpHome) && fs.existsSync(target),
            error: (line) => errors.push(line),
            isTty: false,
            log: (line) => logs.push(line),
            run: vi.fn(okWithKnownGatewayList),
            runDocker: () => ok(""),
          },
        );

        expect(result.exitCode).toBe(1);
        expect(fs.lstatSync(stateDir).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(realTarget)).toBe(true);
        expect(errors.join("\n")).toContain(
          "Managed distributed vLLM state root is not a real directory",
        );
        expect(logs).not.toContain(`Removed ${stateDir}`);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
        fs.rmSync(realTarget, { recursive: true, force: true });
      }
    });

    it("does not delete a replacement added at the canonical path during final cleanup", () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-preserve-"));
      const stateDir = path.join(tmpHome, ".nemoclaw");
      const replacementFile = path.join(stateDir, "unrelated.txt");
      fs.mkdirSync(stateDir, { recursive: true });
      const removedPaths: string[] = [];
      try {
        const logs: string[] = [];
        const rmSync: typeof fs.rmSync = (target, options) => {
          const removedPath = String(target);
          removedPaths.push(removedPath);
          expect(removedPath).toMatch(/\.nemoclaw-cleanup-.*\/content$/u);
          expect(fs.existsSync(stateDir)).toBe(false);
          fs.mkdirSync(stateDir);
          fs.writeFileSync(replacementFile, "keep");
          fs.rmSync(target, options);
        };
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            ...preserveCaseDeps(tmpHome, logs),
            rmSync,
          },
        );

        expect(result.exitCode).toBe(0);
        expect(removedPaths).toContainEqual(
          expect.stringMatching(/\.nemoclaw-cleanup-.*\/content$/u),
        );
        expect(removedPaths).not.toContain(stateDir);
        expect(fs.readFileSync(replacementFile, "utf8")).toBe("keep");
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("skips the preservation notice when no protected entries exist on disk", () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-preserve-"));
      const stateDir = path.join(tmpHome, ".nemoclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "1234");
      try {
        const logs: string[] = [];
        const result = runUninstallPlan(
          { assumeYes: true, deleteModels: false, keepOpenShell: true },
          {
            commandExists: (command) => command === "openshell",
            env: { HOME: tmpHome } as NodeJS.ProcessEnv,
            existsSync: tempScopedExistsSync(tmpHome),
            isTty: false,
            log: (line) => logs.push(line),
            run: vi.fn(okWithKnownGatewayList),
            runDocker: () => ok(""),
          },
        );

        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(stateDir)).toBe(false);
        expect(logs).toContain(`Removed ${stateDir}`);
        expect(logs.every((line) => !line.startsWith("Preserving "))).toBe(true);
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });
});
