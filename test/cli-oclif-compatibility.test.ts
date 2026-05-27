// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
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
    const cliPath = require.resolve("../dist/nemoclaw.js");
    const registryPath = require.resolve("../dist/lib/state/registry.js");
    const registryRecoveryPath = require.resolve("../dist/lib/registry-recovery-action.js");
    const runnerPath = require.resolve("../dist/lib/runner.js");

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

  it("hands public sandbox execution to oclif as native argv", async () => {
    const cliPath = require.resolve("../dist/nemoclaw.js");
    const registryPath = require.resolve("../dist/lib/state/registry.js");
    const registryRecoveryPath = require.resolve("../dist/lib/registry-recovery-action.js");
    const runnerPath = require.resolve("../dist/lib/runner.js");
    const publicDispatchPath = require.resolve("../dist/lib/cli/public-dispatch.js");
    const oclifRunnerPath = require.resolve("../dist/lib/cli/oclif-runner.js");
    const sandboxConnectPath = require.resolve("../dist/lib/actions/sandbox/connect.js");

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
      expect(runOclifArgv).toHaveBeenCalledWith(
        ["sandbox", "status", "alpha"],
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
    const cliPath = require.resolve("../dist/nemoclaw.js");
    const registryPath = require.resolve("../dist/lib/state/registry.js");
    const registryRecoveryPath = require.resolve("../dist/lib/registry-recovery-action.js");
    const runnerPath = require.resolve("../dist/lib/runner.js");
    const publicDispatchPath = require.resolve("../dist/lib/cli/public-dispatch.js");
    const oclifRunnerPath = require.resolve("../dist/lib/cli/oclif-runner.js");

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
      expect(runOclifArgv).toHaveBeenCalledWith(
        ["sandbox", "exec", "alpha", "--", "grep", "--help"],
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
    }
  });

  it("keeps simple global execution on direct command IDs to avoid flexible taxonomy overmatching", async () => {
    const cliPath = require.resolve("../dist/nemoclaw.js");
    const runnerPath = require.resolve("../dist/lib/runner.js");
    const publicDispatchPath = require.resolve("../dist/lib/cli/public-dispatch.js");
    const oclifRunnerPath = require.resolve("../dist/lib/cli/oclif-runner.js");

    const priorCli = require.cache[cliPath];
    const priorRunner = require.cache[runnerPath];
    const priorPublicDispatch = require.cache[publicDispatchPath];
    const priorOclifRunner = require.cache[oclifRunnerPath];
    const priorDisableAutoDispatch = process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH;

    const runOclifArgv = vi.fn(async () => undefined);
    const runOclifCommandById = vi.fn(async () => undefined);

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

      await dispatchCli(["status", "bogus"]);

      expect(runOclifCommandById).toHaveBeenCalledWith(
        "status",
        ["bogus"],
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
