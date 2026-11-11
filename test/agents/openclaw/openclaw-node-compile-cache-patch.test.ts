// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

import {
  patchCompileCacheInheritance,
  patchCompileCacheRoot,
  patchOpenClawNodeCompileCache,
  patchWorkerCompileCache,
} from "../../../scripts/lib/patch-openclaw-node-compile-cache.mts";

const rootSource = `function resolve(env) {
  return path.resolve(env.NODE_COMPILE_CACHE || path.join(os.tmpdir(), "node-compile-cache"));
}`;
const activationSource = `function enable(baseDirectory) {
  const result = module.enableCompileCache(baseDirectory);
  if (result.status === 1) {
\t\tcompileCacheOwner().baseDirectory ??= baseDirectory;
  }
}`;
const workerSource = `function createCpuTrackedWorker(...args) {
\tconst worker = new Worker(...args);
  trackWorker(worker);
  return worker;
}`;

describe("native OpenClaw compile cache repair", () => {
  function installation() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-cache-patch-"));
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    const files = new Map([
      [path.join(root, "node-compile-cache.mjs"), rootSource],
      [
        path.join(root, "openclaw.mjs"),
        activationSource.replace(
          "\t\tcompileCacheOwner().baseDirectory ??= baseDirectory;",
          "          owner.baseDirectory ??= baseDirectory;",
        ),
      ],
      [path.join(dist, "node-compile-cache-env-fixture.mjs"), rootSource + activationSource],
      [path.join(dist, "worker-cpu-fixture.mjs"), workerSource],
    ]);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.10.5" }));
    for (const [file, source] of files) fs.writeFileSync(file, source);
    return { root, dist, files };
  }

  it("audits without mutation, applies every module, and rejects unsupported versions", () => {
    const proof = installation();
    try {
      expect(() => patchOpenClawNodeCompileCache(proof.dist, true)).toThrow("Missing");
      expect([...proof.files.keys()].map((file) => fs.readFileSync(file, "utf8"))).toEqual([
        ...proof.files.values(),
      ]);
      patchOpenClawNodeCompileCache(proof.dist);
      const applied = [...proof.files.keys()].map((file) => fs.readFileSync(file, "utf8"));
      patchOpenClawNodeCompileCache(proof.dist, true);
      patchOpenClawNodeCompileCache(proof.dist);
      expect([...proof.files.keys()].map((file) => fs.readFileSync(file, "utf8"))).toEqual(applied);
      fs.writeFileSync(
        path.join(proof.root, "package.json"),
        JSON.stringify({ version: "2026.9.7" }),
      );
      expect(() => patchOpenClawNodeCompileCache(proof.dist)).toThrow("Unsupported");
      expect([...proof.files.keys()].map((file) => fs.readFileSync(file, "utf8"))).toEqual(applied);
    } finally {
      fs.rmSync(proof.root, { recursive: true, force: true });
    }
  });

  it("classifies all modules before writing when the worker boundary has drifted", () => {
    const proof = installation();
    try {
      const worker = path.join(proof.dist, "worker-cpu-fixture.mjs");
      proof.files.set(worker, "unrecognized worker module");
      fs.writeFileSync(worker, proof.files.get(worker)!);
      expect(() => patchOpenClawNodeCompileCache(proof.dist)).toThrow("boundary");
      expect([...proof.files.keys()].map((file) => fs.readFileSync(file, "utf8"))).toEqual([
        ...proof.files.values(),
      ]);
    } finally {
      fs.rmSync(proof.root, { recursive: true, force: true });
    }
  });

  it("keeps disposable bytecode outside captured home without changing host or overrides", () => {
    const run = (uid: number, env: Record<string, string>) => {
      const resolve = vm.runInNewContext(`(${patchCompileCacheRoot(rootSource)})`, {
        path,
        os: { tmpdir: () => "/tmp", homedir: () => "/sandbox" },
        process: { getuid: () => uid },
      });
      return resolve(env);
    };
    expect(run(998, { OPENSHELL_SANDBOX: "1" })).toBe("/tmp/nemoclaw/node-compile-cache");
    expect(run(0, { OPENSHELL_SANDBOX: "1" })).toBe("/tmp/node-compile-cache");
    expect(run(998, {})).toBe("/tmp/node-compile-cache");
    expect(run(998, { OPENSHELL_SANDBOX: "1", NODE_COMPILE_CACHE: "/chosen" })).toBe("/chosen");
  });

  it.each([0, 1, 2, 3])("inherits only a successfully enabled cache (status %s)", (status) => {
    const env: Record<string, string> = {};
    const owner = {};
    const enable = vm.runInNewContext(
      `(${patchCompileCacheInheritance(activationSource, false)})`,
      {
        module: { enableCompileCache: () => ({ status }) },
        compileCacheOwner: () => owner,
        process: { env },
      },
    );
    enable("/private/version/build");
    expect(env.NODE_COMPILE_CACHE).toBe(status === 1 ? "/private/version/build" : undefined);
    env.NODE_COMPILE_CACHE = "/explicit";
    enable("/private/version/build");
    expect(env.NODE_COMPILE_CACHE).toBe("/explicit");
  });

  it.each([false, true])("retains Worker arguments and honors cache disabling (%s)", (disabled) => {
    const flushCompileCache = vi.fn(() => {
      throw new Error("unwritable disposable cache");
    });
    const observed: unknown[][] = [];
    const trackWorker = vi.fn();
    class Worker {
      constructor(...args: unknown[]) {
        observed.push(args);
      }
    }
    const patched = patchWorkerCompileCache(workerSource);
    const body = patched.slice(patched.indexOf("\n") + 1);
    const create = vm.runInNewContext(`(${body})`, {
      Worker,
      trackWorker,
      nemoclawCompileCacheModule: { flushCompileCache },
      process: { env: disabled ? { NODE_DISABLE_COMPILE_CACHE: "1" } : {} },
    });
    const options = {
      env: Symbol("shared environment"),
      execArgv: ["--require", "/trusted/preload"],
    };
    create("worker.js", options);
    expect(observed[0]![0]).toBe("worker.js");
    expect(observed[0]![1]).toBe(options);
    expect(trackWorker).toHaveBeenCalledOnce();
    expect(flushCompileCache).toHaveBeenCalledTimes(disabled ? 0 : 1);
  });

  it("is idempotent and rejects drift, duplicate boundaries, and partial application", () => {
    const patched = patchCompileCacheRoot(rootSource);
    expect(patchCompileCacheRoot(patched)).toBe(patched);
    expect(() => patchCompileCacheRoot("unrecognized native module")).toThrow("boundary");
    expect(() => patchCompileCacheRoot(rootSource + rootSource)).toThrow("boundary");
    expect(() => patchCompileCacheRoot(patched + rootSource)).toThrow("Incomplete");
    const worker = patchWorkerCompileCache(workerSource);
    expect(patchWorkerCompileCache(worker)).toBe(worker);
    expect(() => patchWorkerCompileCache(worker.slice(worker.indexOf("\n") + 1))).toThrow("import");
    const activation = patchCompileCacheInheritance(activationSource, false);
    expect(patchCompileCacheInheritance(activation, false)).toBe(activation);
  });
});
