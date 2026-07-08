// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

type SandboxStub = { name: string };

export type DirectPublicDispatchHarness = {
  dispatchCli: (argv: string[]) => Promise<void>;
  exitSpy: ReturnType<typeof vi.spyOn>;
  getSandbox: ReturnType<typeof vi.fn>;
  listSandboxes: ReturnType<typeof vi.fn>;
  recoverRegistryEntries: ReturnType<typeof vi.fn>;
  resetObservedCalls: () => void;
  runOclifArgv: ReturnType<typeof vi.fn>;
  runOclifCommandById: ReturnType<typeof vi.fn>;
  sandboxes: Map<string, SandboxStub>;
  stderr: string[];
};

type DirectPublicDispatchOptions = {
  sandboxNames?: readonly string[];
};

const requireCache = require.cache as Record<string, NodeModule | undefined>;

function restoreCache(modulePath: string, prior: NodeModule | undefined): void {
  if (prior) requireCache[modulePath] = prior;
  else delete requireCache[modulePath];
}

function cacheModule(modulePath: string, exports: Record<string, unknown>): void {
  requireCache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  } as NodeModule;
}

/**
 * Run the public dispatcher against deterministic in-memory registry and oclif
 * adapters. The real dispatcher is reloaded for each invocation so its lazy
 * module caches cannot leak between tests.
 */
export async function withDirectPublicDispatch(
  run: (harness: DirectPublicDispatchHarness) => Promise<void>,
  options: DirectPublicDispatchOptions = {},
): Promise<void> {
  const publicDispatchPath = require.resolve("../../src/lib/cli/public-dispatch.js");
  const oclifRunnerPath = require.resolve("../../src/lib/cli/oclif-runner.js");
  const sandboxConnectPath = require.resolve("../../src/lib/actions/sandbox/connect.js");
  const registryPath = require.resolve("../../src/lib/state/registry.js");
  const registryRecoveryPath = require.resolve("../../src/lib/registry-recovery-action.js");
  const runnerPath = require.resolve("../../src/lib/runner.js");
  const priorPublicDispatch = requireCache[publicDispatchPath];
  const priorOclifRunner = requireCache[oclifRunnerPath];
  const priorSandboxConnect = requireCache[sandboxConnectPath];
  const priorRegistry = requireCache[registryPath];
  const priorRegistryRecovery = requireCache[registryRecoveryPath];
  const priorRunner = requireCache[runnerPath];
  const priorDockerHost = process.env.DOCKER_HOST;
  const sandboxes = new Map<string, SandboxStub>(
    (options.sandboxNames ?? []).map((name) => [name, { name }]),
  );
  const getSandbox = vi.fn((name: string) => sandboxes.get(name) ?? null);
  const listSandboxes = vi.fn(() => ({
    sandboxes: [...sandboxes.values()],
    defaultSandbox: sandboxes.keys().next().value ?? null,
  }));
  const recoverRegistryEntries = vi.fn(async () => ({
    ...listSandboxes(),
    recoveredFromSession: false,
    recoveredFromGateway: 0,
  }));
  const runOclifArgv = vi.fn(async () => undefined);
  const runOclifCommandById = vi.fn(async () => undefined);
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as never);
  const resetObservedCalls = () => {
    stderr.length = 0;
    exitSpy.mockClear();
    getSandbox.mockClear();
    listSandboxes.mockClear();
    recoverRegistryEntries.mockClear();
    runOclifArgv.mockClear();
    runOclifCommandById.mockClear();
  };

  cacheModule(registryPath, { getSandbox, listSandboxes });
  cacheModule(registryRecoveryPath, { recoverRegistryEntries });
  cacheModule(oclifRunnerPath, { runOclifArgv, runOclifCommandById });
  cacheModule(sandboxConnectPath, {
    isSandboxConnectFlag: vi.fn(() => false),
    parseSandboxConnectArgs: vi.fn(),
    printSandboxConnectHelp: vi.fn(),
  });

  try {
    delete requireCache[publicDispatchPath];
    const { dispatchCli } = require(publicDispatchPath) as {
      dispatchCli: (argv: string[]) => Promise<void>;
    };
    await run({
      dispatchCli,
      exitSpy,
      getSandbox,
      listSandboxes,
      recoverRegistryEntries,
      resetObservedCalls,
      runOclifArgv,
      runOclifCommandById,
      sandboxes,
      stderr,
    });
  } finally {
    process.exitCode = previousExitCode;
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    restoreCache(publicDispatchPath, priorPublicDispatch);
    restoreCache(oclifRunnerPath, priorOclifRunner);
    restoreCache(sandboxConnectPath, priorSandboxConnect);
    restoreCache(registryPath, priorRegistry);
    restoreCache(registryRecoveryPath, priorRegistryRecovery);
    restoreCache(runnerPath, priorRunner);
    if (priorDockerHost === undefined) {
      delete process.env.DOCKER_HOST;
    } else {
      process.env.DOCKER_HOST = priorDockerHost;
    }
  }
}
