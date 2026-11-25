// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_UPGRADE_EXECUTABLE_DIRECTORY_SCRIPT,
  prepareGatewayUpgradeExecutableDirectory,
} from "../fixtures/gateway-upgrade-executable-directory.ts";

let root = "";
afterEach(() => {
  root && fs.rmSync(root, { recursive: true, force: true });
  root = "";
  vi.unstubAllEnvs();
});

function fixture() {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gateway-upgrade-bin-"));
  const parent = path.join(root, "local");
  const target = path.join(parent, "bin");
  const outside = path.join(root, "outside");
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(outside);
  fs.chmodSync(root, 0o755);
  fs.chmodSync(parent, 0o755);
  fs.chmodSync(target, 0o777);
  fs.chmodSync(outside, 0o777);
  return { parent, target, outside };
}

function run(target: string, uid = String(process.getuid?.())) {
  return spawnSync("python3", ["-c", GATEWAY_UPGRADE_EXECUTABLE_DIRECTORY_SCRIPT, target, uid], {
    encoding: "utf8",
    timeout: 5_000,
  });
}

describe.skipIf(process.platform === "win32")(
  "legacy gateway executable directory preparation",
  () => {
    it.each([
      { before: 0o755, after: 0o755 },
      { before: 0o775, after: 0o755 },
      { before: 0o777, after: 0o755 },
      { before: 0o1777, after: 0o1755 },
    ])("removes only group and world write bits from mode $before", ({ before, after }) => {
      const { target } = fixture();
      fs.chmodSync(target, before);
      const identity = fs.statSync(target);
      const result = run(target);
      const actual = fs.statSync(target);
      expect(result.status, result.stderr).toBe(0);
      expect([actual.dev, actual.ino, actual.uid, actual.mode & 0o7777]).toEqual([
        identity.dev,
        identity.ino,
        identity.uid,
        after,
      ]);
      expect(JSON.parse(result.stdout)).toEqual({
        path: target,
        uid: identity.uid,
        beforeMode: `0o${before.toString(8)}`,
        afterMode: `0o${after.toString(8)}`,
      });
    });

    it("rejects a symlink without changing its destination", () => {
      const { target, outside } = fixture();
      fs.rmdirSync(target);
      fs.symlinkSync(outside, target);
      const result = run(target);
      expect(result.status).toBe(1);
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.statSync(outside).mode & 0o777).toBe(0o777);
    });

    it("rejects a writable ancestor without changing the target", () => {
      const { target, parent } = fixture();
      fs.chmodSync(parent, 0o775);
      const result = run(target);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unsafe executable directory ancestor");
      expect([fs.statSync(parent).mode & 0o777, fs.statSync(target).mode & 0o777]).toEqual([
        0o775, 0o777,
      ]);
    });

    it("rejects a symlinked ancestor without changing its destination", () => {
      const { parent, target, outside } = fixture();
      fs.rmdirSync(target);
      fs.rmdirSync(parent);
      fs.symlinkSync(outside, parent);
      fs.mkdirSync(path.join(outside, "bin"));
      fs.chmodSync(path.join(outside, "bin"), 0o777);
      const result = run(target);
      expect(result.status).toBe(1);
      expect(fs.statSync(path.join(outside, "bin")).mode & 0o777).toBe(0o777);
    });

    it("requires root or runner ownership throughout the path", () => {
      const { target } = fixture();
      const result = run(target, "0");
      const rootOwned = process.getuid?.() === 0;
      expect(result.status).toBe(rootOwned ? 0 : 1);
      expect(fs.statSync(target).mode & 0o777).toBe(rootOwned ? 0o755 : 0o777);
    });

    it("rejects a file without changing its contents or mode", () => {
      const { target } = fixture();
      fs.rmdirSync(target);
      fs.writeFileSync(target, "preserve", { mode: 0o600 });
      const result = run(target);
      expect(result.status).toBe(1);
      expect(fs.readFileSync(target, "utf8")).toBe("preserve");
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    });

    it.each(["relative/bin", "/usr/../bin", "/usr//bin"])(
      "rejects a noncanonical path before directory access: %s",
      (target) => {
        const result = run(target);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("canonical and absolute");
      },
    );

    it("rejects an invalid runner identity without changing the target", () => {
      const { target } = fixture();
      const result = run(target, "not-a-uid");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("invalid runner uid");
      expect(fs.statSync(target).mode & 0o777).toBe(0o777);
    });

    it.each([
      { exitCode: 0, signal: null, timedOut: false, rejected: false },
      { exitCode: 1, signal: null, timedOut: false, rejected: true },
      { exitCode: null, signal: null, timedOut: false, rejected: true },
      { exitCode: 0, signal: "SIGTERM", timedOut: false, rejected: true },
      { exitCode: 0, signal: null, timedOut: true, rejected: true },
    ])("propagates preparation failure: $exitCode/$signal/$timedOut", async (row) => {
      const command = vi.fn().mockResolvedValue({ ...row, stdout: "", stderr: "fixture failure" });
      const rejected = await prepareGatewayUpgradeExecutableDirectory({ command }, {}, true).then(
        () => false,
        () => true,
      );
      expect(rejected).toBe(row.rejected);
      expect(command).toHaveBeenCalledWith(
        "/usr/bin/sudo",
        [
          "-n",
          "/usr/bin/python3",
          "-I",
          "-c",
          GATEWAY_UPGRADE_EXECUTABLE_DIRECTORY_SCRIPT,
          "/usr/local/bin",
          String(process.getuid?.()),
        ],
        { artifactName: "prepare-legacy-executable-directory", env: {}, timeoutMs: 30_000 },
      );
    });

    it("does not prepare a developer host", async () => {
      vi.stubEnv("GITHUB_ACTIONS", "false");
      const command = vi.fn();
      await prepareGatewayUpgradeExecutableDirectory({ command }, {});
      expect(command).not.toHaveBeenCalled();
    });
  },
);
