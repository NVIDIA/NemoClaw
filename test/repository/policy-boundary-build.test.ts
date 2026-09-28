// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validationFixture, writeFixture } from "./validation-fixture";

let root: string;
const compilerPath = path.resolve("node_modules/.bin");
beforeEach(() => {
  root = validationFixture();
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  writeFixture(
    root,
    "package.json",
    JSON.stringify({ scripts: { "build:policy-boundary": pkg.scripts["build:policy-boundary"] } }),
  );
  writeFixture(
    root,
    "nemoclaw/tsconfig.shared.json",
    JSON.stringify({
      compilerOptions: { rootDir: "src", outDir: "dist", types: [] },
      include: ["src"],
    }),
  );
  writeFixture(root, "nemoclaw/src/boundary.ts", "export const value: number = 1;\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function build() {
  return spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build:policy-boundary"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${compilerPath}${path.delimiter}${process.env.PATH}`,
        npm_config_cache: path.join(root, "npm-cache"),
      },
      shell: process.platform === "win32",
    },
  );
}

describe("shared policy compilation", () => {
  it("restores a deleted output after an incremental build", () => {
    const initial = build();
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    const output = path.join(root, "nemoclaw/dist/boundary.js");
    rmSync(output);
    const repeated = build();
    expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0);
    const observed = spawnSync(
      process.execPath,
      ["-e", "console.log(require(process.argv[1]).value)", output],
      { encoding: "utf8" },
    );
    expect(observed.status, observed.stderr).toBe(0);
    expect(observed.stdout.trim()).toBe("1");
  });

  it("rejects a new type error after a successful build", () => {
    expect(build().status).toBe(0);
    writeFixture(root, "nemoclaw/src/boundary.ts", 'export const value: number = "invalid";\n');
    expect(build().status).not.toBe(0);
  });
});
