// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createRestartFixture,
  mode,
  overwriteThroughOldFd,
  readTextFileSnapshot,
  runGuard,
  runShieldsTransactionAction,
  runShieldsTransition,
  shieldsTransactionToken,
  strictHashIsValid,
} from "./helpers/hermes-restart-config-seal-fixture";

describe.skipIf(process.platform === "win32")("Hermes mutable restart input seal", () => {
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
      mutableFd = fs.openSync(fixture.configPath, "r+");
      const appliedInode = fs.fstatSync(mutableFd).ino;

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

      expect(readTextFileSnapshot(fixture.configPath)).toBe(fixture.trustedConfig);
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
    const configFd = fs.openSync(fixture.configPath, "r+");
    const configBefore = fs.fstatSync(configFd);
    const envBefore = fs.statSync(fixture.envPath);
    try {
      fs.ftruncateSync(configFd, 0);
      fs.writeSync(configFd, "model:\n  default: attacker-model\n", 0, "utf8");
      fs.fsyncSync(configFd);
    } finally {
      fs.closeSync(configFd);
    }

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
    const compatFd = fs.openSync(fixture.compatHashPath, "r+");
    const compatBefore = fs.fstatSync(compatFd);

    try {
      overwriteThroughOldFd(compatFd, compatBefore.size, "Z");
      const sealed = runGuard("seal-restart", fixture);

      expect(sealed.status).not.toBe(0);
      expect(sealed.stderr).toContain("compat hash verification failed");
      expect(strictHashIsValid(fixture)).toBe(true);
      expect(readTextFileSnapshot(fixture.compatHashPath)).not.toBe(
        readTextFileSnapshot(fixture.hashPath),
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
