// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkStaleDist, warnIfStale } from "../src/lib/stale-dist-check";

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stale-dist-"));
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist", "lib"), { recursive: true });
  return root;
}

function writeFile(p: string, content: string, mtimeMs: number) {
  fs.writeFileSync(p, content);
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
}

type Stream = { write(chunk: string): void | boolean };

function requireStaleResult(result: ReturnType<typeof checkStaleDist>) {
  expect(result).not.toBeNull();
  if (!result) {
    throw new Error("Expected stale dist result to be present");
  }
  return result;
}

describe("stale-dist-check", () => {
  let root = "";

  beforeEach(() => {
    root = mkRepo();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns null when dist is newer than src (fresh build)", () => {
    writeFile(path.join(root, "src", "lib", "foo.ts"), "x", 1_000_000);
    writeFile(path.join(root, "dist", "lib", "foo.js"), "x", 2_000_000);
    expect(checkStaleDist(root)).toBeNull();
  });

  it("flags stale when src is newer than dist", () => {
    writeFile(path.join(root, "dist", "lib", "foo.js"), "x", 1_000_000);
    writeFile(path.join(root, "src", "lib", "foo.ts"), "x", 5_000_000);
    const result = requireStaleResult(checkStaleDist(root));
    expect(result.srcMtime).toBeGreaterThan(result.distMtime);
  });

  it("ignores .test.ts files (they do not ship to dist/)", () => {
    writeFile(path.join(root, "dist", "lib", "foo.js"), "x", 2_000_000);
    writeFile(path.join(root, "src", "lib", "foo.ts"), "x", 1_000_000);
    // Newer test file alone should NOT flag stale.
    writeFile(path.join(root, "src", "lib", "foo.test.ts"), "x", 9_000_000);
    expect(checkStaleDist(root)).toBeNull();
  });

  it("no-ops when src/ is missing (published npm install)", () => {
    fs.rmSync(path.join(root, "src"), { recursive: true });
    writeFile(path.join(root, "dist", "lib", "foo.js"), "x", 1_000_000);
    expect(checkStaleDist(root)).toBeNull();
  });

  it("no-ops when dist/ is missing", () => {
    fs.rmSync(path.join(root, "dist"), { recursive: true });
    writeFile(path.join(root, "src", "lib", "foo.ts"), "x", 1_000_000);
    expect(checkStaleDist(root)).toBeNull();
  });

  it("tolerates the grace window (src barely newer than dist)", () => {
    writeFile(path.join(root, "dist", "lib", "foo.js"), "x", 1_000_000);
    writeFile(path.join(root, "src", "lib", "foo.ts"), "x", 1_000_500);
    expect(checkStaleDist(root)).toBeNull();
  });

  it("writes a build:cli hint mentioning the tracked issue in warnIfStale (#1958)", () => {
    writeFile(path.join(root, "dist", "lib", "foo.js"), "x", 1_000_000);
    writeFile(path.join(root, "src", "lib", "foo.ts"), "x", 5_000_000);
    const chunks: string[] = [];
    const stream: Stream = {
      write: (chunk: string) => {
        chunks.push(chunk);
      },
    };
    expect(warnIfStale(root, stream)).toBe(true);
    const output = chunks.join("");
    expect(output).toContain("npm run build:cli");
    expect(output).toContain("#1958");
  });

  it("warnIfStale returns false for a fresh build", () => {
    writeFile(path.join(root, "src", "lib", "foo.ts"), "x", 1_000_000);
    writeFile(path.join(root, "dist", "lib", "foo.js"), "x", 2_000_000);
    const stream: Stream = { write: (_chunk: string) => undefined };
    expect(warnIfStale(root, stream)).toBe(false);
  });

  it("warnIfStale swallows stream write errors (never throws)", () => {
    writeFile(path.join(root, "dist", "lib", "foo.js"), "x", 1_000_000);
    writeFile(path.join(root, "src", "lib", "foo.ts"), "x", 5_000_000);
    const throwingStream: Stream = {
      write: (_chunk: string) => {
        throw new Error("EPIPE");
      },
    };
    expect(() => warnIfStale(root, throwingStream)).not.toThrow();
    expect(warnIfStale(root, throwingStream)).toBe(false);
  });

  it("runs from an unrelated directory and fails open when its helper cannot load", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const fixtureEntry = path.join(root, "scripts", "check-stale-dist.mts");
    const fixtureHelper = path.join(root, "src", "lib", "stale-dist-check.ts");
    fs.mkdirSync(path.dirname(fixtureEntry), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "scripts", "check-stale-dist.mts"), fixtureEntry);
    writeFile(
      fixtureHelper,
      fs.readFileSync(path.join(repoRoot, "src", "lib", "stale-dist-check.ts"), "utf8"),
      5_000_000,
    );
    writeFile(path.join(root, "dist", "lib", "stale-dist-check.js"), "", 1_000_000);

    const runHook = () =>
      spawnSync(process.execPath, ["--experimental-strip-types", fixtureEntry], {
        cwd: os.tmpdir(),
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "" },
      });

    const warning = runHook();
    expect(warning.status, warning.stderr).toBe(0);
    expect(warning.stderr).toContain("compiled dist/ is older than src/");

    fs.rmSync(fixtureHelper);
    const missingHelper = runHook();
    expect(missingHelper.status, missingHelper.stderr).toBe(0);
  });
});
