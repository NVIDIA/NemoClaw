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

const EFFECTIVE_UID = process.geteuid?.() ?? os.userInfo().uid;
const EFFECTIVE_GID = process.getegid?.() ?? os.userInfo().gid;

const DEEP_AGENTS_LOCK_ERROR_PREFIX = "NEMOCLAW_DEEP_AGENTS_CONFIG_LOCK_ERROR_V1";
type DeepAgentsLockFailure =
  | "config-root"
  | "sandbox-parent"
  | "incomplete"
  | "rollback-failed"
  | "transaction-failed";

function lockFailure(status: DeepAgentsLockFailure): string {
  return `${DEEP_AGENTS_LOCK_ERROR_PREFIX}:${status}`;
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

describe("buildDeepAgentsConfigLockCommand", () => {
  afterEach(() => {
    while (fixtures.length > 0) {
      fs.rmSync(fixtures.pop() as string, { recursive: true, force: true });
    }
  });

  async function lockCommand(configDir: string, failClosedOnError = false): Promise<string[]> {
    const { buildDeepAgentsConfigLockCommand } = await loadSeal();
    return buildDeepAgentsConfigLockCommand(
      configDir,
      path.join(configDir, "config.toml"),
      failClosedOnError,
    );
  }

  function expectFailClosedPosture(configDir: string): void {
    const configDirStat = fs.statSync(configDir);
    const parentDirStat = fs.statSync(path.dirname(configDir));
    expect(configDirStat.mode & 0o7777).toBe(0o500);
    expect(configDirStat.uid).toBe(EFFECTIVE_UID);
    expect(configDirStat.gid).toBe(EFFECTIVE_GID);
    expect(parentDirStat.mode & 0o7777).toBe(0o1775);
    expect(parentDirStat.uid).toBe(EFFECTIVE_UID);
    expect(parentDirStat.gid).toBe(EFFECTIVE_GID);
  }

  function restoreFixtureAccess(configDir: string): void {
    fs.chmodSync(configDir, 0o700);
    fs.chmodSync(path.dirname(configDir), 0o700);
  }

  function runLock(command: string[], inheritedFd?: number) {
    const [binary, ...args] = command;
    const result = spawnSync(binary, args, {
      encoding: "utf-8",
      ...(inheritedFd === undefined ? {} : { stdio: ["ignore", "pipe", "pipe", inheritedFd] }),
    });
    ifError(result.error);
    return {
      status: result.status,
      stdout: String(result.stdout ?? "").trim(),
      stderr: String(result.stderr ?? "").trim(),
    };
  }
  type FileObservation = { body: Buffer; inode: number; mode: number };

  function observeFile(pathname: string): FileObservation {
    const fd = fs.openSync(pathname, "r");
    try {
      const stat = fs.fstatSync(fd);
      return {
        body: fs.readFileSync(fd),
        inode: stat.ino,
        mode: stat.mode & 0o7777,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  function injectedScript(source: string, body: string): string {
    const encoded = Buffer.from(source, "utf-8").toString("base64");
    return String.raw`
import base64
import os

source = base64.b64decode("${encoded}").decode("utf-8")
${body}
exec(compile(source, "<deep-agents-config-lock>", "exec"), {"__name__": "__main__"})
`;
  }

  it("fresh-replaces the config and record from one snapshot despite a retained writable descriptor (#7977)", async () => {
    const configDir = makeConfigDir();
    const configPath = path.join(configDir, "config.toml");
    const recordPath = hashRecordPath(configDir);
    const retainedFd = fs.openSync(configPath, "r+");
    const oldInode = fs.fstatSync(retainedFd).ino;
    const command = await lockCommand(configDir);
    const { DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT } = await loadSeal();
    command[3] = injectedScript(
      DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT,
      String.raw`
real_replace = os.replace
mutated = {"done": False}
def raced_replace(src, dst, *args, **kwargs):
    result = real_replace(src, dst, *args, **kwargs)
    if dst == "config.toml" and not mutated["done"]:
        mutated["done"] = True
        os.lseek(3, 0, os.SEEK_SET)
        os.write(3, b'retained-fd-mutation')
        os.fsync(3)
    return result
os.replace = raced_replace
`,
    );

    const outcome = runLock(command, retainedFd);
    fs.closeSync(retainedFd);

    expect(outcome).toEqual({ status: 0, stdout: "hash-created", stderr: "" });
    const config = observeFile(configPath);
    const record = observeFile(recordPath);
    expect(config.inode).not.toBe(oldInode);
    expect(config.body.toString("utf-8")).toBe(CONFIG_BODY);
    expect(record.body.toString("utf-8")).toBe(
      `${createHash("sha256").update(config.body).digest("hex")}  config.toml\n`,
    );
    expect(config.mode).toBe(0o444);
    expect(record.mode).toBe(0o444);
  });

  type FixtureVerification = () => void;

  function prepareMissingConfigRoot(configDir: string): FixtureVerification {
    return () => {
      expect(fs.existsSync(configDir)).toBe(false);
    };
  }

  function prepareSymlinkConfigRoot(configDir: string): FixtureVerification {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepagents-root-target-"));
    fixtures.push(outsideRoot);
    const externalPath = path.join(outsideRoot, "outside-config");
    const externalBody = "outside config root\n";
    fs.writeFileSync(externalPath, externalBody, { mode: 0o640 });
    fs.chmodSync(externalPath, 0o640);
    const initialExternal = observeFile(externalPath);
    fs.symlinkSync(externalPath, configDir);

    return () => {
      const external = observeFile(externalPath);
      expect(fs.lstatSync(configDir).isSymbolicLink()).toBe(true);
      expect(external.body.toString("utf-8")).toBe(externalBody);
      expect(external.inode).toBe(initialExternal.inode);
      expect(external.mode).toBe(initialExternal.mode);
    };
  }

  function prepareNonDirectoryConfigRoot(configDir: string): FixtureVerification {
    const invalidRootBody = "sandbox-owned invalid config root\n";
    fs.writeFileSync(configDir, invalidRootBody, { mode: 0o660 });
    fs.chmodSync(configDir, 0o660);
    const initialInvalidRoot = observeFile(configDir);

    return () => {
      const invalidRoot = observeFile(configDir);
      expect(invalidRoot.body.toString("utf-8")).toBe(invalidRootBody);
      expect(invalidRoot.inode).toBe(initialInvalidRoot.inode);
      expect(invalidRoot.mode).toBe(initialInvalidRoot.mode);
    };
  }

  function prepareLinkedRecord(
    recordPath: string,
    parentDir: string,
    recordKind: "symlink" | "hardlink",
    linkRecord: (outsidePath: string, recordPath: string) => void,
  ): FixtureVerification {
    const outsidePath = path.join(parentDir, `outside-${recordKind}`);
    const outsideBody = `outside ${recordKind}\n`;
    fs.writeFileSync(outsidePath, outsideBody, { mode: 0o640 });
    fs.chmodSync(outsidePath, 0o640);
    const initialOutside = observeFile(outsidePath);
    linkRecord(outsidePath, recordPath);

    return () => {
      const outside = observeFile(outsidePath);
      expect(outside.body.toString("utf-8")).toBe(outsideBody);
      expect(outside.inode).toBe(initialOutside.inode);
      expect(outside.mode).toBe(initialOutside.mode);
    };
  }

  function prepareSymlinkRecord(recordPath: string, parentDir: string): FixtureVerification {
    return prepareLinkedRecord(recordPath, parentDir, "symlink", (outsidePath, pathname) =>
      fs.symlinkSync(outsidePath, pathname),
    );
  }

  function prepareHardlinkRecord(recordPath: string, parentDir: string): FixtureVerification {
    return prepareLinkedRecord(recordPath, parentDir, "hardlink", (outsidePath, pathname) =>
      fs.linkSync(outsidePath, pathname),
    );
  }

  function noFixtureVerification(): void {}

  function prepareNonregularRecord(recordPath: string, _parentDir: string): FixtureVerification {
    fs.mkdirSync(recordPath);
    return noFixtureVerification;
  }

  function prepareOversizedRecord(recordPath: string, _parentDir: string): FixtureVerification {
    fs.writeFileSync(recordPath, Buffer.alloc(1025, "a"), { mode: 0o660 });
    return noFixtureVerification;
  }

  function expectCanonicalRecordPosture(
    configDir: string,
    recordPath: string,
    _parentDir: string,
  ): void {
    const record = observeFile(recordPath);
    expect(record.body.toString("utf-8")).toBe(EXPECTED_RECORD);
    expect(record.mode).toBe(0o444);
    expectFailClosedPosture(configDir);
  }

  function expectNonregularRecordPosture(
    configDir: string,
    recordPath: string,
    parentDir: string,
  ): void {
    expect(fs.lstatSync(recordPath).isDirectory()).toBe(true);
    expect(fs.statSync(configDir).mode & 0o7777).toBe(0o500);
    expect(fs.statSync(parentDir).mode & 0o7777).toBe(0o700);
  }

  it.each([
    ["missing", prepareMissingConfigRoot],
    ["symlink", prepareSymlinkConfigRoot],
    ["non-directory", prepareNonDirectoryConfigRoot],
  ] as const)("contains a %s config root before it can be pinned (#7977)", async (_rootKind, prepareRoot) => {
    const configDir = makeConfigDir();
    const parentDir = path.dirname(configDir);
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.chmodSync(parentDir, 0o1775);
    const verifyRoot = prepareRoot(configDir);

    const command = await lockCommand(configDir, true);
    command.push("--test-protect-parent");
    const outcome = runLock(command);

    try {
      expect(outcome.status).toBe(1);
      expect(outcome.stderr).toBe(lockFailure("sandbox-parent"));
      const parentStat = fs.statSync(parentDir);
      expect(parentStat.mode & 0o7777).toBe(0o700);
      expect(parentStat.uid).toBe(EFFECTIVE_UID);
      expect(parentStat.gid).toBe(EFFECTIVE_GID);
      verifyRoot();
    } finally {
      fs.chmodSync(parentDir, 0o700);
    }
  });

  it("uses the sandbox parent when the config root cannot be clamped (#7977)", async () => {
    const configDir = makeConfigDir();
    const parentDir = path.dirname(configDir);
    fs.writeFileSync(hashRecordPath(configDir), `${"0".repeat(64)}  config.toml\n`, {
      mode: 0o660,
    });
    const command = await lockCommand(configDir, true);
    command.push("--test-protect-parent");
    const { DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT } = await loadSeal();
    command[3] = injectedScript(
      DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT,
      String.raw`
real_fchmod = os.fchmod
def failed_config_dir_clamp(fd, mode):
    if mode == 0o500:
        raise OSError("injected config dir clamp failure")
    return real_fchmod(fd, mode)
os.fchmod = failed_config_dir_clamp
`,
    );

    const outcome = runLock(command);

    try {
      expect(outcome.status).toBe(1);
      expect(outcome.stderr).toBe(lockFailure("sandbox-parent"));
      const configDirStat = fs.statSync(configDir);
      const parentDirStat = fs.statSync(parentDir);
      expect(configDirStat.mode & 0o7777).toBe(0o700);
      expect(configDirStat.uid).toBe(EFFECTIVE_UID);
      expect(configDirStat.gid).toBe(EFFECTIVE_GID);
      expect(parentDirStat.mode & 0o7777).toBe(0o700);
      expect(parentDirStat.uid).toBe(EFFECTIVE_UID);
      expect(parentDirStat.gid).toBe(EFFECTIVE_GID);
    } finally {
      restoreFixtureAccess(configDir);
    }
  });

  it("reports incomplete containment when no parent posture can be confirmed (#7977)", async () => {
    const configDir = makeConfigDir();
    const parentDir = path.dirname(configDir);
    const command = await lockCommand(configDir, true);
    command.push("--test-protect-parent");
    const { DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT } = await loadSeal();
    command[3] = injectedScript(
      DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT,
      String.raw`
real_fchmod = os.fchmod
def failed_parent_posture(fd, mode):
    if mode in (0o700, 0o1775):
        raise OSError("injected parent posture failure")
    return real_fchmod(fd, mode)
os.fchmod = failed_parent_posture
`,
    );

    const outcome = runLock(command);

    try {
      expect(outcome.status).toBe(1);
      expect(outcome.stderr).toBe(lockFailure("incomplete"));
      const configDirStat = fs.statSync(configDir);
      const parentDirStat = fs.statSync(parentDir);
      expect(configDirStat.mode & 0o7777).toBe(0o500);
      expect(configDirStat.uid).toBe(EFFECTIVE_UID);
      expect(configDirStat.gid).toBe(EFFECTIVE_GID);
      expect(parentDirStat.mode & 0o7777).toBe(0o755);
      expect(parentDirStat.uid).toBe(EFFECTIVE_UID);
      expect(parentDirStat.gid).toBe(EFFECTIVE_GID);
    } finally {
      restoreFixtureAccess(configDir);
    }
  });

  it.each([
    "stale",
    "malformed",
  ])("fresh-replaces a %s record and revokes retained canonical descriptors (#7995)", async (recordKind) => {
    const configDir = makeConfigDir();
    const configPath = path.join(configDir, "config.toml");
    const recordPath = hashRecordPath(configDir);
    const body = recordKind === "stale" ? `${"0".repeat(64)}  config.toml\n` : "not-a-hash\n";
    fs.writeFileSync(recordPath, body, { mode: 0o660 });
    const retainedConfigFd = fs.openSync(configPath, "r+");
    const retainedRecordFd = fs.openSync(recordPath, "r+");
    const oldConfigInode = fs.fstatSync(retainedConfigFd).ino;
    const oldRecordInode = fs.fstatSync(retainedRecordFd).ino;
    const command = await lockCommand(configDir, true);
    command.push("--test-protect-parent");

    const outcome = runLock(command);

    try {
      expect(outcome).toEqual({
        status: 1,
        stdout: "",
        stderr: lockFailure("config-root"),
      });
      const installedConfig = observeFile(configPath);
      const installedRecord = observeFile(recordPath);
      expect(installedConfig.inode).not.toBe(oldConfigInode);
      expect(installedRecord.inode).not.toBe(oldRecordInode);

      fs.writeSync(retainedConfigFd, "retained-config-write", 0, "utf8");
      fs.fsyncSync(retainedConfigFd);
      fs.writeSync(retainedRecordFd, "retained-record-write", 0, "utf8");
      fs.fsyncSync(retainedRecordFd);

      const config = observeFile(configPath);
      const record = observeFile(recordPath);
      expect(config.body.toString("utf-8")).toBe(CONFIG_BODY);
      expect(record.body.toString("utf-8")).toBe(EXPECTED_RECORD);
      expect(config.inode).toBe(installedConfig.inode);
      expect(record.inode).toBe(installedRecord.inode);
      expect(config.mode).toBe(0o444);
      expect(record.mode).toBe(0o444);
      expectFailClosedPosture(configDir);
    } finally {
      fs.closeSync(retainedConfigFd);
      fs.closeSync(retainedRecordFd);
      restoreFixtureAccess(configDir);
    }
  });

  it.each([
    ["symlink", "config-root", prepareSymlinkRecord, expectCanonicalRecordPosture],
    ["hardlink", "config-root", prepareHardlinkRecord, expectCanonicalRecordPosture],
    ["nonregular", "sandbox-parent", prepareNonregularRecord, expectNonregularRecordPosture],
    ["oversize", "config-root", prepareOversizedRecord, expectCanonicalRecordPosture],
  ] as const)("claims config-root for a %s record only after installing a fresh canonical pair (#7995)", async (_recordKind, expectedStatus, prepareRecord, verifyRecordPosture) => {
    const configDir = makeConfigDir();
    const parentDir = path.dirname(configDir);
    const recordPath = hashRecordPath(configDir);
    const configPath = path.join(configDir, "config.toml");
    const oldConfig = observeFile(configPath);
    const verifyFixture = prepareRecord(recordPath, parentDir);
    const command = await lockCommand(configDir, true);
    command.push("--test-protect-parent");

    const outcome = runLock(command);

    try {
      expect(outcome).toEqual({
        status: 1,
        stdout: "",
        stderr: lockFailure(expectedStatus),
      });
      const config = observeFile(configPath);
      expect(config.body.toString("utf-8")).toBe(CONFIG_BODY);
      expect(config.inode).not.toBe(oldConfig.inode);
      expect(config.mode).toBe(0o444);
      verifyRecordPosture(configDir, recordPath, parentDir);
      verifyFixture();
    } finally {
      restoreFixtureAccess(configDir);
    }
  });

  it("contains a staging-body failure after freezing mutable state (#7977)", async () => {
    const configDir = makeConfigDir();
    const configPath = path.join(configDir, "config.toml");
    const oldConfig = observeFile(configPath);
    const command = await lockCommand(configDir, true);
    command.push("--test-protect-parent");
    const { DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT } = await loadSeal();
    command[3] = injectedScript(
      DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT,
      String.raw`
real_write = os.write
state = {"write_failed": False}
def failed_write(fd, data):
    if not state["write_failed"]:
        state["write_failed"] = True
        raise OSError("injected staging write failure")
    return real_write(fd, data)
os.write = failed_write
`,
    );

    const outcome = runLock(command);

    try {
      expect(outcome).toEqual({ status: 1, stdout: "", stderr: lockFailure("config-root") });
      const config = observeFile(configPath);
      const record = observeFile(hashRecordPath(configDir));
      expect(config.body.toString("utf-8")).toBe(CONFIG_BODY);
      expect(config.inode).not.toBe(oldConfig.inode);
      expect(config.mode).toBe(0o444);
      expect(record.body.toString("utf-8")).toBe(EXPECTED_RECORD);
      expect(record.mode).toBe(0o444);
      expect(fs.readdirSync(configDir).filter((name) => name.includes(".nemoclaw."))).toEqual([]);
      expectFailClosedPosture(configDir);
    } finally {
      restoreFixtureAccess(configDir);
    }
  });

  it("uses sandbox-parent when the canonical pair cannot be freshly installed (#7995)", async () => {
    const configDir = makeConfigDir();
    const parentDir = path.dirname(configDir);
    const configPath = path.join(configDir, "config.toml");
    const oldConfig = observeFile(configPath);
    const command = await lockCommand(configDir, true);
    command.push("--test-protect-parent");
    const { DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT } = await loadSeal();
    command[3] = injectedScript(
      DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT,
      String.raw`
def failed_write(_fd, _data):
    raise OSError("injected persistent staging failure")
os.write = failed_write
`,
    );

    const outcome = runLock(command);

    try {
      expect(outcome).toEqual({
        status: 1,
        stdout: "",
        stderr: lockFailure("sandbox-parent"),
      });
      const config = observeFile(configPath);
      expect(config.body.toString("utf-8")).toBe(CONFIG_BODY);
      expect(config.inode).toBe(oldConfig.inode);
      expect(config.mode).toBe(oldConfig.mode);
      expect(fs.existsSync(hashRecordPath(configDir))).toBe(false);
      expect(fs.statSync(configDir).mode & 0o7777).toBe(0o500);
      expect(fs.statSync(parentDir).mode & 0o7777).toBe(0o700);
    } finally {
      restoreFixtureAccess(configDir);
    }
  });

  it("restores both original paths when the record cutover fails (#7977)", async () => {
    const configDir = makeConfigDir();
    const configPath = path.join(configDir, "config.toml");
    const oldConfig = observeFile(configPath);
    const command = await lockCommand(configDir);
    const { DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT } = await loadSeal();
    command[3] = injectedScript(
      DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT,
      String.raw`
real_replace = os.replace
def failed_record_replace(src, dst, *args, **kwargs):
    if dst == ".config-hash":
        raise OSError("injected record cutover failure")
    return real_replace(src, dst, *args, **kwargs)
os.replace = failed_record_replace
`,
    );

    const outcome = runLock(command);

    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toBe(lockFailure("transaction-failed"));
    const config = observeFile(configPath);
    expect(config.body.toString("utf-8")).toBe(CONFIG_BODY);
    expect(fs.existsSync(hashRecordPath(configDir))).toBe(false);
    expect(config.inode).not.toBe(oldConfig.inode);
    expect(config.mode).toBe(oldConfig.mode);
    expect(fs.readdirSync(configDir).filter((name) => name.includes(".nemoclaw."))).toEqual([]);
  });

  it("reports when a failed cutover cannot restore the original config (#7977)", async () => {
    const configDir = makeConfigDir();
    const parentDir = path.dirname(configDir);
    const command = await lockCommand(configDir);
    command.push("--test-protect-parent");
    const { DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT } = await loadSeal();
    command[3] = injectedScript(
      DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT,
      String.raw`
real_replace = os.replace
state = {"config_replaced": False}
def failed_replace(src, dst, *args, **kwargs):
    if dst == "config.toml":
        if state["config_replaced"]:
            raise OSError("injected config rollback failure")
        state["config_replaced"] = True
        return real_replace(src, dst, *args, **kwargs)
    if dst == ".config-hash":
        raise OSError("injected record cutover failure")
    return real_replace(src, dst, *args, **kwargs)
os.replace = failed_replace
`,
    );

    const outcome = runLock(command);

    try {
      expect(outcome.status).toBe(1);
      expect(outcome.stderr).toBe(lockFailure("rollback-failed"));
      const configDirStat = fs.statSync(configDir);
      const parentDirStat = fs.statSync(parentDir);
      expect(configDirStat.mode & 0o7777).toBe(0o500);
      expect(configDirStat.uid).toBe(EFFECTIVE_UID);
      expect(configDirStat.gid).toBe(EFFECTIVE_GID);
      expect(parentDirStat.mode & 0o7777).toBe(0o1775);
      expect(parentDirStat.uid).toBe(EFFECTIVE_UID);
      expect(parentDirStat.gid).toBe(EFFECTIVE_GID);
    } finally {
      fs.chmodSync(configDir, 0o700);
      fs.chmodSync(parentDir, 0o700);
    }
  });

  it("fails closed when a staging write and its cleanup both fail (#7977)", async () => {
    const configDir = makeConfigDir();
    const parentDir = path.dirname(configDir);
    const command = await lockCommand(configDir, true);
    command.push("--test-protect-parent");
    const { DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT } = await loadSeal();
    command[3] = injectedScript(
      DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT,
      String.raw`
real_write = os.write
real_unlink = os.unlink
state = {"write_failed": False, "cleanup_failed": False}
def failed_write(fd, data):
    if not state["write_failed"]:
        state["write_failed"] = True
        raise OSError("injected staging write failure")
    return real_write(fd, data)
def failed_unlink(path, *args, **kwargs):
    if ".nemoclaw." in path and state["write_failed"] and not state["cleanup_failed"]:
        state["cleanup_failed"] = True
        raise OSError("injected staging cleanup failure")
    return real_unlink(path, *args, **kwargs)
os.write = failed_write
os.unlink = failed_unlink
`,
    );

    const outcome = runLock(command);

    try {
      expect(outcome).toEqual({ status: 1, stdout: "", stderr: lockFailure("config-root") });
      expect(fs.readFileSync(path.join(configDir, "config.toml"), "utf-8")).toBe(CONFIG_BODY);
      expect(fs.statSync(path.join(configDir, "config.toml")).mode & 0o7777).toBe(0o444);
      expect(fs.readFileSync(hashRecordPath(configDir), "utf-8")).toBe(EXPECTED_RECORD);
      expect(fs.statSync(hashRecordPath(configDir)).mode & 0o7777).toBe(0o444);
      const configDirStat = fs.statSync(configDir);
      const parentDirStat = fs.statSync(parentDir);
      expect(configDirStat.mode & 0o7777).toBe(0o500);
      expect(configDirStat.uid).toBe(EFFECTIVE_UID);
      expect(configDirStat.gid).toBe(EFFECTIVE_GID);
      expect(parentDirStat.mode & 0o7777).toBe(0o1775);
      expect(parentDirStat.uid).toBe(EFFECTIVE_UID);
      expect(parentDirStat.gid).toBe(EFFECTIVE_GID);
      const stagingArtifacts = fs
        .readdirSync(configDir)
        .filter((name) => name.includes(".nemoclaw."));
      expect(stagingArtifacts).toHaveLength(1);
      expect(stagingArtifacts[0]).toMatch(/^\.config\.toml\.nemoclaw\.\d+\.[0-9a-f]+$/);
      expect(fs.lstatSync(path.join(configDir, stagingArtifacts[0])).isFile()).toBe(true);
      expect(fs.readdirSync(parentDir).filter((name) => name.includes(".nemoclaw."))).toEqual([]);
    } finally {
      fs.chmodSync(configDir, 0o700);
      fs.chmodSync(parentDir, 0o700);
    }
  });
});
