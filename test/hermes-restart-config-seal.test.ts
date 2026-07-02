// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUNTIME_CONFIG_GUARD = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "runtime-config-guard.py",
);

interface RestartFixture {
  root: string;
  sandboxDir: string;
  hermesDir: string;
  configPath: string;
  envPath: string;
  hashPath: string;
  compatHashPath: string;
  statePath: string;
  trustedConfig: string;
  trustedEnv: string;
}

function mode(pathname: string): number {
  return fs.statSync(pathname).mode & 0o7777;
}

function createRestartFixture(): RestartFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-restart-seal-"));
  const sandboxDir = path.join(root, "sandbox");
  const hermesDir = path.join(sandboxDir, ".hermes");
  const configPath = path.join(hermesDir, "config.yaml");
  const envPath = path.join(hermesDir, ".env");
  const hashPath = path.join(root, "hermes.config-hash");
  const compatHashPath = path.join(hermesDir, ".config-hash");
  const statePath = path.join(root, "hermes-restart-seal.json");
  const trustedConfig = "model:\n  default: trusted-model\n";
  const trustedEnv = "API_SERVER_PORT=18642\nSAFE_SETTING=trusted\n";

  fs.mkdirSync(hermesDir, { recursive: true });
  fs.chmodSync(sandboxDir, 0o770);
  fs.chmodSync(hermesDir, 0o3770);
  fs.writeFileSync(configPath, trustedConfig, { mode: 0o640 });
  fs.chmodSync(configPath, 0o640);
  fs.writeFileSync(envPath, trustedEnv, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);

  const hash = spawnSync("sha256sum", [configPath, envPath], {
    encoding: "utf-8",
    timeout: 5000,
  });
  expect(hash.status, hash.stderr).toBe(0);
  fs.writeFileSync(hashPath, hash.stdout, { mode: 0o600 });
  fs.writeFileSync(compatHashPath, hash.stdout, { mode: 0o600 });

  return {
    root,
    sandboxDir,
    hermesDir,
    configPath,
    envPath,
    hashPath,
    compatHashPath,
    statePath,
    trustedConfig,
    trustedEnv,
  };
}

function runWriteConfig(fixture: RestartFixture, expectedDigest: string, content: string) {
  return spawnSync(
    "python3",
    [
      RUNTIME_CONFIG_GUARD,
      "write-config",
      "--hermes-dir",
      fixture.hermesDir,
      "--hash-file",
      fixture.hashPath,
      "--state-file",
      fixture.statePath,
      "--expected-config-sha256",
      expectedDigest,
    ],
    { encoding: "utf-8", input: content, timeout: 5000 },
  );
}

function writeMutationLock(fixture: RestartFixture, token: string): string {
  const lockPath = path.join(fixture.root, "hermes-config-mutation.lock");
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      version: 1,
      token,
      purpose: "seal-restart",
      pid: 999_999_999,
      pid_start_time: "1",
    })}\n`,
    { mode: 0o600 },
  );
  return lockPath;
}

function runGuard(action: "seal-restart" | "unseal-restart", fixture: RestartFixture) {
  const args = [
    RUNTIME_CONFIG_GUARD,
    action,
    "--hermes-dir",
    fixture.hermesDir,
    "--state-file",
    fixture.statePath,
  ];
  args.push(...(action === "seal-restart" ? ["--hash-file", fixture.hashPath] : []));
  return spawnSync("python3", args, {
    encoding: "utf-8",
    timeout: 5000,
  });
}

function runShieldsTransition(fixture: RestartFixture, shieldsMode: "locked" | "mutable") {
  const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
    mode: shieldsMode,
  });
  switch (begun.status) {
    case 0:
      break;
    default:
      return begun;
  }
  const token = shieldsTransactionToken(begun.stdout);
  switch (token) {
    case undefined:
      throw new Error("Expected begin-shields-transition to emit a token");
    default:
      break;
  }
  switch (shieldsMode) {
    case "locked":
      // The production host restores 0755 only after the recursive state guard's
      // independent verification pass. This focused top-guard fixture has no
      // recursive state, so model that successful handoff explicitly.
      fs.chmodSync(fixture.hermesDir, 0o755);
      break;
    case "mutable":
      break;
  }
  const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
    token,
  });
  switch (applied.status) {
    case 0:
      break;
    default:
      return applied;
  }
  return runShieldsTransactionAction(fixture, "finish-shields-transition", {
    token,
  });
}

function runShieldsTransactionAction(
  fixture: RestartFixture,
  action:
    | "begin-shields-transition"
    | "apply-shields-transition"
    | "finish-shields-transition"
    | "prepare-shields-abort"
    | "abort-shields-transition"
    | "inspect-mutation-owner",
  options: {
    mode?: "locked" | "mutable";
    rollbackMode?: "locked" | "mutable";
    token?: string;
  } = {},
) {
  const args = [
    RUNTIME_CONFIG_GUARD,
    action,
    "--hermes-dir",
    fixture.hermesDir,
    "--state-file",
    fixture.statePath,
  ];
  args.push(
    ...(action === "begin-shields-transition" || action === "finish-shields-transition"
      ? ["--hash-file", fixture.hashPath]
      : []),
    ...(options.mode ? ["--shields-mode", options.mode] : []),
    ...(options.rollbackMode ? ["--rollback-shields-mode", options.rollbackMode] : []),
    ...(options.token ? ["--lock-token", options.token] : []),
  );
  return spawnSync("python3", args, { encoding: "utf-8", timeout: 5000 });
}

function strictHashIsValid(fixture: RestartFixture): boolean {
  return (
    spawnSync("sha256sum", ["-c", fixture.hashPath, "--status"], {
      encoding: "utf-8",
      timeout: 5000,
    }).status === 0
  );
}

function shieldsTransactionToken(output: string): string | undefined {
  return /^lock_token=([0-9a-f]{64}) original_locked=[01]\s*$/.exec(output)?.[1];
}

function overwriteThroughOldFd(fd: number, originalSize: number, byte: string): void {
  const attackerBytes = Buffer.alloc(originalSize, byte);
  fs.writeSync(fd, attackerBytes, 0, attackerBytes.length, 0);
  fs.fsyncSync(fd);
}

describe.skipIf(process.platform === "win32")("Hermes mutable restart input seal", () => {
  it("atomically binds a host config write to the bytes that were read and refreshes both hashes", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    const updatedConfig = "model:\n  default: trusted-model-v2\n";

    try {
      const updated = runWriteConfig(fixture, expectedDigest, updatedConfig);

      expect(updated.status, updated.stderr).toBe(0);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(updatedConfig);
      expect(fs.readFileSync(fixture.hashPath, "utf-8")).toBe(
        fs.readFileSync(fixture.compatHashPath, "utf-8"),
      );
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o600);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps a maximum-size config write journal below its bounded state cap", {
    timeout: 60_000,
  }, () => {
    const fixture = createRestartFixture();
    const boundarySize = 16 * 1024 * 1024;
    const originalConfig = `${"a".repeat(boundarySize - 1)}\n`;
    const updatedConfig = `${"b".repeat(boundarySize - 1)}\n`;
    fs.writeFileSync(fixture.configPath, originalConfig);
    const hash = spawnSync("sha256sum", [fixture.configPath, fixture.envPath], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(hash.status, hash.stderr).toBe(0);
    fs.writeFileSync(fixture.hashPath, hash.stdout);
    fs.writeFileSync(fixture.compatHashPath, hash.stdout);
    const expectedDigest = createHash("sha256").update(originalConfig).digest("hex");

    try {
      const updated = spawnSync(
        "python3",
        [
          RUNTIME_CONFIG_GUARD,
          "write-config",
          "--hermes-dir",
          fixture.hermesDir,
          "--hash-file",
          fixture.hashPath,
          "--state-file",
          fixture.statePath,
          "--expected-config-sha256",
          expectedDigest,
        ],
        { encoding: "utf-8", input: updatedConfig, timeout: 45_000 },
      );
      expect(updated.status, updated.stderr).toBe(0);
      expect(fs.statSync(fixture.configPath).size).toBe(boundarySize);
      expect(createHash("sha256").update(fs.readFileSync(fixture.configPath)).digest("hex")).toBe(
        createHash("sha256").update(updatedConfig).digest("hex"),
      );
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses to launder a stale host read and leaves the trusted config unchanged", () => {
    const fixture = createRestartFixture();
    const staleDigest = createHash("sha256").update("attacker-controlled read\n").digest("hex");

    try {
      const updated = runWriteConfig(
        fixture,
        staleDigest,
        "model:\n  default: attacker-derived-model\n",
      );

      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("config changed after the host read");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses host config writes while shields are up and restores the locked posture", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");
    fs.chmodSync(fixture.sandboxDir, 0o755);
    fs.chmodSync(fixture.hermesDir, 0o755);
    fs.chmodSync(fixture.configPath, 0o444);
    fs.chmodSync(fixture.envPath, 0o444);
    fs.chmodSync(fixture.compatHashPath, 0o444);

    try {
      const updated = runWriteConfig(
        fixture,
        expectedDigest,
        "model:\n  default: must-not-apply\n",
      );

      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("config writes are unavailable while shields are up");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(mode(fixture.sandboxDir)).toBe(0o755);
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.envPath)).toBe(0o444);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("serializes restart sealing against a host-held shields mutation lock", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");

    try {
      const lockPath = writeMutationLock(fixture, token);

      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status).not.toBe(0);
      expect(sealed.stderr).toContain("config mutation is already in progress");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(mode(fixture.sandboxDir)).toBe(0o770);

      fs.unlinkSync(lockPath);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("recovers a dead mutation lock published before seal state creation", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");
    try {
      const lockPath = writeMutationLock(fixture, token);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      const recovered = spawnSync(
        "python3",
        [
          RUNTIME_CONFIG_GUARD,
          "recover-prestate-lock",
          "--hermes-dir",
          fixture.hermesDir,
          "--state-file",
          fixture.statePath,
          "--startup-owner",
        ],
        { encoding: "utf-8", timeout: 5000 },
      );
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout.trim()).toBe("recovered=1");
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a host config transaction while another Hermes mutation owns the lock", () => {
    const fixture = createRestartFixture();
    const token = randomBytes(32).toString("hex");
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");

    try {
      const lockPath = writeMutationLock(fixture, token);

      const updated = runWriteConfig(
        fixture,
        expectedDigest,
        "model:\n  default: should-not-commit\n",
      );
      expect(updated.status).not.toBe(0);
      expect(updated.stderr).toContain("config mutation is already in progress");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);

      fs.unlinkSync(lockPath);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rolls back a config-write phase killed after rename but before strict hash refresh", () => {
    const fixture = createRestartFixture();

    try {
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);

      const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
      state.phase = "config-write-prepared";
      state.config_write = {
        original_base64: Buffer.from(fixture.trustedConfig).toString("base64"),
        original_sha256: createHash("sha256").update(fixture.trustedConfig).digest("hex"),
      };
      fs.writeFileSync(fixture.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fs.chmodSync(fixture.statePath, 0o600);

      const replacement = path.join(fixture.hermesDir, ".config.crash-test");
      fs.writeFileSync(replacement, "model:\n  default: interrupted-write\n", { mode: 0o444 });
      fs.chmodSync(replacement, 0o444);
      fs.renameSync(replacement, fixture.configPath);
      expect(strictHashIsValid(fixture)).toBe(false);

      const recovered = runGuard("unseal-restart", fixture);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("revokes pre-open writable fds while preserving trusted path bytes and strict hashes", () => {
    const fixture = createRestartFixture();
    const configBefore = fs.statSync(fixture.configPath);
    const envBefore = fs.statSync(fixture.envPath);
    const configFd = fs.openSync(fixture.configPath, "r+");
    const envFd = fs.openSync(fixture.envPath, "r+");

    try {
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);

      const configSealed = fs.statSync(fixture.configPath);
      const envSealed = fs.statSync(fixture.envPath);
      expect(configSealed.ino).not.toBe(configBefore.ino);
      expect(envSealed.ino).not.toBe(envBefore.ino);
      expect(configSealed.uid).toBe(process.getuid!());
      expect(envSealed.uid).toBe(process.getuid!());
      expect(mode(fixture.sandboxDir)).toBe(0o755);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.envPath)).toBe(0o444);
      expect(configSealed.uid).toBe(fs.statSync(fixture.hermesDir).uid);
      expect(envSealed.uid).toBe(fs.statSync(fixture.hermesDir).uid);
      expect(mode(fixture.statePath)).toBe(0o600);
      expect(strictHashIsValid(fixture)).toBe(true);

      overwriteThroughOldFd(configFd, configBefore.size, "X");
      overwriteThroughOldFd(envFd, envBefore.size, "Y");

      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(fs.readFileSync(fixture.envPath, "utf-8")).toBe(fixture.trustedEnv);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.statSync(fixture.configPath).ino).toBe(configSealed.ino);
      expect(fs.statSync(fixture.envPath).ino).toBe(envSealed.ino);

      const unsealed = runGuard("unseal-restart", fixture);
      expect(unsealed.status, unsealed.stderr).toBe(0);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o600);
      expect(fs.statSync(fixture.configPath).uid).toBe(configBefore.uid);
      expect(fs.statSync(fixture.configPath).gid).toBe(configBefore.gid);
      expect(fs.statSync(fixture.envPath).uid).toBe(envBefore.uid);
      expect(fs.statSync(fixture.envPath).gid).toBe(envBefore.gid);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(fs.readFileSync(fixture.envPath, "utf-8")).toBe(fixture.trustedEnv);
      expect(strictHashIsValid(fixture)).toBe(true);
    } finally {
      fs.closeSync(configFd);
      fs.closeSync(envFd);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("revokes pre-open descriptors across shields lock and restores the mutable contract", () => {
    const fixture = createRestartFixture();
    const configBefore = fs.statSync(fixture.configPath);
    const envBefore = fs.statSync(fixture.envPath);
    const compatBefore = fs.statSync(fixture.compatHashPath);
    const configFd = fs.openSync(fixture.configPath, "r+");
    const envFd = fs.openSync(fixture.envPath, "r+");
    const compatFd = fs.openSync(fixture.compatHashPath, "r+");

    try {
      const locked = runShieldsTransition(fixture, "locked");
      expect(locked.status, locked.stderr).toBe(0);
      expect(fs.statSync(fixture.configPath).ino).not.toBe(configBefore.ino);
      expect(fs.statSync(fixture.envPath).ino).not.toBe(envBefore.ino);
      expect(fs.statSync(fixture.compatHashPath).ino).not.toBe(compatBefore.ino);
      expect(mode(fixture.sandboxDir)).toBe(0o1775);
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.envPath)).toBe(0o444);
      expect(mode(fixture.compatHashPath)).toBe(0o444);

      overwriteThroughOldFd(configFd, configBefore.size, "X");
      overwriteThroughOldFd(envFd, envBefore.size, "Y");
      overwriteThroughOldFd(compatFd, compatBefore.size, "Z");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(fs.readFileSync(fixture.envPath, "utf-8")).toBe(fixture.trustedEnv);
      expect(strictHashIsValid(fixture)).toBe(true);

      const mutable = runShieldsTransition(fixture, "mutable");
      expect(mutable.status, mutable.stderr).toBe(0);
      expect(mode(fixture.sandboxDir)).toBe(0o755);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o640);
      expect(mode(fixture.compatHashPath)).toBe(0o640);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        false,
      );
    } finally {
      fs.closeSync(configFd);
      fs.closeSync(envFd);
      fs.closeSync(compatFd);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("holds the mutation lock through begin, apply, verification, and finish", () => {
    const fixture = createRestartFixture();
    const expectedDigest = createHash("sha256").update(fixture.trustedConfig).digest("hex");

    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(begun.status, begun.stderr).toBe(0);
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(fixture.statePath)).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        true,
      );
      expect(mode(fixture.sandboxDir)).toBe(0o700);
      expect(mode(fixture.hermesDir)).toBe(0o500);

      const owner = runShieldsTransactionAction(fixture, "inspect-mutation-owner");
      expect(owner.status, owner.stderr).toBe(0);
      expect(owner.stdout).toContain("owner_active=1");
      expect(owner.stdout).toContain("recovery_safe=0");

      const competingRestart = runGuard("seal-restart", fixture);
      expect(competingRestart.status).not.toBe(0);
      expect(competingRestart.stderr).toContain("restart seal is already active");
      const competingWrite = runWriteConfig(
        fixture,
        expectedDigest,
        "model:\n  default: must-not-interleave\n",
      );
      expect(competingWrite.status).not.toBe(0);
      expect(competingWrite.stderr).toContain("restart seal is already active");

      fs.chmodSync(fixture.hermesDir, 0o755);
      const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(applied.status, applied.stderr).toBe(0);
      expect(applied.stdout).toContain("shields_mode=locked");
      expect(fs.existsSync(fixture.statePath)).toBe(true);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        true,
      );
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.sandboxDir)).toBe(0o755);

      const finished = runShieldsTransactionAction(fixture, "finish-shields-transition", {
        token,
      });
      expect(finished.status, finished.stderr).toBe(0);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(false);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        false,
      );
      expect(mode(fixture.sandboxDir)).toBe(0o1775);
      expect(strictHashIsValid(fixture)).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps weakening fan-out inaccessible and keeps monotonic lock fan-out readable", () => {
    for (const targetMode of ["mutable", "locked"] as const) {
      const fixture = createRestartFixture();
      try {
        const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
          mode: targetMode,
        });
        expect(begun.status, begun.stderr).toBe(0);
        const token = shieldsTransactionToken(begun.stdout);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(mode(fixture.hermesDir)).toBe(targetMode === "mutable" ? 0o700 : 0o500);
        expect(mode(fixture.sandboxDir)).toBe(0o700);

        const prepared = runShieldsTransactionAction(fixture, "prepare-shields-abort", {
          token,
        });
        expect(prepared.status, prepared.stderr).toBe(0);
        const abortState = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
        expect(abortState.shields_transition.mode).toBe("mutable");
        // State-dir rollback is another recursive transition. It remains
        // root-only until abort commits the original posture.
        expect(mode(fixture.hermesDir)).toBe(0o700);
        expect(mode(fixture.sandboxDir)).toBe(0o700);

        const aborted = runShieldsTransactionAction(fixture, "abort-shields-transition", {
          token,
        });
        expect(aborted.status, aborted.stderr).toBe(0);
        expect(mode(fixture.hermesDir)).toBe(0o3770);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("retains the 0500 recursive clamp and resumes the same lock transaction", () => {
    const fixture = createRestartFixture();
    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(begun.status, begun.stderr).toBe(0);
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(mode(fixture.hermesDir)).toBe(0o500);

      const premature = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(premature.status).not.toBe(0);
      expect(premature.stderr).toContain("retaining root-only 0500 clamp for retry");
      expect(mode(fixture.hermesDir)).toBe(0o500);
      expect(fs.existsSync(fixture.statePath)).toBe(true);

      const resumed = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(shieldsTransactionToken(resumed.stdout)).toBe(token);
      expect(mode(fixture.hermesDir)).toBe(0o500);

      fs.chmodSync(fixture.hermesDir, 0o755);
      const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(applied.status, applied.stderr).toBe(0);
      const finished = runShieldsTransactionAction(fixture, "finish-shields-transition", {
        token,
      });
      expect(finished.status, finished.stderr).toBe(0);
      expect(mode(fixture.hermesDir)).toBe(0o755);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("cold-resumes an applied lock transaction before its final commit", () => {
    const fixture = createRestartFixture();
    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      fs.chmodSync(fixture.hermesDir, 0o755);
      const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(applied.status, applied.stderr).toBe(0);

      const resumed = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(shieldsTransactionToken(resumed.stdout)).toBe(token);
      expect(mode(fixture.hermesDir)).toBe(0o500);
      fs.chmodSync(fixture.hermesDir, 0o755);
      const reapplied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(reapplied.status, reapplied.stderr).toBe(0);
      const finished = runShieldsTransactionAction(fixture, "finish-shields-transition", {
        token,
      });
      expect(finished.status, finished.stderr).toBe(0);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(mode(fixture.hermesDir)).toBe(0o755);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("takes over an expired applied mutable transition only after its worker lease ends", () => {
    const fixture = createRestartFixture();
    fs.chmodSync(fixture.sandboxDir, 0o1775);
    fs.chmodSync(fixture.hermesDir, 0o755);
    fs.chmodSync(fixture.configPath, 0o444);
    fs.chmodSync(fixture.envPath, 0o444);
    fs.chmodSync(fixture.compatHashPath, 0o444);
    let staleFd: number | undefined;
    try {
      const mutableBegin = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "mutable",
        rollbackMode: "locked",
      });
      expect(mutableBegin.status, mutableBegin.stderr).toBe(0);
      const mutableToken = shieldsTransactionToken(mutableBegin.stdout);
      expect(mutableToken).toMatch(/^[0-9a-f]{64}$/);
      const mutableApply = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token: mutableToken,
      });
      expect(mutableApply.status, mutableApply.stderr).toBe(0);
      staleFd = fs.openSync(fixture.configPath, "r+");

      const premature = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(premature.status).not.toBe(0);
      expect(premature.stderr).toContain("mutable transition lease has not expired");

      const staleState = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
      staleState.shields_transition.lease_expires_ns = 1;
      fs.writeFileSync(fixture.statePath, `${JSON.stringify(staleState)}\n`, { mode: 0o600 });
      const beforeTakeoverInode = fs.statSync(fixture.configPath).ino;
      const lockedBegin = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(lockedBegin.status, lockedBegin.stderr).toBe(0);
      const lockedToken = shieldsTransactionToken(lockedBegin.stdout);
      expect(lockedToken).toMatch(/^[0-9a-f]{64}$/);
      expect(lockedToken).not.toBe(mutableToken);
      expect(fs.statSync(fixture.configPath).ino).not.toBe(beforeTakeoverInode);
      expect(mode(fixture.hermesDir)).toBe(0o500);
      const sealedBytes = fs.readFileSync(fixture.configPath);
      overwriteThroughOldFd(staleFd, sealedBytes.length, "X");
      expect(fs.readFileSync(fixture.configPath)).toEqual(sealedBytes);

      fs.chmodSync(fixture.hermesDir, 0o755);
      expect(
        runShieldsTransactionAction(fixture, "apply-shields-transition", {
          token: lockedToken,
        }).status,
      ).toBe(0);
      const finished = runShieldsTransactionAction(fixture, "finish-shields-transition", {
        token: lockedToken,
      });
      expect(finished.status, finished.stderr).toBe(0);
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(strictHashIsValid(fixture)).toBe(true);
    } finally {
      for (const openFd of staleFd === undefined ? [] : [staleFd]) fs.closeSync(openFd);
      fs.chmodSync(fixture.sandboxDir, 0o700);
      for (const existingHermesDir of fs.existsSync(fixture.hermesDir) ? [fixture.hermesDir] : []) {
        fs.chmodSync(existingHermesDir, 0o700);
      }
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("hardens mutable modes and stale hashes from the frozen current bytes", () => {
    const fixture = createRestartFixture();
    const configBefore = fs.statSync(fixture.configPath).ino;
    fs.chmodSync(fixture.configPath, 0o666);
    fs.chmodSync(fixture.envPath, 0o666);
    fs.writeFileSync(fixture.hashPath, "stale strict hash\n");
    fs.writeFileSync(fixture.compatHashPath, "stale compatibility hash\n");
    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(begun.status, begun.stderr).toBe(0);
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const transition = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
      expect(transition.shields_transition.unavailable).toBe(false);
      expect(fs.statSync(fixture.configPath).ino).not.toBe(configBefore);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.envPath)).toBe(0o444);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.readFileSync(fixture.hashPath, "utf-8")).toBe(
        fs.readFileSync(fixture.compatHashPath, "utf-8"),
      );

      fs.chmodSync(fixture.hermesDir, 0o755);
      expect(
        runShieldsTransactionAction(fixture, "apply-shields-transition", { token }).status,
      ).toBe(0);
      expect(
        runShieldsTransactionAction(fixture, "finish-shields-transition", { token }).status,
      ).toBe(0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const oversizedName of ["config.yaml", ".env"] as const) {
    it(`contains an oversized sparse ${oversizedName} without reading its logical payload`, () => {
      const fixture = createRestartFixture();
      const oversizedPath = oversizedName === "config.yaml" ? fixture.configPath : fixture.envPath;
      fs.truncateSync(
        oversizedPath,
        oversizedName === "config.yaml" ? 16 * 1024 * 1024 + 1 : 4 * 1024 * 1024 + 1,
      );
      try {
        const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
          mode: "locked",
        });
        expect(begun.status, begun.stderr).toBe(0);
        const transition = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
        expect(transition.shields_transition.unavailable).toBe(true);
        expect(transition.shields_transition.unavailable_reasons.join("\n")).toContain(
          "oversized runtime config path",
        );
        expect(fs.statSync(oversizedPath).size).toBeLessThan(1024);
        expect(mode(oversizedPath)).toBe(0o400);
        expect(mode(fixture.hermesDir)).toBe(0o500);
      } finally {
        fs.chmodSync(fixture.sandboxDir, 0o700);
        fs.chmodSync(fixture.hermesDir, 0o700);
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  it("fresh-seals a hardlinked input and revokes the external writable inode", () => {
    const fixture = createRestartFixture();
    const external = path.join(fixture.root, "external-config");
    fs.unlinkSync(fixture.configPath);
    fs.writeFileSync(external, fixture.trustedConfig, { mode: 0o666 });
    fs.linkSync(external, fixture.configPath);
    const linkedInode = fs.statSync(external).ino;
    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(begun.status, begun.stderr).toBe(0);
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.statSync(fixture.configPath).ino).not.toBe(linkedInode);
      expect(fs.statSync(fixture.configPath).nlink).toBe(1);
      expect(
        JSON.parse(fs.readFileSync(fixture.statePath, "utf-8")).shields_transition.unavailable,
      ).toBe(false);
      fs.writeFileSync(external, "attacker rewrite\n");
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);

      fs.chmodSync(fixture.hermesDir, 0o755);
      expect(
        runShieldsTransactionAction(fixture, "apply-shields-transition", { token }).status,
      ).toBe(0);
      expect(
        runShieldsTransactionAction(fixture, "finish-shields-transition", { token }).status,
      ).toBe(0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const hostileKind of ["symlink", "fifo"] as const) {
    it(`seals a hostile ${hostileKind} config entry into a root-only unavailable posture`, () => {
      const fixture = createRestartFixture();
      fs.unlinkSync(fixture.configPath);
      const arrangeHostileConfig = {
        symlink: () => {
          const victim = path.join(fixture.root, "victim");
          fs.writeFileSync(victim, "victim stays untouched\n");
          fs.symlinkSync(victim, fixture.configPath);
        },
        fifo: () => expect(spawnSync("mkfifo", [fixture.configPath]).status).toBe(0),
      } satisfies Record<typeof hostileKind, () => void>;
      arrangeHostileConfig[hostileKind]();
      try {
        const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
          mode: "locked",
        });
        expect(begun.status, begun.stderr).toBe(0);
        const token = shieldsTransactionToken(begun.stdout);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        const transition = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
        expect(transition.shields_transition.unavailable).toBe(true);
        expect(fs.lstatSync(fixture.configPath).isFile()).toBe(true);
        expect(mode(fixture.configPath)).toBe(0o400);
        expect(mode(fixture.hermesDir)).toBe(0o500);
        const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
          token,
        });
        expect(applied.status).not.toBe(0);
        expect(applied.stderr).toContain("sealed root-only and is unavailable");
        expect(mode(fixture.sandboxDir)).toBe(0o700);
        expect(mode(fixture.hermesDir)).toBe(0o500);
      } finally {
        fs.chmodSync(fixture.sandboxDir, 0o700);
        fs.chmodSync(fixture.hermesDir, 0o700);
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  for (const hostileKind of ["symlink", "fifo"] as const) {
    it(`quarantines an outer .hermes ${hostileKind} only after freezing /sandbox`, () => {
      const fixture = createRestartFixture();
      fs.rmSync(fixture.hermesDir, { recursive: true, force: true });
      const victim = path.join(fixture.root, "outer-victim");
      const arrangeHostileHome = {
        symlink: () => {
          fs.mkdirSync(victim);
          fs.writeFileSync(path.join(victim, "proof"), "untouched\n");
          fs.symlinkSync(victim, fixture.hermesDir);
        },
        fifo: () => expect(spawnSync("mkfifo", [fixture.hermesDir]).status).toBe(0),
      } satisfies Record<typeof hostileKind, () => void>;
      arrangeHostileHome[hostileKind]();
      try {
        const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
          mode: "locked",
        });
        expect(begun.status, begun.stderr).toBe(0);
        expect(fs.lstatSync(fixture.hermesDir).isDirectory()).toBe(true);
        expect(mode(fixture.sandboxDir)).toBe(0o700);
        expect(mode(fixture.hermesDir)).toBe(0o500);
        const transition = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
        expect(transition.shields_transition.unavailable).toBe(true);
        for (const proofPath of hostileKind === "symlink" ? [path.join(victim, "proof")] : []) {
          expect(fs.readFileSync(proofPath, "utf-8")).toBe("untouched\n");
        }
      } finally {
        fs.chmodSync(fixture.sandboxDir, 0o700);
        fs.chmodSync(fixture.hermesDir, 0o700);
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  it("re-seals an applied mutable transition before recursive rollback", () => {
    const fixture = createRestartFixture();
    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "mutable",
        rollbackMode: "locked",
      });
      expect(begun.status, begun.stderr).toBe(0);
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(mode(fixture.hermesDir)).toBe(0o700);
      expect(mode(fixture.sandboxDir)).toBe(0o700);

      const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", { token });
      expect(applied.status, applied.stderr).toBe(0);
      expect(mode(fixture.hermesDir)).toBe(0o3770);

      const prepared = runShieldsTransactionAction(fixture, "prepare-shields-abort", { token });
      expect(prepared.status, prepared.stderr).toBe(0);
      const abortState = JSON.parse(fs.readFileSync(fixture.statePath, "utf-8"));
      expect(abortState.shields_transition.mode).toBe("locked");
      expect(mode(fixture.hermesDir)).toBe(0o700);
      expect(mode(fixture.sandboxDir)).toBe(0o700);

      const aborted = runShieldsTransactionAction(fixture, "abort-shields-transition", { token });
      expect(aborted.status, aborted.stderr).toBe(0);
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.sandboxDir)).toBe(0o1775);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.runIf(
    process.platform === "linux" &&
      process.getuid?.() === 0 &&
      spawnSync("setpriv", ["--version"], { encoding: "utf-8" }).status === 0,
  )("keeps the locked Hermes entry sticky-protected while allowing ordinary home writes", () => {
    const fixture = createRestartFixture();

    try {
      const locked = runShieldsTransition(fixture, "locked");
      expect(locked.status, locked.stderr).toBe(0);
      const parent = fs.statSync(fixture.sandboxDir);
      expect(parent.uid).toBe(0);
      expect(mode(fixture.sandboxDir)).toBe(0o1775);
      expect(fs.statSync(fixture.hermesDir).uid).toBe(0);

      const peer = spawnSync(
        "setpriv",
        [
          "--reuid=65534",
          "--regid=65534",
          `--groups=${String(parent.gid)}`,
          "sh",
          "-c",
          'touch "$1/peer-home-file" || exit 10; mv "$1/.hermes" "$1/.hermes-moved" 2>/dev/null && exit 20; test -d "$1/.hermes"',
          "sh",
          fixture.sandboxDir,
        ],
        { encoding: "utf-8", timeout: 5000 },
      );

      expect(peer.status, peer.stderr).toBe(0);
      expect(fs.existsSync(path.join(fixture.sandboxDir, "peer-home-file"))).toBe(true);
      expect(fs.existsSync(fixture.hermesDir)).toBe(true);
      expect(fs.existsSync(path.join(fixture.sandboxDir, ".hermes-moved"))).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses to finish after the sealed Hermes directory is swapped", () => {
    const fixture = createRestartFixture();

    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(begun.status, begun.stderr).toBe(0);
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      fs.chmodSync(fixture.hermesDir, 0o755);
      const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(applied.status, applied.stderr).toBe(0);
      expect(mode(fixture.sandboxDir)).toBe(0o755);

      const displaced = path.join(fixture.sandboxDir, ".hermes.displaced");
      fs.renameSync(fixture.hermesDir, displaced);
      fs.mkdirSync(fixture.hermesDir, { mode: 0o755 });

      const finished = runShieldsTransactionAction(fixture, "finish-shields-transition", {
        token,
      });
      expect(finished.status).not.toBe(0);
      expect(finished.stderr).toContain("refusing shields finish because .hermes changed");
      expect(fs.existsSync(fixture.statePath)).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(true);
      expect(mode(fixture.sandboxDir)).toBe(0o755);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps the transaction sealed when abort finds a corrupted compatibility hash", () => {
    const fixture = createRestartFixture();

    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      expect(begun.status, begun.stderr).toBe(0);
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      fs.chmodSync(fixture.hermesDir, 0o755);
      const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(applied.status, applied.stderr).toBe(0);

      fs.unlinkSync(fixture.compatHashPath);
      fs.writeFileSync(fixture.compatHashPath, "attacker-controlled hash\n", { mode: 0o444 });
      const prepared = runShieldsTransactionAction(fixture, "prepare-shields-abort", {
        token,
      });
      expect(prepared.status, prepared.stderr).toBe(0);
      const aborted = runShieldsTransactionAction(fixture, "abort-shields-transition", {
        token,
      });

      expect(aborted.status).not.toBe(0);
      expect(aborted.stderr).toContain("compat hash verification failed");
      expect(fs.existsSync(fixture.statePath)).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, "hermes-config-mutation.lock"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        true,
      );
      expect(mode(fixture.sandboxDir)).toBe(0o700);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("revokes descriptors opened after mutable apply before rolling back to locked", () => {
    const fixture = createRestartFixture();
    fs.chmodSync(fixture.sandboxDir, 0o1775);
    fs.chmodSync(fixture.hermesDir, 0o755);
    fs.chmodSync(fixture.configPath, 0o444);
    fs.chmodSync(fixture.envPath, 0o444);
    fs.chmodSync(fixture.compatHashPath, 0o444);
    let mutableFd: number | undefined;

    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "mutable",
        rollbackMode: "locked",
      });
      expect(begun.status, begun.stderr).toBe(0);
      expect(begun.stdout).toContain("original_locked=1");
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      const applied = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token,
      });
      expect(applied.status, applied.stderr).toBe(0);
      const appliedInode = fs.statSync(fixture.configPath).ino;
      mutableFd = fs.openSync(fixture.configPath, "r+");

      const prepared = runShieldsTransactionAction(fixture, "prepare-shields-abort", {
        token,
      });
      expect(prepared.status, prepared.stderr).toBe(0);
      expect(fs.statSync(fixture.configPath).ino).not.toBe(appliedInode);

      const aborted = runShieldsTransactionAction(fixture, "abort-shields-transition", {
        token,
      });
      expect(aborted.status, aborted.stderr).toBe(0);
      fs.writeSync(mutableFd, Buffer.from("PWNED!"), 0, 6, 0);
      fs.fsyncSync(mutableFd);

      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);
      expect(mode(fixture.sandboxDir)).toBe(0o1775);
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
    } finally {
      for (const openFd of mutableFd === undefined ? [] : [mutableFd]) fs.closeSync(openFd);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a foreign shields token and lets the owner abort to the exact prior posture", () => {
    const fixture = createRestartFixture();

    try {
      const begun = runShieldsTransactionAction(fixture, "begin-shields-transition", {
        mode: "locked",
      });
      const token = shieldsTransactionToken(begun.stdout);
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      const foreign = runShieldsTransactionAction(fixture, "apply-shields-transition", {
        token: randomBytes(32).toString("hex"),
      });
      expect(foreign.status).not.toBe(0);
      expect(foreign.stderr).toContain("lock token mismatch");

      const prepared = runShieldsTransactionAction(fixture, "prepare-shields-abort", {
        token,
      });
      expect(prepared.status, prepared.stderr).toBe(0);
      const aborted = runShieldsTransactionAction(fixture, "abort-shields-transition", {
        token,
      });
      expect(aborted.status, aborted.stderr).toBe(0);
      expect(mode(fixture.sandboxDir)).toBe(0o755);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o640);
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
    } finally {
      fs.chmodSync(fixture.sandboxDir, 0o700);
      fs.chmodSync(fixture.hermesDir, 0o700);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed without replacing or locking paths when the strict hash is stale", () => {
    const fixture = createRestartFixture();
    const configBefore = fs.statSync(fixture.configPath);
    const envBefore = fs.statSync(fixture.envPath);
    fs.writeFileSync(fixture.configPath, "model:\n  default: attacker-model\n");

    try {
      const sealed = runGuard("seal-restart", fixture);

      expect(sealed.status).not.toBe(0);
      expect(sealed.stderr).toContain("strict hash verification failed");
      expect(fs.statSync(fixture.configPath).ino).toBe(configBefore.ino);
      expect(fs.statSync(fixture.envPath).ino).toBe(envBefore.ino);
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(mode(fixture.configPath)).toBe(0o640);
      expect(mode(fixture.envPath)).toBe(0o600);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not bless a compat hash changed through a pre-open descriptor", () => {
    const fixture = createRestartFixture();
    const compatBefore = fs.statSync(fixture.compatHashPath);
    const compatFd = fs.openSync(fixture.compatHashPath, "r+");

    try {
      overwriteThroughOldFd(compatFd, compatBefore.size, "Z");
      const sealed = runGuard("seal-restart", fixture);

      expect(sealed.status).not.toBe(0);
      expect(sealed.stderr).toContain("compat hash verification failed");
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(fs.readFileSync(fixture.compatHashPath, "utf-8")).not.toBe(
        fs.readFileSync(fixture.hashPath, "utf-8"),
      );
      expect(mode(fixture.sandboxDir)).toBe(0o770);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
    } finally {
      fs.closeSync(compatFd);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves an already trusted shields-up directory posture across seal and unseal", () => {
    const fixture = createRestartFixture();
    fs.chmodSync(fixture.sandboxDir, 0o755);
    fs.chmodSync(fixture.hermesDir, 0o755);
    fs.chmodSync(fixture.configPath, 0o444);
    fs.chmodSync(fixture.envPath, 0o444);
    const configBefore = fs.statSync(fixture.configPath);
    const envBefore = fs.statSync(fixture.envPath);

    try {
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);
      expect(fs.statSync(fixture.configPath).ino).not.toBe(configBefore.ino);
      expect(fs.statSync(fixture.envPath).ino).not.toBe(envBefore.ino);
      expect(mode(fixture.sandboxDir)).toBe(0o755);
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.envPath)).toBe(0o444);
      expect(fs.statSync(fixture.hermesDir).uid).toBe(process.getuid!());
      expect(strictHashIsValid(fixture)).toBe(true);

      const unsealed = runGuard("unseal-restart", fixture);
      expect(unsealed.status, unsealed.stderr).toBe(0);
      expect(mode(fixture.sandboxDir)).toBe(0o755);
      expect(mode(fixture.hermesDir)).toBe(0o755);
      expect(mode(fixture.configPath)).toBe(0o444);
      expect(mode(fixture.envPath)).toBe(0o444);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(strictHashIsValid(fixture)).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.runIf(
    process.platform === "linux" &&
      process.getuid?.() === 0 &&
      spawnSync("setpriv", ["--version"], { encoding: "utf-8" }).status === 0,
  )("lets a sandbox-group peer create state but not unlink sealed config names", () => {
    const fixture = createRestartFixture();

    try {
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);

      const hermesGid = fs.statSync(fixture.hermesDir).gid;
      const peer = spawnSync(
        "setpriv",
        [
          "--reuid=65534",
          "--regid=65534",
          `--groups=${hermesGid}`,
          "sh",
          "-c",
          'touch "$1/peer-runtime-state" || exit 10; rm "$1/config.yaml" 2>/dev/null && exit 20; test -f "$1/config.yaml"',
          "sh",
          fixture.hermesDir,
        ],
        { encoding: "utf-8", timeout: 5000 },
      );

      expect(peer.status, peer.stderr).toBe(0);
      expect(fs.existsSync(path.join(fixture.hermesDir, "peer-runtime-state"))).toBe(true);
      expect(fs.readFileSync(fixture.configPath, "utf-8")).toBe(fixture.trustedConfig);

      const unsealed = runGuard("unseal-restart", fixture);
      expect(unsealed.status, unsealed.stderr).toBe(0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
