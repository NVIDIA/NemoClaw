// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

import { createTarball } from "./tarball";

describe("archive publication", () => {
  let directory: string;
  let collectDir: string;
  const options = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tarball-test-"));
    collectDir = path.join(directory, "collected");
    fs.mkdirSync(collectDir);
    fs.writeFileSync(path.join(collectDir, "report.txt"), "diagnostic report");
    process.exitCode = undefined;
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.unstubAllEnvs();
  });

  it("refuses an occupied randomized path without removing its symlink or changing user files (#11651)", () => {
    const output = path.join(directory, "debug.tar.gz");
    const victim = path.join(directory, "user-data.txt");
    const partial = path.join(
      directory,
      ".nemoclaw-debug-00000000-0000-4000-8000-000000000000.partial",
    );
    fs.writeFileSync(output, "previous archive");
    fs.writeFileSync(victim, "unrelated user data");
    fs.symlinkSync(victim, partial);

    expect(createTarball(collectDir, output, options)).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(output, "utf8")).toBe("previous archive");
    expect(fs.readFileSync(victim, "utf8")).toBe("unrelated user data");
    expect(fs.lstatSync(partial).isSymbolicLink()).toBe(true);
  });

  it("preserves the destination and removes its partial archive when rename fails (#11651)", () => {
    const output = path.join(directory, "destination");
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, "user-data.txt"), "unrelated user data");

    expect(createTarball(collectDir, output, options)).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(path.join(output, "user-data.txt"), "utf8")).toBe("unrelated user data");
    expect(fs.readdirSync(directory).sort()).toEqual(["collected", "destination"]);
  });

  it("preserves existing output and removes its partial archive when tar cannot start (#11651)", () => {
    const output = path.join(directory, "debug.tar.gz");
    fs.writeFileSync(output, "previous archive");
    vi.stubEnv("PATH", path.join(directory, "missing-bin"));

    expect(createTarball(collectDir, output, options)).toBe(false);
    expect(options.error).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(output, "utf8")).toBe("previous archive");
    expect(fs.readdirSync(directory).sort()).toEqual(["collected", "debug.tar.gz"]);
  });
});
