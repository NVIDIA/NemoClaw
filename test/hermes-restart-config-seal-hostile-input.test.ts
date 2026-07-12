// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createRestartFixture,
  mode,
  readTextFileSnapshot,
  runShieldsTransactionAction,
  shieldsTransactionToken,
} from "./helpers/hermes-restart-config-seal-fixture";

describe.skipIf(process.platform === "win32")("Hermes mutable restart input seal", () => {
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
    const externalFd = fs.openSync(external, "r+");
    const linkedInode = fs.fstatSync(externalFd).ino;
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
      fs.ftruncateSync(externalFd, 0);
      fs.writeSync(externalFd, "attacker rewrite\n", 0, "utf8");
      fs.fsyncSync(externalFd);
      expect(readTextFileSnapshot(fixture.configPath)).toBe(fixture.trustedConfig);

      fs.chmodSync(fixture.hermesDir, 0o755);
      expect(
        runShieldsTransactionAction(fixture, "apply-shields-transition", { token }).status,
      ).toBe(0);
      expect(
        runShieldsTransactionAction(fixture, "finish-shields-transition", { token }).status,
      ).toBe(0);
    } finally {
      fs.closeSync(externalFd);
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
});
