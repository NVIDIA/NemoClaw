// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

import { restoreRequireCache } from "../../helpers/require-cache.ts";

const require = createRequire(import.meta.url);
const requireCache: Record<string, unknown> = require.cache as any;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("config set CLI dispatch", () => {
  it("awaits config set command dispatch before completing the dispatcher", async () => {
    const cliPath = require.resolve("../../../dist/nemoclaw.js");
    const publicDispatchPath = require.resolve("../../../dist/lib/cli/public-dispatch.js");
    const oclifRunnerPath = require.resolve("../../../dist/lib/cli/oclif-runner.js");
    const registryPath = require.resolve("../../../dist/lib/state/registry.js");
    const sandboxConfigPath = require.resolve("../../../dist/lib/sandbox/config.js");
    const runnerPath = require.resolve("../../../dist/lib/runner.js");

    const priorCli = require.cache[cliPath];
    const priorPublicDispatch = require.cache[publicDispatchPath];
    const priorOclifRunner = require.cache[oclifRunnerPath];
    const priorRegistry = require.cache[registryPath];
    const priorSandboxConfig = require.cache[sandboxConfigPath];
    const priorRunner = require.cache[runnerPath];
    const priorDisableAutoDispatch = process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH;

    const expectedConfigSetDispatchArgs = [
      "test-sandbox",
      "--key",
      "inference.endpoints",
      "--value",
      "HTTP://93.184.216.34/v1",
      "--config-accept-new-path",
    ];
    const commandDispatchDeferred = deferred<void>();
    const validateName = vi.fn();
    const configSet = vi.fn();
    const runOclifArgv = vi.fn(async () => {
      throw new Error("config set should dispatch by command id");
    });
    const runOclifCommandById = vi.fn(async () => commandDispatchDeferred.promise);

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

    requireCache[oclifRunnerPath] = {
      id: oclifRunnerPath,
      filename: oclifRunnerPath,
      loaded: true,
      exports: new Proxy(
        {
          runOclifArgv,
          runOclifCommandById,
        },
        {
          get(target, prop) {
            return prop in target ? target[prop as keyof typeof target] : vi.fn();
          },
        },
      ),
    } as any;

    requireCache[registryPath] = {
      id: registryPath,
      filename: registryPath,
      loaded: true,
      exports: {
        getSandbox: vi.fn((name: string) => (name === "test-sandbox" ? { name } : null)),
        listSandboxes: vi.fn(() => ({ sandboxes: [{ name: "test-sandbox" }] })),
      },
    } as any;

    requireCache[sandboxConfigPath] = {
      id: sandboxConfigPath,
      filename: sandboxConfigPath,
      loaded: true,
      exports: {
        configSet,
        configGet: vi.fn(),
        configRotateToken: vi.fn(),
      },
    } as any;

    try {
      delete require.cache[cliPath];
      delete require.cache[publicDispatchPath];
      const { dispatchCli } = require(cliPath);

      const dispatchPromise = dispatchCli([
        "test-sandbox",
        "config",
        "set",
        "--key",
        "inference.endpoints",
        "--value",
        "HTTP://93.184.216.34/v1",
        "--config-accept-new-path",
      ]);

      let settled = false;
      dispatchPromise.then(() => {
        settled = true;
      });

      await vi.waitFor(() => expect(runOclifCommandById).toHaveBeenCalledTimes(1), {
        timeout: 4_000,
      });
      expect(runOclifArgv).not.toHaveBeenCalled();
      expect(runOclifCommandById).toHaveBeenCalledTimes(1);
      expect(runOclifCommandById).toHaveBeenCalledWith(
        "sandbox:config:set",
        expectedConfigSetDispatchArgs,
        expect.objectContaining({
          error: expect.any(Function),
          exit: expect.any(Function),
          rootDir: process.cwd(),
        }),
      );
      expect(configSet).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      commandDispatchDeferred.resolve();
      await expect(dispatchPromise).resolves.toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      if (priorDisableAutoDispatch === undefined) {
        delete process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH;
      } else {
        process.env.NEMOCLAW_DISABLE_AUTO_DISPATCH = priorDisableAutoDispatch;
      }

      restoreRequireCache(requireCache, cliPath, priorCli);
      restoreRequireCache(requireCache, publicDispatchPath, priorPublicDispatch);
      restoreRequireCache(requireCache, oclifRunnerPath, priorOclifRunner);
      restoreRequireCache(requireCache, registryPath, priorRegistry);
      restoreRequireCache(requireCache, sandboxConfigPath, priorSandboxConfig);
      restoreRequireCache(requireCache, runnerPath, priorRunner);
    }
  });
});
