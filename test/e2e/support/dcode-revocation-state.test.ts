// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Deep Code revocation state evidence", () => {
  it("detects conversation and workspace changes across revocation without exposing their contents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-revocation-state-"));
    let database: DatabaseSync | undefined;
    try {
      const source = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; native_state_digest_source',
          "revocation-state-test",
          fileURLToPath(
            new URL(
              "../e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh",
              import.meta.url,
            ),
          ),
        ],
        { encoding: "utf8" },
      );
      expect(source.status, source.stderr).toBe(0);
      const readDigest = () =>
        spawnSync("python3", ["-I", "-c", source.stdout, root], {
          encoding: "utf8",
        });
      expect(readDigest().status).not.toBe(0);
      fs.mkdirSync(path.join(root, ".deepagents/.state"), { recursive: true });
      database = new DatabaseSync(path.join(root, ".deepagents/.state/sessions.db"));
      database.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE writes (value BLOB)",
      );
      database.prepare("INSERT INTO writes VALUES (?)").run(Buffer.from("private conversation"));
      const marker = path.join(root, ".nemoclaw-e2e-autorun-write");
      fs.writeFileSync(
        path.join(root, ".nemoclaw-e2e-autorun-shell-1"),
        "private workspace content",
      );
      fs.writeFileSync(marker, "private workspace content");
      fs.writeFileSync(
        path.join(root, ".nemoclaw-e2e-autorun-shell-3"),
        "private workspace content",
      );
      const before = readDigest();
      expect(before.status, before.stderr).toBe(0);
      expect(before.stdout.trim()).toMatch(/^[a-f0-9]{64}$/u);
      expect(before.stderr).toBe("");
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      expect(readDigest().stdout).toBe(before.stdout);
      database.prepare("INSERT INTO writes VALUES (?)").run(Buffer.from("another conversation"));
      const changedConversation = readDigest();
      expect(changedConversation.status, changedConversation.stderr).toBe(0);
      expect(changedConversation.stdout).not.toBe(before.stdout);
      fs.writeFileSync(marker, "changed workspace");
      const changedWorkspace = readDigest();
      expect(changedWorkspace.status, changedWorkspace.stderr).toBe(0);
      expect(changedWorkspace.stdout).not.toBe(changedConversation.stdout);
      fs.unlinkSync(marker);
      expect(readDigest().status).not.toBe(0);
    } finally {
      database?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
