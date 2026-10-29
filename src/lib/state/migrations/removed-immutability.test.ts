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
  assertRemovedImmutabilityRecoveryDownloadArtifactSafe,
  enforceRemovedImmutabilityMigrationBoundary,
  inspectRemovedImmutabilityMigration,
  isRemovedImmutabilityRecoveryDownloadPath,
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
      /mutable posture cannot be proven.*Run `rebuild` for this sandbox.*Onboarding cannot recreate it/u,
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
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Affected sandbox records: alpha. Run `rebuild` for each affected"),
    );
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
  ] as const)(
    "blocks an unsafe legacy state record that is a %s and the notice directs quarantine",
    (_kind, arrange) => {
      const root = stateDir();
      const record = path.join(root, "shields-alpha.json");
      arrange(root, record);
      const warn = vi.fn();

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
      expect(reportRemovedImmutabilityUpgrade({ stateDir: root, warn })).toEqual({
        affectedSandboxes: ["alpha"],
        hasUnattributedRecoveryState: false,
      });
      const warning = String(warn.mock.calls[0]?.[0]);
      expect(warning).toContain("Quarantine the files that a blocked command lists");
      expect(warning).not.toContain("Run `rebuild` for each affected sandbox");
    },
  );

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
    const warning = String(warn.mock.calls[0]?.[0]);
    expect(warning).toContain("Quarantine the files that a blocked command lists");
    expect(warning).not.toContain("Run `rebuild` for each affected sandbox");
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
    const warn = vi.fn();
    expect(reportRemovedImmutabilityUpgrade({ stateDir: root, warn })).toEqual({
      affectedSandboxes: ["alpha"],
      hasUnattributedRecoveryState: false,
    });
    const warning = String(warn.mock.calls[0]?.[0]);
    expect(warning).toContain("Affected sandbox records: alpha.");
    expect(warning).toContain("Quarantine the files that a blocked command lists");
    expect(warning).not.toContain("Run `rebuild` for each affected sandbox");
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
    expect(warning).not.toContain("Run `rebuild`");
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

  it("limits legacy-record recovery downloads to documented credential-free paths and content", () => {
    const root = stateDir();
    const safeFile = touch(root, "SOUL.md");
    fs.writeFileSync(safeFile, "# Soul\nReference: https://example.com\n");
    const secretFile = touch(root, "secret.md");
    fs.writeFileSync(secretFile, `OPENAI_API_KEY=${"sk-" + "a".repeat(32)}\n`);
    const oversizeFile = touch(root, "oversize.md");
    fs.truncateSync(oversizeFile, 16 * 1024 * 1024 + 1);
    const nestedSecretDir = path.join(root, "memory");
    touch(nestedSecretDir, ".env");

    expect(isRemovedImmutabilityRecoveryDownloadPath("/sandbox/.openclaw/workspace/SOUL.md")).toBe(
      true,
    );
    expect(isRemovedImmutabilityRecoveryDownloadPath("/sandbox/.openclaw/workspace/memory/")).toBe(
      true,
    );
    expect(
      isRemovedImmutabilityRecoveryDownloadPath("/sandbox/.openclaw/credentials/tokens.json"),
    ).toBe(false);
    expect(isRemovedImmutabilityRecoveryDownloadPath("/sandbox/.hermes/.env")).toBe(false);
    expect(isRemovedImmutabilityRecoveryDownloadPath("/sandbox/.hermes/state.db")).toBe(false);
    expect(isRemovedImmutabilityRecoveryDownloadPath("/sandbox/.deepagents/.state/auth.json")).toBe(
      false,
    );
    expect(() =>
      assertRemovedImmutabilityRecoveryDownloadArtifactSafe(
        safeFile,
        "/sandbox/.openclaw/workspace/SOUL.md",
        "alpha",
      ),
    ).not.toThrow();
    expect(() =>
      assertRemovedImmutabilityRecoveryDownloadArtifactSafe(
        secretFile,
        "/sandbox/.openclaw/workspace/SOUL.md",
        "alpha",
      ),
    ).toThrow(/credential-bearing or uninspectable material/u);
    expect(() =>
      assertRemovedImmutabilityRecoveryDownloadArtifactSafe(
        oversizeFile,
        "/sandbox/.openclaw/workspace/SOUL.md",
        "alpha",
      ),
    ).toThrow(/credential-bearing or uninspectable material/u);
    expect(() =>
      assertRemovedImmutabilityRecoveryDownloadArtifactSafe(
        nestedSecretDir,
        "/sandbox/.openclaw/workspace/memory/",
        "alpha",
      ),
    ).toThrow(/credential-bearing or uninspectable material/u);
  });

  it("rejects a WhatsApp session credential file from legacy-record recovery downloads", () => {
    expect(
      isRemovedImmutabilityRecoveryDownloadPath("/sandbox/.hermes/platforms/whatsapp/session"),
    ).toBe(false);
    expect(
      isRemovedImmutabilityRecoveryDownloadPath(
        "/sandbox/.hermes/platforms/whatsapp/session/creds.json",
      ),
    ).toBe(false);
  });

  it("rejects WhatsApp session credentials inside a staged platforms directory", () => {
    const root = stateDir();
    const platforms = path.join(root, "platforms");
    const credentials = path.join(platforms, "whatsapp/session/creds.json");
    fs.mkdirSync(path.dirname(credentials), { recursive: true });
    fs.writeFileSync(
      credentials,
      JSON.stringify({
        noiseKey: { private: [1, 2, 3] },
        signedIdentityKey: { private: [4, 5, 6] },
      }),
    );

    expect(() =>
      assertRemovedImmutabilityRecoveryDownloadArtifactSafe(
        platforms,
        "/sandbox/.hermes/platforms/",
        "alpha",
      ),
    ).toThrow(/credential-bearing or uninspectable material/u);
  });

  it("rejects non-text legacy recovery files without blocking ordinary text whitespace", () => {
    const root = stateDir();
    const file = touch(root, "SOUL.md");
    const assertSafe = () =>
      assertRemovedImmutabilityRecoveryDownloadArtifactSafe(
        file,
        "/sandbox/.openclaw/workspace/SOUL.md",
        "alpha",
      );

    fs.writeFileSync(file, Buffer.from([0xff]));
    expect(assertSafe).toThrow(/credential-bearing or uninspectable material/u);
    fs.writeFileSync(file, "Text\u0000hidden key");
    expect(assertSafe).toThrow(/credential-bearing or uninspectable material/u);
    fs.writeFileSync(file, "Text\r\n\tcontinued\n");
    expect(assertSafe).not.toThrow();

    const memory = path.join(root, "memory");
    const nested = touch(memory, "note.md");
    fs.writeFileSync(nested, Buffer.from([0xc3, 0x28]));
    expect(() =>
      assertRemovedImmutabilityRecoveryDownloadArtifactSafe(
        memory,
        "/sandbox/.openclaw/workspace/memory",
        "alpha",
      ),
    ).toThrow(/credential-bearing or uninspectable material/u);
  });

  it("rejects a recovery directory deeper than the inspection limit", () => {
    const memory = path.join(stateDir(), "memory");
    fs.mkdirSync(path.join(memory, "d/".repeat(33)), { recursive: true });

    expect(() =>
      assertRemovedImmutabilityRecoveryDownloadArtifactSafe(
        memory,
        "/sandbox/.openclaw/workspace/memory",
        "alpha",
      ),
    ).toThrow(
      /Cannot download '\/sandbox\/\.openclaw\/workspace\/memory'.*directory depth or entry limit.*Do not destroy the sandbox/u,
    );
  });

  it("allows a recovery directory whose files each fit the per-file inspection limit", () => {
    const memory = path.join(stateDir(), "memory");
    fs.mkdirSync(memory);
    const noteA = path.join(memory, "a.md");
    const noteB = path.join(memory, "b.md");
    fs.writeFileSync(noteA, "a".repeat(9 * 1024 * 1024));
    fs.writeFileSync(noteB, "b".repeat(9 * 1024 * 1024));

    expect(() =>
      assertRemovedImmutabilityRecoveryDownloadArtifactSafe(
        memory,
        "/sandbox/.openclaw/workspace/memory",
        "alpha",
      ),
    ).not.toThrow();
  });
});
