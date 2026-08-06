// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";

interface AlternateIdentity {
  gid: number;
  name: string;
  uid: number;
  invocationPrefix: string[];
}

function passwdIdentity(name: string): Omit<AlternateIdentity, "invocationPrefix"> | undefined {
  const result = spawnSync("/usr/bin/getent", ["passwd", name], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const fields = result.stdout.trim().split(":");
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0) {
    return undefined;
  }
  return { gid, name, uid };
}

function resolveAlternateIdentity(): AlternateIdentity | undefined {
  if (
    process.platform !== "linux" ||
    !fs.existsSync("/usr/bin/getent") ||
    !fs.existsSync("/usr/bin/setpriv")
  ) {
    return undefined;
  }
  const currentUid = process.geteuid?.() ?? process.getuid?.();
  const identity = ["nemoclaw-cua-artifact", "nobody"]
    .map(passwdIdentity)
    .find((candidate) => candidate !== undefined && candidate.uid !== currentUid);
  if (identity === undefined) return undefined;

  const setpriv = [
    "/usr/bin/setpriv",
    `--reuid=${String(identity.uid)}`,
    `--regid=${String(identity.gid)}`,
    "--clear-groups",
    "--bounding-set=-all",
    "--no-new-privs",
    "--",
  ];
  const invocationPrefix =
    currentUid === 0
      ? setpriv
      : fs.existsSync("/usr/bin/sudo")
        ? ["/usr/bin/sudo", "-n", "--", ...setpriv]
        : [];
  if (invocationPrefix.length === 0) return undefined;

  const capability = spawnSync(
    invocationPrefix[0]!,
    [...invocationPrefix.slice(1), "/usr/bin/true"],
    {
      stdio: "ignore",
    },
  );
  return capability.status === 0 ? { ...identity, invocationPrefix } : undefined;
}

const alternateIdentity = resolveAlternateIdentity();

function runAsAlternate(command: string, args: string[]) {
  if (alternateIdentity === undefined) throw new Error("alternate identity is unavailable");
  return spawnSync(
    alternateIdentity.invocationPrefix[0]!,
    [...alternateIdentity.invocationPrefix.slice(1), command, ...args],
    { encoding: "utf8" },
  );
}

describe.skipIf(process.platform === "win32")("E2E artifact permissions", () => {
  it("publishes only private directories and regular owner-only files", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-artifact-permissions-"));
    fs.chmodSync(parent, 0o755);
    try {
      const root = path.join(parent, "one-test");
      const artifacts = new ArtifactSink(root);
      const artifact = await artifacts.writeText(
        "shell/prior-command.stdout.txt",
        "controller-only-shell-artifact\n",
      );

      const rootStat = fs.lstatSync(root);
      const shellStat = fs.lstatSync(path.dirname(artifact));
      const artifactStat = fs.lstatSync(artifact);
      expect(rootStat.isDirectory()).toBe(true);
      expect(rootStat.isSymbolicLink()).toBe(false);
      expect(rootStat.mode & 0o777).toBe(0o700);
      expect(shellStat.isDirectory()).toBe(true);
      expect(shellStat.isSymbolicLink()).toBe(false);
      expect(shellStat.mode & 0o777).toBe(0o700);
      expect(artifactStat.isFile()).toBe(true);
      expect(artifactStat.isSymbolicLink()).toBe(false);
      expect(artifactStat.nlink).toBe(1);
      expect(artifactStat.mode & 0o777).toBe(0o600);

      const outside = path.join(parent, "outside.txt");
      fs.writeFileSync(outside, "must-not-change\n", { mode: 0o600 });
      fs.unlinkSync(artifact);
      fs.symlinkSync(outside, artifact);
      await artifacts.writeText("shell/prior-command.stdout.txt", "replacement\n");

      expect(fs.readFileSync(outside, "utf8")).toBe("must-not-change\n");
      const replacementStat = fs.lstatSync(artifact);
      expect(replacementStat.isFile()).toBe(true);
      expect(replacementStat.isSymbolicLink()).toBe(false);
      expect(replacementStat.nlink).toBe(1);
      expect(replacementStat.mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(artifact, "utf8")).toBe("replacement\n");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it.skipIf(alternateIdentity === undefined)(
    "denies an unrelated dedicated UID access to a prior shell artifact",
    async () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-artifact-uid-"));
      fs.chmodSync(parent, 0o755);
      try {
        const root = path.join(parent, "one-test");
        const artifact = await new ArtifactSink(root).writeText(
          "shell/prior-command.stderr.txt",
          "controller-only-shell-artifact\n",
        );

        const traverse = runAsAlternate("/usr/bin/test", ["-x", root]);
        expect(traverse.status, traverse.stderr).not.toBe(0);
        const read = runAsAlternate("/bin/cat", [artifact]);
        expect(read.status, `${alternateIdentity!.name}: ${read.stderr}`).not.toBe(0);
        expect(read.stdout).toBe("");
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
  );
});
