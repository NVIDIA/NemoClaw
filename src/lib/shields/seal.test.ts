// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ifError } from "node:assert";
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

type RepairOutcome = { status: number | null; stderr: string };

function makeConfigDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-hash-repair-"));
  fixtures.push(root);
  const configDir = path.join(root, ".deepagents");
  fs.mkdirSync(configDir, { mode: 0o2770 });
  fs.writeFileSync(path.join(configDir, "config.toml"), CONFIG_BODY, { mode: 0o660 });
  return configDir;
}

function runRepairCommand(command: string[]): RepairOutcome {
  const [binary, ...args] = command;
  const result = spawnSync(binary, args, { encoding: "utf-8" });
  ifError(result.error);
  return { status: result.status, stderr: (result.stderr ?? "").trim() };
}

async function runRepair(configDir: string, configPath?: string): Promise<RepairOutcome> {
  const { buildConfigHashRepairCommand } = await loadSeal();
  return runRepairCommand(
    buildConfigHashRepairCommand(configDir, configPath ?? path.join(configDir, "config.toml")),
  );
}

function hashRecordPath(configDir: string): string {
  return path.join(configDir, ".config-hash");
}

function readBodyAndMode(pathname: string): { body: string; mode: number } {
  const fd = fs.openSync(pathname, "r");
  try {
    return {
      body: fs.readFileSync(fd, "utf-8"),
      mode: fs.fstatSync(fd).mode & 0o777,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function racePlantWrapper(source: string, outside: string): string {
  const encoded = Buffer.from(source, "utf-8").toString("base64");
  return String.raw`
import base64
import errno
import os

source = base64.b64decode("${encoded}").decode("utf-8")
outside = ${JSON.stringify(outside)}
real_open = os.open
real_stat = os.stat
real_symlink = os.symlink
state = {"first_hash_stat": True}

def raced_stat(path, *args, **kwargs):
    if path == ".config-hash" and state["first_hash_stat"]:
        state["first_hash_stat"] = False
        raise FileNotFoundError(errno.ENOENT, "injected absent record", path)
    return real_stat(path, *args, **kwargs)

def raced_open(path, flags, *args, **kwargs):
    if path == ".config-hash" and flags & os.O_EXCL:
        real_symlink(outside, path, dir_fd=kwargs.get("dir_fd"))
        raise FileExistsError(errno.EEXIST, "injected competing record", path)
    return real_open(path, flags, *args, **kwargs)

os.stat = raced_stat
os.open = raced_open
exec(compile(source, "<config-hash-repair>", "exec"), {"__name__": "__main__"})
`;
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

  it("pins and publishes the managed sandbox parent around repair", async () => {
    const configDir = makeConfigDir();
    const parentDir = path.dirname(configDir);
    fs.chmodSync(parentDir, 0o755);
    const { buildConfigHashRepairCommand } = await loadSeal();
    const command = buildConfigHashRepairCommand(configDir, path.join(configDir, "config.toml"));
    command.push("--test-protect-parent");

    const outcome = runRepairCommand(command);

    expect(outcome).toEqual({ status: 0, stderr: "" });
    expect(fs.statSync(parentDir).mode & 0o7777).toBe(0o1775);
    expect(fs.statSync(configDir).mode & 0o7777).toBe(0o755);
  });

  it("restores parent and config metadata when protected repair fails", async () => {
    const configDir = makeConfigDir();
    const parentDir = path.dirname(configDir);
    const outside = path.join(parentDir, "outside");
    fs.writeFileSync(outside, "untouched\n");
    fs.symlinkSync(outside, hashRecordPath(configDir));
    fs.chmodSync(parentDir, 0o751);
    fs.chmodSync(configDir, 0o2770);
    const initialConfigMode = fs.statSync(configDir).mode & 0o7777;
    const { buildConfigHashRepairCommand } = await loadSeal();
    const command = buildConfigHashRepairCommand(configDir, path.join(configDir, "config.toml"));
    command.push("--test-protect-parent");

    const outcome = runRepairCommand(command);

    expect(outcome.status).toBe(1);
    expect(fs.statSync(parentDir).mode & 0o7777).toBe(0o751);
    expect(fs.statSync(configDir).mode & 0o7777).toBe(initialConfigMode);
    expect(fs.readFileSync(outside, "utf-8")).toBe("untouched\n");
  });

  it("keeps an existing record even when its digest is stale", async () => {
    const configDir = makeConfigDir();
    const record = hashRecordPath(configDir);
    const staleRecord = `${"0".repeat(64)}  config.toml\n`;
    fs.writeFileSync(record, staleRecord, { mode: 0o660 });
    fs.chmodSync(record, 0o640);

    expect(await runRepair(configDir)).toEqual({ status: 0, stderr: "" });

    expect(readBodyAndMode(record)).toEqual({ body: staleRecord, mode: 0o640 });
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

  it("refuses a symlink that wins the exclusive-create race", async () => {
    const configDir = makeConfigDir();
    const record = hashRecordPath(configDir);
    const outside = path.join(configDir, "..", "race-target");
    fs.writeFileSync(outside, "untouched\n");
    const { buildConfigHashRepairCommand, CONFIG_HASH_REPAIR_NOFOLLOW_SCRIPT } = await loadSeal();
    const command = buildConfigHashRepairCommand(configDir, path.join(configDir, "config.toml"));
    command[3] = racePlantWrapper(CONFIG_HASH_REPAIR_NOFOLLOW_SCRIPT, outside);

    const outcome = runRepairCommand(command);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("not a regular file");
    expect(fs.readlinkSync(record)).toBe(outside);
    expect(fs.readFileSync(outside, "utf-8")).toBe("untouched\n");
  });

  it("refuses a multiply linked record", async () => {
    const configDir = makeConfigDir();
    const record = hashRecordPath(configDir);
    const outside = path.join(configDir, "..", "linked-record");
    fs.writeFileSync(outside, "untouched\n");
    fs.linkSync(outside, record);

    const outcome = await runRepair(configDir);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("refusing multiply linked file");
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

  it("still validates the config file when a hash record already exists", async () => {
    const configDir = makeConfigDir();
    const configPath = path.join(configDir, "config.toml");
    const outside = path.join(configDir, "..", "secret");
    fs.writeFileSync(hashRecordPath(configDir), EXPECTED_RECORD);
    fs.writeFileSync(outside, "secret\n");
    fs.rmSync(configPath);
    fs.symlinkSync(outside, configPath);

    const outcome = await runRepair(configDir);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("refusing symlink path");
    expect(fs.readFileSync(outside, "utf-8")).toBe("secret\n");
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

  it("fails before opening paths when O_NOFOLLOW is unavailable", async () => {
    const configDir = makeConfigDir();
    const { buildConfigHashRepairCommand, CONFIG_HASH_REPAIR_NOFOLLOW_SCRIPT } = await loadSeal();
    const command = buildConfigHashRepairCommand(configDir, path.join(configDir, "config.toml"));
    const encoded = Buffer.from(CONFIG_HASH_REPAIR_NOFOLLOW_SCRIPT, "utf-8").toString("base64");
    command[3] = String.raw`
import base64
import os

delattr(os, "O_NOFOLLOW")
source = base64.b64decode("${encoded}").decode("utf-8")
exec(compile(source, "<config-hash-repair>", "exec"), {"__name__": "__main__"})
`;

    const outcome = runRepairCommand(command);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("required open flag is unavailable: O_NOFOLLOW");
    expect(fs.existsSync(hashRecordPath(configDir))).toBe(false);
  });
});
