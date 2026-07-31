// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

async function loadSeal(): Promise<typeof import("./seal")> {
  return import("./seal");
}

const CONFIG_BODY = 'model = "nvidia/nemotron"\n';
const EXPECTED_RECORD = `${createHash("sha256").update(CONFIG_BODY).digest("hex")}  config.toml\n`;
const fixtures: string[] = [];

function makeConfigDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-hash-repair-"));
  fixtures.push(root);
  const configDir = path.join(root, ".deepagents");
  fs.mkdirSync(configDir, { mode: 0o2770 });
  fs.writeFileSync(path.join(configDir, "config.toml"), CONFIG_BODY, { mode: 0o660 });
  return configDir;
}

async function runRepair(
  configDir: string,
  configPath?: string,
): Promise<{ status: number | null; stderr: string }> {
  const { buildConfigHashRepairCommand } = await loadSeal();
  const [binary, ...args] = buildConfigHashRepairCommand(
    configDir,
    configPath ?? path.join(configDir, "config.toml"),
  );
  const result = spawnSync(binary, args, { encoding: "utf-8" });
  return { status: result.status, stderr: (result.stderr ?? "").trim() };
}

function hashRecordPath(configDir: string): string {
  return path.join(configDir, ".config-hash");
}

describe("parseSha256Output", () => {
  it("returns the hex hash from a standard `sha256sum <file>` line", async () => {
    const { parseSha256Output } = await loadSeal();
    const line =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  /sandbox/.openclaw/openclaw.json";
    expect(parseSha256Output(line)).toBe(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
  });

  it("returns null for empty or whitespace-only input", async () => {
    const { parseSha256Output } = await loadSeal();
    expect(parseSha256Output("")).toBeNull();
    expect(parseSha256Output("   \n\t  ")).toBeNull();
  });

  it("returns null when the first token is not a 64-char hex string", async () => {
    const { parseSha256Output } = await loadSeal();
    expect(parseSha256Output("garbage output line")).toBeNull();
    expect(parseSha256Output("0123  /sandbox/.openclaw/openclaw.json")).toBeNull();
    // 65 chars
    expect(
      parseSha256Output("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefx  /file"),
    ).toBeNull();
  });

  it("normalises uppercase hex to lowercase", async () => {
    const { parseSha256Output } = await loadSeal();
    expect(
      parseSha256Output("ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789  /file"),
    ).toBe("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
  });
});

describe("isHashVerificationIssue", () => {
  it("matches every emitted hash-failure prefix so callers refuse to re-seal", async () => {
    const { isHashVerificationIssue } = await loadSeal();
    expect(
      isHashVerificationIssue(
        "/sandbox/.openclaw/openclaw.json content drifted (sha256 ff != sealed 01)",
      ),
    ).toBe(true);
    expect(
      isHashVerificationIssue("/sandbox/.openclaw/openclaw.json sha256sum failed: I/O error"),
    ).toBe(true);
    expect(
      isHashVerificationIssue(
        "/sandbox/.openclaw/openclaw.json sha256sum output unparsable: garbage",
      ),
    ).toBe(true);
    expect(
      isHashVerificationIssue(
        "/sandbox/.openclaw/openclaw.json no seal recorded (expected SHA-256)",
      ),
    ).toBe(true);
  });

  it("rejects unrelated perm-only entries so they remain launderable by re-lock", async () => {
    const { isHashVerificationIssue } = await loadSeal();
    expect(
      isHashVerificationIssue("/sandbox/.openclaw/openclaw.json mode=660 (expected 444)"),
    ).toBe(false);
    expect(
      isHashVerificationIssue(
        "/sandbox/.openclaw/openclaw.json owner=sandbox:sandbox (expected root:root)",
      ),
    ).toBe(false);
    expect(isHashVerificationIssue("dir mode=2770 (expected 755)")).toBe(false);
  });
});

describe("buildConfigHashRepairCommand", () => {
  afterEach(() => {
    while (fixtures.length > 0) {
      fs.rmSync(fixtures.pop() as string, { recursive: true, force: true });
    }
  });

  it("runs the repair helper under an isolated interpreter", async () => {
    const { buildConfigHashRepairCommand, CONFIG_HASH_REPAIR_NOFOLLOW_SCRIPT } = await loadSeal();
    expect(
      buildConfigHashRepairCommand("/sandbox/.deepagents", "/sandbox/.deepagents/config.toml"),
    ).toEqual([
      "python3",
      "-I",
      "-c",
      CONFIG_HASH_REPAIR_NOFOLLOW_SCRIPT,
      "/sandbox/.deepagents",
      "/sandbox/.deepagents/config.toml",
    ]);
  });

  it("writes a read-only record for a config directory that has none", async () => {
    const configDir = makeConfigDir();

    expect(await runRepair(configDir)).toEqual({ status: 0, stderr: "" });

    const record = hashRecordPath(configDir);
    expect(fs.readFileSync(record, "utf-8")).toBe(EXPECTED_RECORD);
    expect(fs.statSync(record).mode & 0o777).toBe(0o444);
  });

  it("keeps an existing record even when its digest is stale", async () => {
    const configDir = makeConfigDir();
    const record = hashRecordPath(configDir);
    const staleRecord = `${"0".repeat(64)}  config.toml\n`;
    fs.writeFileSync(record, staleRecord, { mode: 0o660 });
    const modeBefore = fs.statSync(record).mode & 0o777;

    expect(await runRepair(configDir)).toEqual({ status: 0, stderr: "" });

    expect(fs.readFileSync(record, "utf-8")).toBe(staleRecord);
    expect(fs.statSync(record).mode & 0o777).toBe(modeBefore);
  });

  it("refuses a symlink planted at the record name", async () => {
    const configDir = makeConfigDir();
    const record = hashRecordPath(configDir);
    const outside = path.join(configDir, "..", "outside");
    fs.writeFileSync(outside, "untouched\n");
    fs.symlinkSync(outside, record);

    const outcome = await runRepair(configDir);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("not a regular file");
    expect(fs.lstatSync(record).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, "utf-8")).toBe("untouched\n");
  });

  it("refuses a directory planted at the record name", async () => {
    const configDir = makeConfigDir();
    fs.mkdirSync(hashRecordPath(configDir));

    const outcome = await runRepair(configDir);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("not a regular file");
  });

  it("refuses to read a config file that is a symlink", async () => {
    const configDir = makeConfigDir();
    const configPath = path.join(configDir, "config.toml");
    const outside = path.join(configDir, "..", "secret");
    fs.writeFileSync(outside, "secret\n");
    fs.rmSync(configPath);
    fs.symlinkSync(outside, configPath);

    const outcome = await runRepair(configDir);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("refusing symlink path");
    expect(fs.existsSync(hashRecordPath(configDir))).toBe(false);
  });

  it("refuses a config path outside the config directory", async () => {
    const configDir = makeConfigDir();
    const outside = path.join(configDir, "..", "elsewhere.toml");
    fs.writeFileSync(outside, CONFIG_BODY);

    const outcome = await runRepair(configDir, outside);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("refusing config path outside config dir");
    expect(fs.existsSync(hashRecordPath(configDir))).toBe(false);
  });
});
