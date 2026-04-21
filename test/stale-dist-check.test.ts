// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

type Stream = { write(chunk: string): unknown };

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
    const result = checkStaleDist(root);
    expect(result).not.toBeNull();
    expect(result!.srcMtime).toBeGreaterThan(result!.distMtime);
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

  it("warnIfStale writes a build:cli hint mentioning #1958", () => {
    writeFile(path.join(root, "dist", "lib", "foo.js"), "x", 1_000_000);
    writeFile(path.join(root, "src", "lib", "foo.ts"), "x", 5_000_000);
    const chunks: string[] = [];
    const stream: Stream = { write: (chunk: string) => chunks.push(chunk) };
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
});
