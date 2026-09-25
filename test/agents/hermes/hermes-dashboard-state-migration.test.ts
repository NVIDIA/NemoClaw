// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const MIGRATOR = path.resolve("agents/hermes/migrate-dashboard-state.py");
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function fixture(): { root: string; hermes: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-migration-"));
  const hermes = path.join(root, ".hermes");
  fs.mkdirSync(hermes);
  fixtures.push(root);
  return { root, hermes };
}

function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode: 0o600 });
}

function run(hermes: string) {
  return spawnSync("python3", ["-I", MIGRATOR, "--hermes-dir", hermes], {
    encoding: "utf8",
  });
}

describe("Hermes legacy dashboard-state migration", () => {
  it("moves profile state and its WhatsApp session into the native home", () => {
    const { hermes } = fixture();
    const legacy = path.join(hermes, "profiles/dashboard-home");
    write(path.join(legacy, "MEMORY.md"), "remember me\n");
    write(path.join(legacy, "USER.md"), "operator\n");
    write(path.join(legacy, "platforms/whatsapp/session/creds.json"), '{"paired":true}\n');
    write(path.join(legacy, "config.yaml"), "model: shadow\n");
    write(path.join(legacy, ".env"), "SHADOW=1\n");

    const result = run(hermes);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(hermes, "MEMORY.md"), "utf8")).toBe("remember me\n");
    expect(fs.readFileSync(path.join(hermes, "USER.md"), "utf8")).toBe("operator\n");
    expect(
      fs.readFileSync(path.join(hermes, "platforms/whatsapp/session/creds.json"), "utf8"),
    ).toBe('{"paired":true}\n');
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(path.join(hermes, "config.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(hermes, ".env"))).toBe(false);
    expect(run(hermes).status).toBe(0);
  });

  it("retires byte-identical legacy duplicates", () => {
    const { hermes } = fixture();
    write(path.join(hermes, "MEMORY.md"), "same\n");
    write(path.join(hermes, "profiles/dashboard-home/MEMORY.md"), "same\n");

    const result = run(hermes);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(hermes, "MEMORY.md"), "utf8")).toBe("same\n");
    expect(fs.existsSync(path.join(hermes, "profiles/dashboard-home"))).toBe(false);
  });

  it("migrates the pre-profile dashboard home restored from an older snapshot", () => {
    const { hermes } = fixture();
    const legacy = path.join(hermes, "dashboard-home");
    write(path.join(legacy, "MEMORY.md"), "old snapshot\n");

    const result = run(hermes);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(hermes, "MEMORY.md"), "utf8")).toBe("old snapshot\n");
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("refuses a conflicting native destination without deleting either copy", () => {
    const { hermes } = fixture();
    const legacy = path.join(hermes, "profiles/dashboard-home/MEMORY.md");
    write(path.join(hermes, "MEMORY.md"), "native\n");
    write(legacy, "legacy\n");

    const result = run(hermes);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("conflicts with native state");
    expect(fs.readFileSync(path.join(hermes, "MEMORY.md"), "utf8")).toBe("native\n");
    expect(fs.readFileSync(legacy, "utf8")).toBe("legacy\n");
  });

  it("refuses linked legacy state", () => {
    const { root, hermes } = fixture();
    const legacy = path.join(hermes, "profiles/dashboard-home");
    fs.mkdirSync(legacy, { recursive: true });
    write(path.join(root, "outside"), "outside\n");
    fs.symlinkSync(path.join(root, "outside"), path.join(legacy, "MEMORY.md"));

    const symlinkResult = run(hermes);

    expect(symlinkResult.status).toBe(1);
    expect(symlinkResult.stderr).toContain("symbolic link");
    fs.unlinkSync(path.join(legacy, "MEMORY.md"));
    write(path.join(legacy, "MEMORY.md"), "linked\n");
    fs.linkSync(path.join(legacy, "MEMORY.md"), path.join(root, "linked-copy"));

    const hardlinkResult = run(hermes);

    expect(hardlinkResult.status).toBe(1);
    expect(hardlinkResult.stderr).toContain("hard-link count 2");
    expect(fs.readFileSync(path.join(root, "linked-copy"), "utf8")).toBe("linked\n");
  });

  it("refuses two populated legacy homes as ambiguous", () => {
    const { hermes } = fixture();
    write(path.join(hermes, "dashboard-home/MEMORY.md"), "old\n");
    write(path.join(hermes, "profiles/dashboard-home/USER.md"), "newer\n");

    const result = run(hermes);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("both legacy dashboard homes contain state");
    expect(fs.existsSync(path.join(hermes, "dashboard-home/MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(hermes, "profiles/dashboard-home/USER.md"))).toBe(true);
  });
});
