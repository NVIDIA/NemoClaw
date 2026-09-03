// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withMcpLifecycleLock } from "../mcp-lifecycle-lock-acquisition";
import { MCP_LIFECYCLE_LOCK_DIRNAME } from "../mcp-lifecycle-lock-storage";
import {
  enforceRemovedImmutabilityMigrationBoundary,
  inspectRemovedImmutabilityMigration,
  reportRemovedImmutabilityUpgrade,
  retireRemovedImmutabilityStateRecord,
} from "./removed-immutability";

const roots: string[] = [];

function stateDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-removed-immutability-"));
  roots.push(root);
  return root;
}

function touch(root: string, relativePath: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "fixture\n");
  return target;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("removed immutability migration boundary", () => {
  it("treats an absent state directory and invalid pre-parse name as clean", () => {
    const root = stateDir();
    fs.rmSync(root, { recursive: true, force: true });

    expect(inspectRemovedImmutabilityMigration("alpha", root)).toEqual({
      stateRecord: null,
      recoveryArtifacts: [],
    });
    expect(inspectRemovedImmutabilityMigration("../alpha", root)).toEqual({
      stateRecord: null,
      recoveryArtifacts: [],
    });
  });

  it("reports an inert legacy state record without interpreting its contents", () => {
    const root = stateDir();
    const record = touch(root, "shields-alpha.json");
    const warn = vi.fn();

    expect(() => enforceRemovedImmutabilityMigrationBoundary("alpha", { stateDir: root })).toThrow(
      /mutable posture cannot be proven.*rebuild\/recreate/u,
    );
    expect(
      enforceRemovedImmutabilityMigrationBoundary("alpha", {
        stateDir: root,
        allowStateRecord: true,
      }),
    ).toEqual({ stateRecord: record, recoveryArtifacts: [] });
    expect(reportRemovedImmutabilityUpgrade({ stateDir: root, warn })).toEqual({
      affectedSandboxes: ["alpha"],
      hasUnattributedRecoveryState: false,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("has been retired"));
  });

  it.each([
    [
      "symbolic link",
      (root: string, record: string) => {
        const target = touch(root, "linked-state.json");
        fs.symlinkSync(target, record);
      },
    ],
    ["directory", (_root: string, record: string) => fs.mkdirSync(record)],
    [
      "FIFO",
      (_root: string, record: string) => {
        const created = spawnSync("mkfifo", [record], { encoding: "utf8" });
        expect(created.status, created.stderr).toBe(0);
      },
    ],
    [
      "multiply-linked file",
      (root: string, record: string) => {
        fs.writeFileSync(record, "fixture\n");
        fs.linkSync(record, path.join(root, "state-alias.json"));
      },
    ],
  ] as const)("blocks an unsafe legacy state record that is a %s", (_kind, arrange) => {
    const root = stateDir();
    const record = path.join(root, "shields-alpha.json");
    arrange(root, record);

    expect(inspectRemovedImmutabilityMigration("alpha", root)).toEqual({
      stateRecord: null,
      recoveryArtifacts: [record],
    });
    expect(() =>
      enforceRemovedImmutabilityMigrationBoundary("alpha", {
        allowStateRecord: true,
        stateDir: root,
      }),
    ).toThrow(/Blocking paths to quarantine/u);
  });

  it("blocks a legacy state record when its no-follow inspection fails", () => {
    const root = stateDir();
    const record = touch(root, "shields-alpha.json");
    fs.chmodSync(record, 0o000);
    vi.spyOn(fs, "openSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    expect(inspectRemovedImmutabilityMigration("alpha", root)).toEqual({
      stateRecord: null,
      recoveryArtifacts: [record],
    });
  });

  it("blocks every requested name while top-level recovery artifacts remain", () => {
    const root = stateDir();
    const token = "a".repeat(32);
    touch(root, "shields-timer-alpha.json");
    touch(root, `shields-transition-alpha-${token}.json`);
    touch(root, `shields-forward-policy-alpha-${token}.yaml`);
    touch(root, `shields-timer-authorization-alpha-${token}.json`);
    touch(root, "shields-transition-lock-alpha.json");
    touch(root, "shields-external-policy-alpha.yaml");
    touch(root, `policy-snapshot-alpha-${token}-${"b".repeat(16)}.yaml`);
    touch(root, `shields-transition-alpha-other-${token}.json`);
    touch(root, `shields-transition-alpha-${token.slice(1)}.json`);

    const inspection = inspectRemovedImmutabilityMigration("alpha", root);
    expect(inspection.recoveryArtifacts).toHaveLength(9);
    expect(inspectRemovedImmutabilityMigration("replacement", root).recoveryArtifacts).toEqual(
      inspection.recoveryArtifacts,
    );
    expect(() => enforceRemovedImmutabilityMigrationBoundary("alpha", { stateDir: root })).toThrow(
      /older detached process.*different requested sandbox name does not make/u,
    );
    expect(() =>
      enforceRemovedImmutabilityMigrationBoundary("replacement", { stateDir: root }),
    ).toThrow(/older detached process.*different requested sandbox name does not make/u);
  });

  it("warns and globally blocks obsolete deadline and containment sentinels", () => {
    const root = stateDir();
    const warn = vi.fn();
    const alphaStem = crypto.createHash("sha256").update("alpha").digest("hex");
    const betaStem = crypto.createHash("sha256").update("beta").digest("hex");
    touch(root, path.join(MCP_LIFECYCLE_LOCK_DIRNAME, `${alphaStem}.lock.deadline`));
    touch(root, path.join(MCP_LIFECYCLE_LOCK_DIRNAME, `${alphaStem}.lock.containment`));
    touch(root, path.join(MCP_LIFECYCLE_LOCK_DIRNAME, `${betaStem}.lock.deadline`));

    const inspection = inspectRemovedImmutabilityMigration("alpha", root);
    expect(inspection.recoveryArtifacts).toEqual([
      path.join(root, MCP_LIFECYCLE_LOCK_DIRNAME, `${alphaStem}.lock.containment`),
      path.join(root, MCP_LIFECYCLE_LOCK_DIRNAME, `${alphaStem}.lock.deadline`),
      path.join(root, MCP_LIFECYCLE_LOCK_DIRNAME, `${betaStem}.lock.deadline`),
    ]);
    expect(inspectRemovedImmutabilityMigration("new-name", root).recoveryArtifacts).toEqual(
      inspection.recoveryArtifacts,
    );
    expect(() =>
      enforceRemovedImmutabilityMigrationBoundary("new-name", { stateDir: root }),
    ).toThrow(/different requested sandbox name does not make/u);
    expect(reportRemovedImmutabilityUpgrade({ stateDir: root, warn })).toEqual({
      affectedSandboxes: [],
      hasUnattributedRecoveryState: true,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recovery state also remains"));
  });

  it("does not misattribute timer and transition filenames as sandbox state records", () => {
    const root = stateDir();
    touch(root, "shields-timer-alpha.json");
    touch(root, "shields-transition-lock-alpha.json");
    const warn = vi.fn();

    expect(reportRemovedImmutabilityUpgrade({ stateDir: root, warn })).toEqual({
      affectedSandboxes: [],
      hasUnattributedRecoveryState: true,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recovery state also remains"));
  });

  it("reports provider ownership but globally blocks retained provider authority", () => {
    const root = stateDir();
    const transactionId = "c".repeat(64);
    const transactionDir = path.join(root, "runtime-provider-lifecycle", transactionId);
    const target = touch(
      root,
      path.join("runtime-provider-lifecycle", transactionId, "prepared.json"),
    );
    fs.writeFileSync(
      target,
      `${JSON.stringify({ schemaVersion: 1, sandboxName: "alpha", phase: "prepared" })}\n`,
    );

    expect(inspectRemovedImmutabilityMigration("alpha", root).recoveryArtifacts).toEqual([
      transactionDir,
    ]);
    expect(inspectRemovedImmutabilityMigration("beta", root).recoveryArtifacts).toEqual([
      transactionDir,
    ]);
    expect(() => enforceRemovedImmutabilityMigrationBoundary("alpha", { stateDir: root })).toThrow(
      /older detached process/u,
    );
    let blockedMessage = "";
    try {
      enforceRemovedImmutabilityMigrationBoundary("beta", { stateDir: root });
    } catch (error) {
      blockedMessage = error instanceof Error ? error.message : String(error);
    }
    expect(blockedMessage).toContain(`Active NemoClaw state directory: ${JSON.stringify(root)}`);
    expect(blockedMessage).toContain(JSON.stringify(transactionDir));
    expect(blockedMessage).toMatch(/Reboot the host.*whole transaction directory/u);
    expect(blockedMessage).toMatch(/different requested sandbox name does not make/u);

    const quarantineRoot = stateDir();
    const backupDir = path.join(quarantineRoot, `${transactionId}.backup`);
    const quarantinedDir = path.join(quarantineRoot, transactionId);
    fs.cpSync(transactionDir, backupDir, { recursive: true });
    expect(() =>
      enforceRemovedImmutabilityMigrationBoundary("replacement", { stateDir: root }),
    ).toThrow(/different requested sandbox name does not make/u);
    fs.renameSync(transactionDir, quarantinedDir);

    expect(fs.existsSync(path.join(backupDir, "prepared.json"))).toBe(true);
    expect(fs.existsSync(path.join(quarantinedDir, "prepared.json"))).toBe(true);
    expect(enforceRemovedImmutabilityMigrationBoundary("beta", { stateDir: root })).toEqual({
      stateRecord: null,
      recoveryArtifacts: [],
    });
  });

  it("announces every unattributed provider intent without assigning them to a new name", () => {
    const root = stateDir();
    const firstTransactionDir = path.join("runtime-provider-lifecycle", "d".repeat(64));
    const secondTransactionDir = path.join("runtime-provider-lifecycle", "f".repeat(64));
    touch(root, path.join(firstTransactionDir, "state-mutation-intent.json"));
    touch(root, path.join(secondTransactionDir, "state-mutation-intent.json"));
    const firstNoticePath = path.join(root, firstTransactionDir);
    const secondNoticePath = path.join(root, secondTransactionDir);
    const warn = vi.fn();

    const recoveryArtifacts = inspectRemovedImmutabilityMigration("alpha", root).recoveryArtifacts;
    expect(recoveryArtifacts).not.toContain(firstNoticePath);
    expect(recoveryArtifacts).not.toContain(secondNoticePath);
    expect(reportRemovedImmutabilityUpgrade({ stateDir: root, warn })).toMatchObject({
      hasUnattributedRecoveryState: true,
    });
    expect(warn).toHaveBeenCalledOnce();
    const warning = String(warn.mock.calls[0]?.[0]);
    expect(warning).toContain("Nonblocking retired provider intent paths retained for review:");
    expect(warning).toContain(JSON.stringify(firstNoticePath));
    expect(warning).toContain(JSON.stringify(secondNoticePath));
    expect(warning).toContain("did not establish mutation authority");
    expect(warning).toContain("do not block lifecycle operations");
    expect(warning).not.toContain("quarantine");
    expect(warning).not.toContain("rebuild or recreate");
    expect(enforceRemovedImmutabilityMigrationBoundary("alpha", { stateDir: root })).toEqual({
      stateRecord: null,
      recoveryArtifacts: [],
    });
  });

  it.each(["new-sandbox", "deleted-name-reused"])(
    "preserves malformed provider authority and blocks requested name %s",
    (sandboxName) => {
      const root = stateDir();
      const transactionDir = path.join(root, "runtime-provider-lifecycle", "e".repeat(64));
      const malformed = touch(
        root,
        path.join("runtime-provider-lifecycle", "e".repeat(64), "prepared.json"),
      );

      expect(fs.existsSync(malformed)).toBe(true);
      expect(inspectRemovedImmutabilityMigration(sandboxName, root).recoveryArtifacts).toContain(
        transactionDir,
      );
      expect(() =>
        enforceRemovedImmutabilityMigrationBoundary(sandboxName, { stateDir: root }),
      ).toThrow(/Reboot the host.*quarantine directory outside/u);
    },
  );

  it("retires the exact inert record only under the sandbox lifecycle lock", async () => {
    const root = stateDir();
    const record = touch(root, "shields-alpha.json");

    expect(() => retireRemovedImmutabilityStateRecord("alpha", "mutable-rebuild", root)).toThrow(
      /without its lifecycle lock/u,
    );

    await withMcpLifecycleLock("alpha", () => {
      expect(retireRemovedImmutabilityStateRecord("alpha", "mutable-rebuild", root)).toBe(true);
    });

    expect(fs.existsSync(record)).toBe(false);
  });
});
