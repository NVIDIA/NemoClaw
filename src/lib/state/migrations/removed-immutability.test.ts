// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
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

  it("blocks exact timer and transition artifacts without matching another sandbox", () => {
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
    expect(inspection.recoveryArtifacts).toHaveLength(7);
    expect(inspection.recoveryArtifacts).not.toEqual(
      expect.arrayContaining([path.join(root, `shields-transition-alpha-other-${token}.json`)]),
    );
    expect(() => enforceRemovedImmutabilityMigrationBoundary("alpha", { stateDir: root })).toThrow(
      /older detached process.*replacement under a new name/u,
    );
  });

  it("blocks obsolete deadline and containment sentinels for the exact sandbox digest", () => {
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
    ]);
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

  it("maps retired runtime-provider lifecycle authority to its sandbox", () => {
    const root = stateDir();
    const transactionId = "c".repeat(64);
    const recordPath = path.join("runtime-provider-lifecycle", transactionId, "prepared.json");
    const target = touch(root, recordPath);
    fs.writeFileSync(
      target,
      `${JSON.stringify({ schemaVersion: 1, sandboxName: "alpha", phase: "prepared" })}\n`,
    );

    expect(inspectRemovedImmutabilityMigration("alpha", root).recoveryArtifacts).toContain(target);
    expect(inspectRemovedImmutabilityMigration("beta", root).recoveryArtifacts).not.toContain(
      target,
    );
    expect(() => enforceRemovedImmutabilityMigrationBoundary("alpha", { stateDir: root })).toThrow(
      /older detached process/u,
    );
  });

  it("announces an unattributed provider intent without assigning it to a new name", () => {
    const root = stateDir();
    const transactionDir = path.join("runtime-provider-lifecycle", "d".repeat(64));
    touch(root, path.join(transactionDir, "state-mutation-intent.json"));

    expect(inspectRemovedImmutabilityMigration("alpha", root).recoveryArtifacts).not.toContain(
      path.join(root, transactionDir),
    );
    expect(reportRemovedImmutabilityUpgrade({ stateDir: root, warn: vi.fn() })).toMatchObject({
      hasUnattributedRecoveryState: true,
    });
  });

  it.each(["new-sandbox", "deleted-name-reused"])(
    "preserves malformed provider authority and blocks requested name %s",
    (sandboxName) => {
      const root = stateDir();
      const malformed = touch(
        root,
        path.join("runtime-provider-lifecycle", "e".repeat(64), "prepared.json"),
      );

      expect(inspectRemovedImmutabilityMigration(sandboxName, root).recoveryArtifacts).toContain(
        malformed,
      );
      expect(() =>
        enforceRemovedImmutabilityMigrationBoundary(sandboxName, { stateDir: root }),
      ).toThrow(/unattributed provider authority must be resolved before any sandbox mutation/u);
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
