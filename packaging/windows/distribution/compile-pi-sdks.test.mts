// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { compileSdk, compiledExports } from "./compile-pi-sdks.mts";

test("SDK exports retain conditional targets and explicit overrides after compaction", () => {
  assert.deepEqual(
    compiledExports(
      {
        ".": {
          types: "./types.d.ts",
          source: "./src.ts",
          import: "./esm/index.js",
          require: "./cjs/index.js",
        },
        "./special": "./special.js",
        "./*": { default: "./esm/*.js" },
      },
      { "./esm/index.js": "./esm/e-index.mjs", "./esm/special.js": "./esm/e-special.mjs" },
    ),
    {
      ".": { import: "./esm/e-index.mjs", require: "./cjs/index.js" },
      "./special": "./special.js",
      "./index": { default: "./esm/e-index.mjs" },
    },
  );
  assert.throws(
    () => compiledExports({ "./*": { require: "./*.js" } }, {}),
    /Unsupported SDK export pattern/,
  );
  assert.throws(
    () => compiledExports({ "./*/*": "./esm/*.js" }, { "./esm/index.js": "./esm/e-index.mjs" }),
    /Unsupported SDK export key/,
  );
  assert.deepEqual(
    compiledExports({ "./*.js": "./esm/*.js" }, { "./esm/$&.js": "./esm/e-dollar.mjs" }),
    { "./$&.js": "./esm/e-dollar.mjs" },
  );
});

test("compiled SDK modules preserve live bindings, resources, and short paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-test-"));
  try {
    const source = path.join(root, "source"),
      output = path.join(root, "compiled");
    fs.mkdirSync(path.join(source, "esm"), { recursive: true });
    const long = "long-operation-".repeat(9) + ".js";
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "@mistralai/mistralai",
        version: "1",
        type: "module",
        main: "./esm/index.js",
        exports: { ".": "./esm/index.js", "./*": { default: "./esm/*.js" } },
      }),
    );
    fs.mkdirSync(path.join(source, "packages"));
    fs.writeFileSync(path.join(source, "packages/source.ts"), "unshipped development workspace");
    fs.writeFileSync(path.join(source, "LICENSE"), "retained-license");
    fs.writeFileSync(
      path.join(source, "esm", long),
      "export let count=0; export function increment(){count++;}",
    );
    fs.writeFileSync(path.join(source, "esm/index.js"), `export * from './${long}';`);
    const compiler = createRequire(import.meta.url)("esbuild");
    const result = await compileSdk(source, output, "esm", compiler);
    assert.equal(result.entrypoints, 2);
    assert(!fs.existsSync(path.join(output, "packages")));
    assert.equal(fs.readFileSync(path.join(output, "LICENSE"), "utf8"), "retained-license");
    assert(result.files.every((file) => file.path.length < 50));
    const metadata = JSON.parse(fs.readFileSync(path.join(output, "package.json"), "utf8"));
    const execution = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const api = await import(process.argv[1]);
       const subpath = await import(process.argv[2]);
       api.increment();
       console.log(JSON.stringify([api.count, subpath.count]));`,
        pathToFileURL(path.join(output, metadata.main)).href,
        pathToFileURL(path.join(output, metadata.exports["./" + long.slice(0, -3)].default)).href,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(execution.error, undefined);
    assert.equal(execution.status, 0, execution.stderr);
    assert.deepEqual(JSON.parse(execution.stdout), [1, 1]);
    await assert.rejects(compileSdk(source, output, "esm", compiler), /must be fresh/);
    await assert.rejects(compileSdk(source, path.join(root, "wrong"), "esm", { version: "other" }));
    await assert.rejects(
      compileSdk(source, path.join(root, "failed"), "esm", {
        version: "0.27.4",
        build: async () => {
          throw new Error("compiler-failed");
        },
      }),
      /compiler-failed/,
    );
    assert(!fs.existsSync(path.join(root, "failed")));
    await assert.rejects(
      compileSdk(source, path.join(root, "changed"), "esm", {
        version: "0.27.4",
        build: async (options: any) => {
          const built = await compiler.build(options);
          fs.appendFileSync(path.join(source, "esm/index.js"), "\n// changed");
          return built;
        },
      }),
      /input changed/,
    );
    assert(!fs.existsSync(path.join(root, "changed")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
