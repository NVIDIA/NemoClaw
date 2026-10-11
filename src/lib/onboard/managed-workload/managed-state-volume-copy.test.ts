// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { managedStateVolumeCopyProgram } from "./managed-state-volume-copy";

it("builds a valid isolated Node copy program", () => {
  expect(() => new vm.Script(managedStateVolumeCopyProgram())).not.toThrow();
});

let directory: string;
function fixture() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "managed-copy-program-"));
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination");
  fs.mkdirSync(source, { mode: 0o2770 });
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "state"), "synthetic state", { mode: 0o640 });
  fs.linkSync(path.join(source, "state"), path.join(source, "hardlink"));
  fs.symlinkSync("state", path.join(source, "link"));
  fs.writeFileSync(path.join(directory, "outside"), "untouched");
  fs.symlinkSync("../outside", path.join(source, "outside-link"));
  fs.mkdirSync(path.join(source, "nested"), { mode: 0o750 });
  fs.writeFileSync(path.join(source, "nested", "file"), "nested data");
  const program = managedStateVolumeCopyProgram()
    .replace('const source = "/source";', `const source = ${JSON.stringify(source)};`)
    .replace(
      'const destination = "/destination";',
      `const destination = ${JSON.stringify(destination)};`,
    );
  return {
    source,
    destination,
    run: () => spawnSync(process.execPath, ["-e", program], { encoding: "utf8", timeout: 15_000 }),
  };
}

// Synthetic private directories exercise the pinned helper's GNU copy/archive commands.
// These tests do not establish container mount isolation or live user-data migration.
describe.skipIf(process.platform !== "linux")("Linux managed-state copy program", () => {
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("verifies contents, links, modes and directory metadata while retaining the original", () => {
    const { source, destination, run } = fixture();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(fs.readFileSync(path.join(destination, "state"), "utf8")).toBe("synthetic state");
    expect(fs.readFileSync(path.join(source, "state"), "utf8")).toBe("synthetic state");
    expect(fs.readFileSync(path.join(directory, "outside"), "utf8")).toBe("untouched");
    expect(fs.statSync(path.join(destination, "hardlink")).ino).toBe(
      fs.statSync(path.join(destination, "state")).ino,
    );
    expect(fs.readlinkSync(path.join(destination, "outside-link"))).toBe("../outside");
    expect(fs.statSync(destination).mode).toBe(fs.statSync(source).mode);
    expect(fs.statSync(path.join(destination, "state")).mode).toBe(
      fs.statSync(path.join(source, "state")).mode,
    );
    expect(fs.statSync(path.join(destination, "nested")).mode).toBe(
      fs.statSync(path.join(source, "nested")).mode,
    );
    expect(fs.statSync(path.join(destination, "nested/file")).mode).toBe(
      fs.statSync(path.join(source, "nested/file")).mode,
    );
  });

  it("refuses a nonempty destination without overwriting either volume", () => {
    const { source, destination, run } = fixture();
    fs.writeFileSync(path.join(destination, "existing"), "keep");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("synthetic state");
    expect(fs.readdirSync(destination)).toEqual(["existing"]);
    expect(fs.readFileSync(path.join(destination, "existing"), "utf8")).toBe("keep");
    expect(fs.readFileSync(path.join(source, "state"), "utf8")).toBe("synthetic state");
  });

  it("rejects unsupported special files before copying", () => {
    const { source, destination, run } = fixture();
    expect(spawnSync("mkfifo", [path.join(source, "pipe")]).status).toBe(0);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("synthetic state");
    expect(fs.readdirSync(destination)).toEqual([]);
    expect(fs.readFileSync(path.join(source, "state"), "utf8")).toBe("synthetic state");
  });
});
