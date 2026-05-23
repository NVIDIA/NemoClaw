// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const requireCache: Record<string, unknown> = require.cache as any;

// Regression: `nemoclaw share mount` was passing the sandbox name as a bare
// positional to `openshell sandbox exec`, so OpenShell treated it as the
// command to run and the probe always returned a non-zero exit code even
// when `/sandbox` existed. The convention in this repo is to select the
// target sandbox with `-n` (or `--name`).
// See #3889 and #3954.
describe("buildShareCommandDeps().checkSandboxPathExists probe argv", () => {
  afterEach(() => {
    const openshellRuntimePath = require.resolve("../dist/lib/adapters/openshell/runtime");
    const shareDepsPath = require.resolve("../dist/lib/share-command-deps");
    delete require.cache[openshellRuntimePath];
    delete require.cache[shareDepsPath];
  });

  it("targets the sandbox with `-n <name>` so it is not parsed as the command", () => {
    const openshellRuntimePath = require.resolve("../dist/lib/adapters/openshell/runtime");
    const shareDepsPath = require.resolve("../dist/lib/share-command-deps");

    let recordedArgs: readonly string[] | undefined;
    requireCache[openshellRuntimePath] = {
      id: openshellRuntimePath,
      filename: openshellRuntimePath,
      loaded: true,
      exports: {
        captureOpenshell: (args: readonly string[]) => {
          recordedArgs = args;
          return { status: 0, output: "" };
        },
      },
    } as any;
    delete require.cache[shareDepsPath];

    const { buildShareCommandDeps } = require("../dist/lib/share-command-deps");
    const deps = buildShareCommandDeps();
    const exists = deps.checkSandboxPathExists("prachi-sbox", "/sandbox");

    expect(exists).toBe(true);
    expect(recordedArgs).toEqual([
      "sandbox",
      "exec",
      "-n",
      "prachi-sbox",
      "--",
      "test",
      "-e",
      "/sandbox",
    ]);
  });

  it("reports the path as missing when the probe exits non-zero", () => {
    const openshellRuntimePath = require.resolve("../dist/lib/adapters/openshell/runtime");
    const shareDepsPath = require.resolve("../dist/lib/share-command-deps");

    requireCache[openshellRuntimePath] = {
      id: openshellRuntimePath,
      filename: openshellRuntimePath,
      loaded: true,
      exports: {
        captureOpenshell: () => ({ status: 1, output: "" }),
      },
    } as any;
    delete require.cache[shareDepsPath];

    const { buildShareCommandDeps } = require("../dist/lib/share-command-deps");
    const deps = buildShareCommandDeps();
    expect(deps.checkSandboxPathExists("alpha", "/sandbox/missing")).toBe(false);
  });
});
