// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  allowRestartFixturePeerTraversal,
  createRestartFixture,
  mode,
  overwriteThroughOldFd,
  readTextFileSnapshot,
  RUNTIME_CONFIG_GUARD,
  runGuard,
  strictHashIsValid,
} from "../../helpers/hermes-restart-config-seal-fixture";

describe.skipIf(process.platform === "win32")("Hermes restart config recovery", () => {
  it("retires the orphan marker before returning directory ownership without DAC_OVERRIDE", () => {
    const fixture = createRestartFixture();
    try {
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);
      // Emulate Podman's missing DAC_OVERRIDE at the unlink boundary. All
      // path, inode, hash, marker, and rollback operations use the real guard.
      const result = spawnSync(
        "python3",
        [
          "-c",
          String.raw`
import errno, json, os, runpy, stat, sys
guard = runpy.run_path(sys.argv[1])
state_file = sys.argv[2]
with open(state_file) as stream:
    state = json.load(stream)
state["hermes"]["uid"] = os.geteuid() + 1
with open(state_file, "w") as stream:
    json.dump(state, stream)
owners = {}
real_chown, real_unlink = os.fchown, os.unlink
def restricted_chown(fd, uid, gid):
    owners[os.fstat(fd).st_ino] = uid
    if uid == os.geteuid():
        real_chown(fd, uid, gid)
def restricted_unlink(name, *, dir_fd=None):
    if name == guard["RESTART_ORPHAN_MARKER_NAME"]:
        metadata = os.fstat(dir_fd)
        if owners.get(metadata.st_ino, metadata.st_uid) != os.geteuid():
            raise PermissionError(errno.EACCES, os.strerror(errno.EACCES), name)
        assert stat.S_IMODE(os.stat(state["hermes_dir"] + "/..").st_mode) == 0o755
    return real_unlink(name, dir_fd=dir_fd)
os.fchown, os.unlink = restricted_chown, restricted_unlink
guard["_restore_restart_seal"](state_file, verify_hash=True)
hermes_metadata = os.stat(state["hermes_dir"])
assert owners.get(hermes_metadata.st_ino, hermes_metadata.st_uid) == state["hermes"]["uid"], "Hermes directory ownership was not restored"
`,
          RUNTIME_CONFIG_GUARD,
          fixture.statePath,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(fixture.statePath)).toBe(false);
      expect(fs.existsSync(path.join(fixture.hermesDir, ".nemoclaw-hermes-restart-seal"))).toBe(
        false,
      );
      expect(strictHashIsValid(fixture)).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("restores parent traversal permissions when peer setup fails", () => {
    const fixture = createRestartFixture();
    const isolatedParent = fs.mkdtempSync(path.join(path.dirname(fixture.root), "peer-setup-"));
    const isolatedRoot = path.join(isolatedParent, "fixture");
    fs.mkdirSync(isolatedRoot, { mode: 0o700 });
    fs.chmodSync(isolatedParent, 0o700);
    const isolatedFixture = { ...fixture, root: isolatedRoot };
    const realChmodSync = fs.chmodSync.bind(fs);
    const chmod = vi
      .spyOn(fs, "chmodSync")
      .mockImplementationOnce(realChmodSync)
      .mockImplementationOnce(() => {
        throw new Error("fixture chmod failed");
      })
      .mockImplementation(realChmodSync);

    try {
      expect(() => allowRestartFixturePeerTraversal(isolatedFixture)).toThrow(
        "fixture chmod failed",
      );
      expect(mode(isolatedParent)).toBe(0o700);
    } finally {
      chmod.mockRestore();
      fs.rmSync(isolatedParent, { recursive: true, force: true });
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not freeze files when the strict hash is stale", () => {
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

  it("does not trust a compatibility hash changed through a pre-open descriptor", () => {
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

  it.runIf(
    process.platform === "linux" &&
      process.getuid?.() === 0 &&
      spawnSync("setpriv", ["--version"], { encoding: "utf-8" }).status === 0,
  )("keeps config names protected while a sandbox-group peer writes runtime state", () => {
    const fixture = createRestartFixture();
    let restoreTempRootMode: (() => void) | undefined;

    try {
      const sandboxUidResult = spawnSync("id", ["-u", "sandbox"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      const sandboxGidResult = spawnSync("id", ["-g", "sandbox"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(sandboxUidResult.status, sandboxUidResult.stderr).toBe(0);
      expect(sandboxGidResult.status, sandboxGidResult.stderr).toBe(0);
      const sandboxUid = Number(sandboxUidResult.stdout.trim());
      const sandboxGid = Number(sandboxGidResult.stdout.trim());

      fs.chownSync(fixture.sandboxDir, sandboxUid, sandboxGid);
      fs.chownSync(fixture.hermesDir, sandboxUid, sandboxGid);
      fs.chownSync(fixture.configPath, sandboxUid, sandboxGid);
      fs.chownSync(fixture.envPath, sandboxUid, sandboxGid);
      fs.chownSync(fixture.compatHashPath, sandboxUid, sandboxGid);
      fs.chmodSync(fixture.hermesDir, 0o3770);

      restoreTempRootMode = allowRestartFixturePeerTraversal(fixture);
      const sealed = runGuard("seal-restart", fixture);
      expect(sealed.status, sealed.stderr).toBe(0);

      const sealedHermes = fs.statSync(fixture.hermesDir);
      expect(sealedHermes.uid).toBe(0);
      expect(sealedHermes.gid).toBe(sandboxGid);
      expect(mode(fixture.hermesDir)).toBe(0o3770);
      const peer = spawnSync(
        "setpriv",
        [
          "--reuid=65534",
          "--regid=65534",
          `--groups=${String(sandboxGid)}`,
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
      const expectSandboxOwner = (pathname: string) => {
        const restored = fs.statSync(pathname);
        expect(restored.uid).toBe(sandboxUid);
        expect(restored.gid).toBe(sandboxGid);
      };
      expectSandboxOwner(fixture.sandboxDir);
      expectSandboxOwner(fixture.hermesDir);
      expectSandboxOwner(fixture.configPath);
      expectSandboxOwner(fixture.envPath);
      expectSandboxOwner(fixture.compatHashPath);
    } finally {
      try {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      } finally {
        restoreTempRootMode?.();
      }
    }
  });
});
