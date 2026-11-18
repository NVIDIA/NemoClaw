// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { patchBundledNpmNodeGyp } from "../../scripts/lib/patch-bundled-npm-node-gyp.mts";

const directories: string[] = [];
const original = fs.readFileSync(
  new URL("../fixtures/node-gyp/build.cjs.fixture", import.meta.url),
  "utf8",
);
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "npm-node-gyp-"));
  directories.push(root);
  const modules = join(root, "node_modules");
  const gyp = join(modules, "node-gyp");
  const tiny = join(modules, "tinyglobby");
  fs.mkdirSync(join(gyp, "lib"), { recursive: true });
  fs.mkdirSync(join(tiny, "node_modules/picomatch"), { recursive: true });
  fs.writeFileSync(join(root, "package.json"), JSON.stringify({ name: "npm", version: "12.2.1" }));
  fs.writeFileSync(
    join(gyp, "package.json"),
    JSON.stringify({
      name: "node-gyp",
      version: "13.0.0",
      dependencies: { tinyglobby: "^0.2.12", semver: "^7.3.5" },
    }),
  );
  fs.writeFileSync(
    join(tiny, "package.json"),
    JSON.stringify({ name: "tinyglobby", version: "0.2.17" }),
  );
  fs.writeFileSync(
    join(tiny, "node_modules/picomatch/package.json"),
    JSON.stringify({ name: "picomatch", version: "4.0.5" }),
  );
  fs.writeFileSync(join(gyp, "lib/build.js"), original);
  return { root, gyp, tiny, source: join(gyp, "lib/build.js") };
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it("removes the vulnerable dependency and safely reapplies the reviewed patch", () => {
  const target = fixture();
  patchBundledNpmNodeGyp(target.root);
  expect(fs.existsSync(target.tiny)).toBe(false);
  expect(
    JSON.parse(fs.readFileSync(join(target.gyp, "package.json"), "utf8")).dependencies,
  ).toEqual({ semver: "^7.3.5" });
  const patched = fs.readFileSync(target.source, "utf8");
  patchBundledNpmNodeGyp(target.root);
  expect(fs.readFileSync(target.source, "utf8")).toBe(patched);
});

it.each([
  {
    drift: "source",
    mutate: (target: ReturnType<typeof fixture>) =>
      fs.appendFileSync(target.source, "\n// drift\n"),
  },
  {
    drift: "identity",
    mutate: (target: ReturnType<typeof fixture>) =>
      fs.writeFileSync(
        join(target.gyp, "package.json"),
        JSON.stringify({ name: "node-gyp", version: "14.0.0", dependencies: {} }),
      ),
  },
  {
    drift: "symlink",
    mutate: (target: ReturnType<typeof fixture>) =>
      fs.symlinkSync(target.source, join(target.tiny, "linked")),
  },
])("rejects $drift drift before removing dependencies", ({ mutate }) => {
  const target = fixture();
  mutate(target);
  expect(() => patchBundledNpmNodeGyp(target.root)).toThrow(/drifted|unsafe/);
  expect(fs.existsSync(target.tiny)).toBe(true);
});

function runWindowsBuild(filename: string) {
  const target = fixture();
  patchBundledNpmNodeGyp(target.root);
  const build = join(target.root, "build");
  fs.mkdirSync(join(build, "directory.sln"), { recursive: true });
  fs.symlinkSync("missing", join(build, "broken.sln"));
  fs.writeFileSync(join(build, filename), "fixture");
  const calls: string[] = [];
  const spawned: { command: string; args: string[] }[] = [];
  const module = { exports: {} as (gyp: object, argv: string[]) => Promise<void> };
  const modules: Record<string, unknown> = {
    "graceful-fs": {
      existsSync: () => false,
      promises: {
        readFile: async () =>
          JSON.stringify({
            target_defaults: {},
            variables: { target_arch: "x64", msbuild_path: "MSBuild.exe" },
          }),
      },
    },
    "node:fs/promises": {
      glob(pattern: string) {
        calls.push(pattern);
        return fs.promises.glob(pattern, { cwd: target.root });
      },
      stat: (file: string) => fs.promises.stat(join(target.root, file)),
    },
    path: { resolve: (...parts: string[]) => parts.join("/"), extname: () => "" },
    "./log": { verbose() {}, logger: { isVisible: () => false } },
    which: async (command: string) => command,
  };
  vm.runInNewContext(fs.readFileSync(target.source, "utf8"), {
    module,
    process: { platform: "win32", env: {} },
    require: (name: string) => modules[name],
  });
  const result = module.exports(
    {
      opts: {},
      spawn(command: string, args: string[]) {
        spawned.push({ command, args });
        return {
          on(_event: string, callback: (code: number) => void) {
            callback(0);
          },
        };
      },
    },
    [],
  );
  return { result, spawned, calls };
}

it.each([
  {
    file: "addon.sln",
    command: "MSBuild.exe",
    argument: "build/addon.sln",
    patterns: ["build/*.sln"],
  },
  { file: "addon.mk", command: "make", argument: "build", patterns: ["build/*.sln", "build/*.mk"] },
])(
  "selects $command for $file using native filesystem discovery",
  async ({ file, command, argument, patterns }) => {
    const outcome = runWindowsBuild(file);
    await outcome.result;
    expect(outcome.spawned[0].command).toBe(command);
    expect(outcome.spawned[0].args).toContain(argument);
    expect(outcome.calls).toEqual(patterns);
  },
);

it("rejects a Windows build without a solution or Makefile", async () => {
  const outcome = runWindowsBuild("ignored.txt");
  await expect(outcome.result).rejects.toThrow("Could not find *.sln");
  expect(outcome.spawned).toEqual([]);
});

it("recovers after unused-tree removal fails, with patched code already published", () => {
  const target = fixture();
  const failure = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
    throw new Error("removal interrupted");
  });
  syncBuiltinESMExports();
  expect(() => patchBundledNpmNodeGyp(target.root)).toThrow("removal interrupted");
  expect(fs.existsSync(target.tiny)).toBe(true);
  expect(
    JSON.parse(fs.readFileSync(join(target.gyp, "package.json"), "utf8")).dependencies,
  ).toEqual({ semver: "^7.3.5" });
  failure.mockRestore();
  syncBuiltinESMExports();
  patchBundledNpmNodeGyp(target.root);
  expect(fs.existsSync(target.tiny)).toBe(false);
});
