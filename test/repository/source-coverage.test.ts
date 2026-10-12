// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nodeOptionsWithoutSourceLoader,
  SOURCE_REQUIRE_HOOK,
} from "../helpers/source-loader-options";
import { testTimeoutOptions } from "../helpers/timeouts";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const fixtureDeadlines = new Map<string, number>();
type Coverage = {
  fnMap: Record<string, { name: string }>;
  f: Record<string, number>;
  s: Record<string, number>;
  b: Record<string, number[]>;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fixtureDeadlines.clear();
});

function createFixture(mode: string, floor?: number, project = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-coverage-"));
  roots.push(root);
  fixtureDeadlines.set(root, performance.now() + testTimeoutOptions(35_000).timeout - 5_000);
  fs.mkdirSync(path.join(root, "src"));
  fs.symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(root, "src/probe.ts"),
    `
export function nativeBranch(flag: boolean): string {
  if (flag) return "native-true";
  return "native-false";
}
export function ssrBranch(flag: boolean): string {
  if (flag) return "ssr-true";
  return "ssr-false";
}
export function neverCalled(): string { return "never"; }
`,
  );
  fs.writeFileSync(
    path.join(root, "src/unloaded.ts"),
    'throw new Error("Unloaded source was executed during preparation"); export function unloaded() { return 7; }',
  );
  fs.writeFileSync(path.join(root, "src/ignored.ts"), "export function ignored() { return 9; }");
  fs.writeFileSync(path.join(root, "src/native.cjs"), "exports.nativeJs = () => 42;");
  fs.writeFileSync(
    path.join(root, "probe.test.ts"),
    `
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
import {it, expect} from "vitest";
import * as ssr from "./src/probe";
import {ignored} from "./src/ignored";
const native = createRequire(import.meta.url)("./src/probe.ts");
const nativeJs = createRequire(import.meta.url)("./src/native.cjs");
it("executes only the selected loader paths", () => {
  if (${JSON.stringify(mode)} !== "omit-native") expect(native.nativeBranch(true)).toBe("native-true");
  if (${JSON.stringify(mode)} !== "omit-ssr") expect(ssr.ssrBranch(false)).toBe("ssr-false");
  expect(runInNewContext("(" + native.nativeBranch.toString() + ")(false)")).toBe("native-false");
  expect(runInNewContext("(" + ssr.ssrBranch.toString() + ")(true)")).toBe("ssr-true");
  expect(nativeJs.nativeJs()).toBe(42);
  expect(ignored()).toBe(9);
});
`,
  );
  fs.writeFileSync(
    path.join(root, "vitest.config.ts"),
    `
import {defineConfig} from "vitest/config";
import {sourceCoveragePlugin} from ${JSON.stringify(path.join(repositoryRoot, "test/helpers/source-coverage-plugin.ts"))};
${project ? `import repositoryConfig from ${JSON.stringify(path.join(repositoryRoot, "vitest.config.ts"))};` : ""}
export default defineConfig({
 root: ${JSON.stringify(root)},
 plugins: ${project ? "[]" : "[sourceCoveragePlugin()]"},
 test: {
  ${project ? `server: repositoryConfig.test.server, projects: [{plugins: [sourceCoveragePlugin()], test: {name: "nested", include: ["*.test.ts"], setupFiles: [${JSON.stringify(SOURCE_REQUIRE_HOOK)}]}}],` : ""}
  include: ["*.test.ts"],
  setupFiles: [${JSON.stringify(SOURCE_REQUIRE_HOOK)}],
  coverage: {
   provider: "custom",
   customProviderModule: ${JSON.stringify(path.join(repositoryRoot, "test/helpers/source-coverage-provider.mts"))},
   include: ["src/**/*.ts", "src/**/*.cjs"],
   exclude: ["src/ignored.ts"],
   reporter: ["json"],
   reportsDirectory: "coverage",
   thresholds: ${JSON.stringify(floor ? { functions: floor } : {})},
  },
 },
});
`,
  );
  return root;
}

function spawnFixture(root: string, args: string[], timeout = 30_000) {
  const remaining = Math.floor((fixtureDeadlines.get(root) ?? 0) - performance.now());
  expect(remaining, "Coverage fixture exhausted its shared test budget").toBeGreaterThan(0);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptionsWithoutSourceLoader(process.env.NODE_OPTIONS),
    },
    encoding: "utf8",
    timeout: Math.min(timeout, remaining),
  });
  expect(result.error, `Coverage fixture subprocess failed: ${args[0]}`).toBeUndefined();
  return result;
}

function runFixture(root: string, args = ["run", "--coverage"]) {
  return spawnFixture(root, [
    path.join(repositoryRoot, "node_modules/vitest/vitest.mjs"),
    ...args,
    "--maxWorkers=1",
  ]);
}

function functions(coverage: Coverage) {
  return Object.fromEntries(
    Object.entries(coverage.fnMap).map(([id, entry]) => [entry.name, coverage.f[id]]),
  );
}

function createShardFixture() {
  const root = createFixture("both", undefined, true);
  fs.copyFileSync(path.join(root, "probe.test.ts"), path.join(root, "second.test.ts"));
  return root;
}

function expectShardSuccess(root: string, shard: string) {
  const result = runFixture(root, ["run", "--coverage", `--shard=${shard}`, "--reporter=blob"]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

describe("original-source coverage across loaders", () => {
  it.each([
    ["source inside root", "/repo/src/a.ts", {}, true],
    ["nested source inside root", "/repo/src/nested/a.ts", {}, true],
    ["similarly named folder", "/repo/foo-src/a.ts", {}, false],
    ["nested source outside selected folder", "/repo/tools/src/a.ts", {}, false],
    ["dependency source", "/repo/node_modules/pkg/src/a.ts", {}, false],
    [
      "dependency with broad include",
      "/repo/node_modules/pkg/src/a.ts",
      {
        include: ["**"],
      },
      false,
    ],
    [
      "dependency with absolute include",
      "/repo/node_modules/pkg/src/a.ts",
      {
        include: ["/repo/node_modules/pkg/src/a.ts"],
      },
      false,
    ],
    [
      "relative exclusion",
      "/repo/src/a.ts",
      {
        exclude: ["src/a.ts"],
      },
      false,
    ],
    [
      "relative exclusion with broad include",
      "/repo/src/a.ts",
      {
        include: ["**"],
        exclude: ["src/a.ts"],
      },
      false,
    ],
    [
      "absolute inclusion",
      "/repo/src/a.ts",
      {
        include: ["/repo/src/a.ts"],
      },
      true,
    ],
    [
      "absolute exclusion",
      "/repo/src/a.ts",
      {
        exclude: ["/repo/src/a.ts"],
      },
      false,
    ],
    [
      "second configured root",
      "/other/src/a.ts",
      {
        roots: ["/repo", "/other"],
      },
      true,
    ],
    [
      "outside root denied",
      "/outside/src/a.ts",
      {
        include: ["**/src/**/*.ts"],
      },
      false,
    ],
    [
      "root name prefix denied",
      "/repo-other/src/a.ts",
      {
        include: ["**/src/**/*.ts"],
      },
      false,
    ],
    [
      "external source allowed",
      "/outside/src/a.ts",
      {
        include: ["**/src/**/*.ts"],
        allowExternal: true,
      },
      true,
    ],
    [
      "external source explicit relative pattern",
      "/outside/src/a.ts",
      {
        include: ["../outside/src/**/*.ts"],
        allowExternal: true,
      },
      true,
    ],
    [
      "external source excluded",
      "/outside/src/a.ts",
      {
        include: ["**/src/**/*.ts"],
        exclude: ["**/outside/**"],
        allowExternal: true,
      },
      false,
    ],
    [
      "external unchanged file",
      "/outside/src/a.ts",
      {
        include: ["**/src/**/*.ts"],
        allowExternal: true,
        changedFiles: ["/outside/src/b.ts"],
      },
      false,
    ],
    [
      "changed file included",
      "/repo/src/a.ts",
      {
        changedFiles: ["/repo/src/a.ts"],
      },
      true,
    ],
    [
      "unchanged file excluded",
      "/repo/src/a.ts",
      {
        changedFiles: ["/repo/src/b.ts"],
      },
      false,
    ],
    ["query suffix normalized", "/repo/src/a.ts?mode=source", {}, true],
    ["file URL normalized", "file:///repo/src/a.ts", {}, true],
  ] as const)("respects source selection: %s", (_label, filename, options, expected) => {
    const script = `
const coverage = require(${JSON.stringify(path.join(repositoryRoot, "test/helpers/source-coverage.cts"))});
coverage.enableSourceCoverage(${JSON.stringify({ roots: ["/repo"], include: ["src/**/*.ts"], exclude: [], allowExternal: false, ...options })});
console.log(JSON.stringify(coverage.shouldInstrumentSource(${JSON.stringify(filename)})));
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptionsWithoutSourceLoader(process.env.NODE_OPTIONS),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(expected);
  });
  it(
    "collects native counters from a warm disk cache without loading the instrumenter",
    testTimeoutOptions(35_000),
    () => {
      const root = createFixture("both");
      const warmup = runFixture(root);
      expect(warmup.status, `${warmup.stdout}\n${warmup.stderr}`).toBe(0);
      const filename = path.join(root, "src/probe.ts");
      const script = `
const Module = require("node:module"), load = Module._load;
Module._load = function(request, ...args) {
  if (request === "@babel/core" || request === "istanbul-lib-instrument") throw new Error("Warm native cache attempted instrumentation");
  return load.call(this, request, ...args);
};
require(${JSON.stringify(SOURCE_REQUIRE_HOOK)});
const coverage = require(${JSON.stringify(path.join(repositoryRoot, "test/helpers/source-coverage.cts"))});
coverage.enableSourceCoverage({roots:[${JSON.stringify(root)}],include:[${JSON.stringify(filename)}],exclude:[],allowExternal:false});
const probe = require(${JSON.stringify(filename)});
const value = probe.nativeBranch(true);
console.log(JSON.stringify({value,coverage:globalThis[coverage.COVERAGE_KEY][${JSON.stringify(filename)}],instrumenters:Object.keys(require.cache).filter(filename => /(?:@babel.core|istanbul-lib-instrument)/.test(filename))}));
`;
      const result = spawnFixture(root, ["-e", script], 10_000);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.value).toBe("native-true");
      expect(output.instrumenters).toEqual([]);
      expect(functions(output.coverage)).toEqual({ nativeBranch: 1, ssrBranch: 0, neverCalled: 0 });
      expect(Object.values(output.coverage.b)).toEqual([
        [1, 0],
        [0, 0],
      ]);
    },
  );

  it(
    "collects accurate counters after coverage is enabled and reenabled",
    testTimeoutOptions(35_000),
    () => {
      const root = createFixture("both");
      fs.writeFileSync(
        path.join(root, "toggle.mjs"),
        `
import fs from "node:fs";
import {createVitest} from "vitest/node";
const ctx = await createVitest("test", {
  root: ${JSON.stringify(root)}, watch: false, maxWorkers: 1,
  coverage: {enabled: false},
  experimental: {fsModuleCache: true, fsModuleCachePath: "module-cache"},
});
try {
  await ctx.start();
  await ctx.enableCoverage();
  await ctx.rerunTestSpecifications(await ctx.globTestSpecifications(), true);
  fs.copyFileSync("coverage/coverage-final.json", "first.json");
  ctx.disableCoverage();
  await ctx.rerunTestSpecifications(await ctx.globTestSpecifications(), true);
  await ctx.enableCoverage();
  await ctx.rerunTestSpecifications(await ctx.globTestSpecifications(), true);
  fs.copyFileSync("coverage/coverage-final.json", "second.json");
} finally { await ctx.close(); }
`,
      );
      const result = spawnFixture(root, [path.join(root, "toggle.mjs")]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const first = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
      const second = JSON.parse(fs.readFileSync(path.join(root, "second.json"), "utf8"));
      expect(functions(first[path.join(root, "src/probe.ts")])).toEqual({
        nativeBranch: 1,
        ssrBranch: 1,
        neverCalled: 0,
      });
      expect(functions(second[path.join(root, "src/probe.ts")])).toEqual({
        nativeBranch: 1,
        ssrBranch: 1,
        neverCalled: 0,
      });
    },
  );

  it("counts cached native and SSR modules once per suite", testTimeoutOptions(35_000), () => {
    const root = createFixture("both");
    fs.copyFileSync(path.join(root, "probe.test.ts"), path.join(root, "second.test.ts"));
    const result = runFixture(root, ["run", "--coverage", "--no-isolate", "--no-file-parallelism"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(
      fs.readFileSync(path.join(root, "coverage/coverage-final.json"), "utf8"),
    );
    expect(functions(report[path.join(root, "src/probe.ts")])).toEqual({
      nativeBranch: 2,
      ssrBranch: 2,
      neverCalled: 0,
    });
    expect(Object.values(report[path.join(root, "src/native.cjs")].f)).toEqual([2]);
  });

  it(
    "merges matching shard reports with one entry per source construct",
    testTimeoutOptions(35_000),
    () => {
      const root = createShardFixture();
      expectShardSuccess(root, "1/2");
      expectShardSuccess(root, "2/2");
      const merged = runFixture(root, ["--merge-reports", "--coverage"]);
      expect(merged.status, `${merged.stdout}\n${merged.stderr}`).toBe(0);
      const report = JSON.parse(
        fs.readFileSync(path.join(root, "coverage/coverage-final.json"), "utf8"),
      );
      expect(functions(report[path.join(root, "src/probe.ts")])).toEqual({
        nativeBranch: 2,
        ssrBranch: 2,
        neverCalled: 0,
      });
      expect(functions(report[path.join(root, "src/unloaded.ts")])).toEqual({ unloaded: 0 });
      expect(Object.values(report[path.join(root, "src/unloaded.ts")].s)).not.toContain(1);
    },
  );

  it("rejects conflicting source maps when merging shards", testTimeoutOptions(35_000), () => {
    const root = createShardFixture();
    expectShardSuccess(root, "1/2");
    const probe = path.join(root, "src/probe.ts");
    fs.writeFileSync(probe, `// Changed source locations\n${fs.readFileSync(probe, "utf8")}`);
    expectShardSuccess(root, "2/2");
    const merged = runFixture(root, ["--merge-reports", "--coverage"]);
    expect(merged.status).toBe(1);
    expect(`${merged.stdout}\n${merged.stderr}`).toContain(
      "Conflicting original-source coverage maps",
    );
  });

  it.each(["both", "project", "omit-native", "omit-ssr"])(
    "counts %s execution without duplicate source entries",
    testTimeoutOptions(35_000),
    (mode) => {
      const root = createFixture(mode, undefined, mode === "project");
      const result = runFixture(root);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const report = JSON.parse(
        fs.readFileSync(path.join(root, "coverage/coverage-final.json"), "utf8"),
      ) as Record<string, Coverage>;
      const probe = report[path.join(root, "src/probe.ts")];
      expect(Object.keys(probe.f)).toHaveLength(3);
      expect(functions(probe)).toEqual({
        nativeBranch: mode === "omit-native" ? 0 : 1,
        ssrBranch: mode === "omit-ssr" ? 0 : 1,
        neverCalled: 0,
      });
      expect(Object.values(probe.b)).toEqual([
        mode === "omit-native" ? [0, 0] : [1, 0],
        mode === "omit-ssr" ? [0, 0] : [0, 1],
      ]);
      expect(functions(report[path.join(root, "src/unloaded.ts")])).toEqual({ unloaded: 0 });
      expect(Object.values(report[path.join(root, "src/unloaded.ts")].s)).not.toContain(1);
      expect(Object.values(report[path.join(root, "src/native.cjs")].f)).toEqual([1]);
      expect(report[path.join(root, "src/ignored.ts")]).toBeUndefined();
    },
  );

  it(
    "fails an unmet coverage floor after collecting both loaders",
    testTimeoutOptions(35_000),
    () => {
      const root = createFixture("both", 90);
      const result = runFixture(root);
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Coverage for functions");
    },
  );
});
