// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const requireCache: Record<string, unknown> = require.cache as any;

function restoreCache(path: string, prior: unknown): void {
  if (prior) requireCache[path] = prior;
  else delete requireCache[path];
}

describe("oclif compatibility dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders native sandbox help without registry recovery", async () => {
    const cliPath = require.resolve("../src/nemoclaw.js");
    const registryPath = require.resolve("../src/lib/state/registry.js");
    const registryRecoveryPath = require.resolve("../src/lib/registry-recovery-action.js");
    const runnerPath = require.resolve("../src/lib/runner.js");

    const priorCli = require.cache[cliPath];
    const priorRegistry = require.cache[registryPath];
    const priorRegistryRecovery = require.cache[registryRecoveryPath];
    const priorRunner = require.cache[runnerPath];
    const priorDisableAutoDispatch = process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH;

    const recoverRegistryEntries = vi.fn(async () => undefined);
    const validateName = vi.fn();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message = "") => {
      stdout.push(String(message));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message = "") => {
      stderr.push(String(message));
    });

    process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH = "1";

    requireCache[runnerPath] = {
      id: runnerPath,
      filename: runnerPath,
      loaded: true,
      exports: new Proxy(
        {
          ROOT: process.cwd(),
          validateName,
        },
        {
          get(target, prop) {
            if (prop in target) return target[prop as keyof typeof target];
            return vi.fn();
          },
        },
      ),
    } as any;

    requireCache[registryPath] = {
      id: registryPath,
      filename: registryPath,
      loaded: true,
      exports: {
        getSandbox: vi.fn(() => null),
        listSandboxes: vi.fn(() => ({ sandboxes: [] })),
      },
    } as any;

    requireCache[registryRecoveryPath] = {
      id: registryRecoveryPath,
      filename: registryRecoveryPath,
      loaded: true,
      exports: { recoverRegistryEntries },
    } as any;

    try {
      delete require.cache[cliPath];
      const { dispatchCli } = require(cliPath);

      await dispatchCli(["missing-sandbox", "channels", "start", "--help"]);

      expect(validateName).toHaveBeenCalledWith("missing-sandbox", "sandbox name");
      expect(recoverRegistryEntries).not.toHaveBeenCalled();
      expect(stdout.join("\n")).toContain(
        "$ nemoclaw sandbox channels start <name> <channel> [--dry-run]",
      );
      expect(stderr).toEqual([]);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();

      if (priorDisableAutoDispatch === undefined) {
        delete process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH;
      } else {
        process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH = priorDisableAutoDispatch;
      }

      restoreCache(cliPath, priorCli);
      restoreCache(registryPath, priorRegistry);
      restoreCache(registryRecoveryPath, priorRegistryRecovery);
      restoreCache(runnerPath, priorRunner);
    }
  });

  it("hands exact public sandbox execution to oclif by command id", async () => {
    const cliPath = require.resolve("../src/nemoclaw.js");
    const registryPath = require.resolve("../src/lib/state/registry.js");
    const registryRecoveryPath = require.resolve("../src/lib/registry-recovery-action.js");
    const runnerPath = require.resolve("../src/lib/runner.js");
    const publicDispatchPath = require.resolve("../src/lib/cli/public-dispatch.js");
    const oclifRunnerPath = require.resolve("../src/lib/cli/oclif-runner.js");
    const sandboxConnectPath = require.resolve("../src/lib/actions/sandbox/connect.js");

    const priorCli = require.cache[cliPath];
    const priorRegistry = require.cache[registryPath];
    const priorRegistryRecovery = require.cache[registryRecoveryPath];
    const priorRunner = require.cache[runnerPath];
    const priorPublicDispatch = require.cache[publicDispatchPath];
    const priorOclifRunner = require.cache[oclifRunnerPath];
    const priorSandboxConnect = require.cache[sandboxConnectPath];
    const priorDisableAutoDispatch = process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH;

    const runOclifArgv = vi.fn(async () => undefined);
    const runOclifCommandById = vi.fn(async () => undefined);
    const validateName = vi.fn();

    process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH = "1";

    requireCache[runnerPath] = {
      id: runnerPath,
      filename: runnerPath,
      loaded: true,
      exports: {
        ROOT: process.cwd(),
        validateName,
      },
    } as any;

    requireCache[registryPath] = {
      id: registryPath,
      filename: registryPath,
      loaded: true,
      exports: {
        getSandbox: vi.fn((name: string) => (name === "alpha" ? { name: "alpha" } : null)),
        listSandboxes: vi.fn(() => ({ sandboxes: [{ name: "alpha" }] })),
      },
    } as any;

    requireCache[registryRecoveryPath] = {
      id: registryRecoveryPath,
      filename: registryRecoveryPath,
      loaded: true,
      exports: { recoverRegistryEntries: vi.fn(async () => undefined) },
    } as any;

    requireCache[oclifRunnerPath] = {
      id: oclifRunnerPath,
      filename: oclifRunnerPath,
      loaded: true,
      exports: { runOclifArgv, runOclifCommandById },
    } as any;

    requireCache[sandboxConnectPath] = {
      id: sandboxConnectPath,
      filename: sandboxConnectPath,
      loaded: true,
      exports: {
        isSandboxConnectFlag: vi.fn(() => false),
        parseSandboxConnectArgs: vi.fn(),
        printSandboxConnectHelp: vi.fn(),
      },
    } as any;

    try {
      delete require.cache[cliPath];
      delete require.cache[publicDispatchPath];
      const { dispatchCli } = require(cliPath);

      await dispatchCli(["alpha", "status"]);

      expect(validateName).toHaveBeenCalledWith("alpha", "sandbox name");
      expect(runOclifCommandById).toHaveBeenCalledWith(
        "sandbox:status",
        ["alpha"],
        expect.objectContaining({ rootDir: process.cwd() }),
      );
      expect(runOclifArgv).not.toHaveBeenCalled();

      runOclifArgv.mockClear();
      runOclifCommandById.mockClear();

      await dispatchCli(["alpha", "channels", "bogus"]);

      expect(runOclifArgv).toHaveBeenCalledWith(
        ["sandbox", "channels", "bogus", "alpha"],
        expect.objectContaining({ rootDir: process.cwd() }),
      );
      expect(runOclifCommandById).not.toHaveBeenCalled();
    } finally {
      if (priorDisableAutoDispatch === undefined) {
        delete process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH;
      } else {
        process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH = priorDisableAutoDispatch;
      }

      restoreCache(cliPath, priorCli);
      restoreCache(registryPath, priorRegistry);
      restoreCache(registryRecoveryPath, priorRegistryRecovery);
      restoreCache(runnerPath, priorRunner);
      restoreCache(publicDispatchPath, priorPublicDispatch);
      restoreCache(oclifRunnerPath, priorOclifRunner);
      restoreCache(sandboxConnectPath, priorSandboxConnect);
    }
  });

  it("forwards exec command help flags after -- instead of rendering NemoClaw help", async () => {
    const cliPath = require.resolve("../src/nemoclaw.js");
    const registryPath = require.resolve("../src/lib/state/registry.js");
    const registryRecoveryPath = require.resolve("../src/lib/registry-recovery-action.js");
    const runnerPath = require.resolve("../src/lib/runner.js");
    const publicDispatchPath = require.resolve("../src/lib/cli/public-dispatch.js");
    const oclifRunnerPath = require.resolve("../src/lib/cli/oclif-runner.js");

    const priorCli = require.cache[cliPath];
    const priorRegistry = require.cache[registryPath];
    const priorRegistryRecovery = require.cache[registryRecoveryPath];
    const priorRunner = require.cache[runnerPath];
    const priorPublicDispatch = require.cache[publicDispatchPath];
    const priorOclifRunner = require.cache[oclifRunnerPath];
    const priorDisableAutoDispatch = process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH;

    const recoverRegistryEntries = vi.fn(async () => undefined);
    const validateName = vi.fn();
    const runOclifArgv = vi.fn(async () => undefined);
    const runOclifCommandById = vi.fn(async () => undefined);

    process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH = "1";

    requireCache[runnerPath] = {
      id: runnerPath,
      filename: runnerPath,
      loaded: true,
      exports: new Proxy(
        {
          ROOT: process.cwd(),
          validateName,
        },
        {
          get(target, prop) {
            if (prop in target) return target[prop as keyof typeof target];
            return vi.fn();
          },
        },
      ),
    } as any;

    requireCache[registryPath] = {
      id: registryPath,
      filename: registryPath,
      loaded: true,
      exports: {
        getSandbox: vi.fn(() => ({ name: "alpha" })),
        listSandboxes: vi.fn(() => ({ sandboxes: [{ name: "alpha" }] })),
      },
    } as any;

    requireCache[registryRecoveryPath] = {
      id: registryRecoveryPath,
      filename: registryRecoveryPath,
      loaded: true,
      exports: { recoverRegistryEntries },
    } as any;

    requireCache[oclifRunnerPath] = {
      id: oclifRunnerPath,
      filename: oclifRunnerPath,
      loaded: true,
      exports: { runOclifArgv, runOclifCommandById },
    } as any;

    try {
      delete require.cache[cliPath];
      delete require.cache[publicDispatchPath];
      const { dispatchCli } = require(cliPath);

      await dispatchCli(["alpha", "exec", "--", "grep", "--help"]);

      expect(validateName).toHaveBeenCalledWith("alpha", "sandbox name");
      expect(recoverRegistryEntries).not.toHaveBeenCalled();
      expect(runOclifCommandById).toHaveBeenCalledWith(
        "sandbox:exec",
        ["alpha", "--", "grep", "--help"],
        expect.objectContaining({ rootDir: process.cwd() }),
      );
      expect(runOclifArgv).not.toHaveBeenCalled();
    } finally {
      if (priorDisableAutoDispatch === undefined) {
        delete process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH;
      } else {
        process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH = priorDisableAutoDispatch;
      }

      restoreCache(cliPath, priorCli);
      restoreCache(registryPath, priorRegistry);
      restoreCache(registryRecoveryPath, priorRegistryRecovery);
      restoreCache(runnerPath, priorRunner);
      restoreCache(publicDispatchPath, priorPublicDispatch);
      restoreCache(oclifRunnerPath, priorOclifRunner);
    }
  });

  it("keeps exact global execution on direct command IDs to avoid flexible taxonomy overmatching", async () => {
    const cliPath = require.resolve("../src/nemoclaw.js");
    const runnerPath = require.resolve("../src/lib/runner.js");
    const publicDispatchPath = require.resolve("../src/lib/cli/public-dispatch.js");
    const oclifRunnerPath = require.resolve("../src/lib/cli/oclif-runner.js");

    const priorCli = require.cache[cliPath];
    const priorRunner = require.cache[runnerPath];
    const priorPublicDispatch = require.cache[publicDispatchPath];
    const priorOclifRunner = require.cache[oclifRunnerPath];
    const priorDisableAutoDispatch = process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH;

    const runOclifArgv = vi.fn(async () => undefined);
    const runOclifCommandById = vi.fn(async () => undefined);
    const stderr: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message = "") => {
      stderr.push(String(message));
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as never);

    process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH = "1";
    requireCache[runnerPath] = {
      id: runnerPath,
      filename: runnerPath,
      loaded: true,
      exports: { ROOT: process.cwd(), validateName: vi.fn() },
    } as any;
    requireCache[oclifRunnerPath] = {
      id: oclifRunnerPath,
      filename: oclifRunnerPath,
      loaded: true,
      exports: { runOclifArgv, runOclifCommandById },
    } as any;

    try {
      delete require.cache[cliPath];
      delete require.cache[publicDispatchPath];
      const { dispatchCli } = require(cliPath);

      await expect(dispatchCli(["status", "bogus"])).rejects.toThrow("process.exit:2");

      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(stderr.join("\n")).toContain("Run: nemoclaw bogus status");
      expect(runOclifCommandById).not.toHaveBeenCalled();
      expect(runOclifArgv).not.toHaveBeenCalled();

      errorSpy.mockClear();
      exitSpy.mockClear();
      stderr.length = 0;
      runOclifArgv.mockClear();
      runOclifCommandById.mockClear();

      await dispatchCli(["credentials", "reset", "--yes"]);

      expect(runOclifCommandById).toHaveBeenCalledWith(
        "credentials:reset",
        ["--yes"],
        expect.objectContaining({ rootDir: process.cwd() }),
      );
      expect(runOclifArgv).not.toHaveBeenCalled();
    } finally {
      if (priorDisableAutoDispatch === undefined) {
        delete process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH;
      } else {
        process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH = priorDisableAutoDispatch;
      }

      restoreCache(cliPath, priorCli);
      restoreCache(runnerPath, priorRunner);
      restoreCache(publicDispatchPath, priorPublicDispatch);
      restoreCache(oclifRunnerPath, priorOclifRunner);
    }
  });

  it("uses the alias binary name in native oclif help", () => {
    const result = spawnSync(
      process.execPath,
      ["bin/nemohermes.js", "sandbox", "channels", "start", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NO_COLOR: "1",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("$ nemohermes sandbox channels start <name> <channel>");
    expect(result.stdout).not.toContain("$ nemoclaw sandbox channels start <name> <channel>");
  });

  it("uses the Deep Agents alias binary name in native oclif help", () => {
    const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-deepagents-oclif-bin-"));
    const alias = path.join(aliasDir, "nemo-deepagents");
    fs.symlinkSync(path.join(process.cwd(), "bin", "nemoclaw.js"), alias);
    try {
      const result = spawnSync(
        process.execPath,
        [alias, "sandbox", "channels", "start", "--help"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            NO_COLOR: "1",
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("$ nemo-deepagents sandbox channels start <name> <channel>");
      expect(result.stdout).not.toContain("$ nemoclaw sandbox channels start <name> <channel>");
    } finally {
      fs.rmSync(aliasDir, { force: true, recursive: true });
    }
  });

  it("keeps nested internal commands routable through native oclif help", () => {
    const result = spawnSync(
      process.execPath,
      ["bin/nemoclaw.js", "internal", "installer", "plan", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NO_COLOR: "1",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("$ nemoclaw internal installer plan");
    expect(result.stdout).toContain("Build a deterministic installer plan");
  });
});
