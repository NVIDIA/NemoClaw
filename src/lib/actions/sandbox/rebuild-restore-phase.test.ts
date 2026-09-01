// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigObject } from "../../security/credential-filter";
import * as sandboxConfig from "../../sandbox/config";
import { serializeHermesOperatorConfigSnapshot } from "./rebuild-durable-config";
import { runRebuildRestorePhase } from "./rebuild-restore-phase";
import * as snapshotRestore from "./snapshot/restore-authority";

const backupManifest = {
  agentType: "openclaw",
  backupPath: "/tmp/rebuild-backup",
} as never;

describe("rebuild filesystem restore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores through managed snapshot authority without replaying policy state", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restore = vi
      .spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority")
      .mockReturnValue({
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: ["user.md"],
        failedDirs: [],
        failedFiles: [],
      });

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      targetAgentType: "openclaw",
      targetImageIsCustom: false,
      backupManifest,
      log: vi.fn(),
    });

    expect(restore).toHaveBeenCalledWith(
      "alpha",
      backupManifest,
      { targetAgentType: "openclaw" },
      { getSandbox: expect.any(Function) },
    );
    expect(result).toEqual({ restoreSucceeded: true });
  });

  it("allows whole-state file restore only for an explicit custom image", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restore = vi
      .spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority")
      .mockReturnValue({
        success: true,
        restoredDirs: [],
        restoredFiles: [],
        failedDirs: [],
        failedFiles: [],
      });

    runRebuildRestorePhase({
      sandboxName: "alpha",
      targetAgentType: "openclaw",
      targetImageIsCustom: true,
      backupManifest,
      log: vi.fn(),
    });

    expect(restore).toHaveBeenCalledWith(
      "alpha",
      backupManifest,
      {
        targetAgentType: "openclaw",
        allowCustomImageWholeStateFileRestore: true,
      },
      { getSandbox: expect.any(Function) },
    );
  });

  it("migrates restored Hermes dashboard state into its current profile", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority").mockReturnValue({
      success: true,
      restoredDirs: ["profiles", "dashboard-home"],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    const target = {
      agentName: "hermes",
      configDir: "/sandbox/.hermes",
      configPath: "/sandbox/.hermes/config.yaml",
      configFile: "config.yaml",
      format: "yaml",
      stateLockPlanInImage: true,
    } as const;
    vi.spyOn(sandboxConfig, "resolveAgentConfig").mockReturnValue(target);
    const migrate = vi
      .spyOn(sandboxConfig, "restoreHermesDashboardConfig")
      .mockReturnValue("converged");
    const log = vi.fn();

    const result = runRebuildRestorePhase({
      sandboxName: "hermes",
      targetAgentType: "hermes",
      targetImageIsCustom: false,
      backupManifest,
      log,
    });

    expect(migrate).toHaveBeenCalledWith("hermes", target);
    expect(log).toHaveBeenCalledWith("Hermes dashboard state after restore: converged");
    expect(result).toEqual({
      restoreSucceeded: true,
      hermesOperatorConfigRestore: { restoredKeys: [], droppedKeys: [] },
    });
  });

  it("restores digest-bound Hermes operator config before dashboard reseeding", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority").mockReturnValue({
      success: true,
      restoredDirs: ["profiles"],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-10495-restore-"));
    try {
      const snapshot = {
        version: 1 as const,
        sandboxName: "hermes",
        entries: [
          { key: "model.max_tokens", value: 24576 },
          { key: "memory.provider", value: "hindsight" },
        ],
        droppedKeys: [],
      };
      const document = serializeHermesOperatorConfigSnapshot(snapshot);
      const sha256 = createHash("sha256").update(document).digest("hex");
      const file = `hermes-operator-config-handoff.${sha256}.json`;
      fs.writeFileSync(path.join(dir, file), document, { mode: 0o600 });
      const manifest = {
        agentType: "hermes",
        backupPath: dir,
        hermesOperatorConfigHandoff: { file, sha256 },
      } as never;
      const target = {
        agentName: "hermes",
        configDir: "/sandbox/.hermes",
        configPath: "/sandbox/.hermes/config.yaml",
        configFile: "config.yaml",
        format: "yaml",
        stateLockPlanInImage: true,
      } as const;
      const config: ConfigObject = {
        model: { default: "fresh" },
        memory: { provider: "" },
      };
      vi.spyOn(sandboxConfig, "resolveAgentConfig").mockReturnValue(target);
      vi.spyOn(sandboxConfig, "readSandboxConfig").mockImplementation(() => config);
      const write = vi
        .spyOn(sandboxConfig, "writeSandboxConfig")
        .mockImplementation(() => undefined);
      const reseed = vi
        .spyOn(sandboxConfig, "restoreHermesDashboardConfig")
        .mockReturnValue("converged");

      const result = runRebuildRestorePhase({
        sandboxName: "hermes",
        targetAgentType: "hermes",
        targetImageIsCustom: false,
        backupManifest: manifest,
        log: vi.fn(),
      });

      expect(write).toHaveBeenCalledOnce();
      expect(reseed.mock.invocationCallOrder[0]).toBeGreaterThan(write.mock.invocationCallOrder[0]);
      expect(result).toEqual({
        restoreSucceeded: true,
        hermesOperatorConfigRestore: {
          restoredKeys: ["memory.provider", "model.max_tokens"],
          droppedKeys: [],
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an unresolved or failed Hermes dashboard migration as incomplete", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority").mockReturnValue({
      success: true,
      restoredDirs: ["dashboard-home"],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    vi.spyOn(sandboxConfig, "resolveAgentConfig").mockReturnValue({
      agentName: "openclaw",
      configDir: "/sandbox/.openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configFile: "openclaw.json",
      format: "json",
      stateLockPlanInImage: true,
    });
    const migrate = vi.spyOn(sandboxConfig, "restoreHermesDashboardConfig");

    const result = runRebuildRestorePhase({
      sandboxName: "hermes",
      targetAgentType: "hermes",
      targetImageIsCustom: false,
      backupManifest,
      log: vi.fn(),
    });

    expect(migrate).not.toHaveBeenCalled();
    expect(result).toEqual({
      restoreSucceeded: false,
      hermesOperatorConfigRestore: { restoredKeys: [], droppedKeys: [] },
    });
  });

  it("fails closed when the Hermes config handoff digest does not match", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority").mockReturnValue({
      success: true,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: [],
      failedFiles: [],
    });
    const write = vi.spyOn(sandboxConfig, "writeSandboxConfig").mockImplementation(() => undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-10495-tampered-"));
    try {
      const sha256 = "a".repeat(64);
      const file = `hermes-operator-config-handoff.${sha256}.json`;
      fs.writeFileSync(path.join(dir, file), '{"tampered":true}\n', { mode: 0o600 });

      const result = runRebuildRestorePhase({
        sandboxName: "hermes",
        targetAgentType: "hermes",
        targetImageIsCustom: false,
        backupManifest: {
          agentType: "hermes",
          backupPath: dir,
          hermesOperatorConfigHandoff: { file, sha256 },
        } as never,
        log: vi.fn(),
      });

      expect(result).toEqual({
        restoreSucceeded: false,
        hermesOperatorConfigRestore: { restoredKeys: [], droppedKeys: [] },
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an explicit empty Hermes config report when no backup manifest exists", () => {
    const result = runRebuildRestorePhase({
      sandboxName: "hermes",
      targetAgentType: "hermes",
      targetImageIsCustom: false,
      backupManifest: null,
      log: vi.fn(),
    });

    expect(result).toEqual({
      restoreSucceeded: true,
      hermesOperatorConfigRestore: { restoredKeys: [], droppedKeys: [] },
    });
  });

  it("surfaces a filesystem restore failure without inventing policy recovery", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.fn();
    vi.spyOn(snapshotRestore, "restoreRecreatedSandboxStateWithManagedAuthority").mockReturnValue({
      success: false,
      restoredDirs: [],
      restoredFiles: [],
      failedDirs: ["extensions"],
      failedFiles: [],
      error: "could not read fresh OpenClaw plugin install registry",
    });

    const result = runRebuildRestorePhase({
      sandboxName: "alpha",
      targetAgentType: "openclaw",
      targetImageIsCustom: false,
      backupManifest,
      log,
    });

    expect(result).toEqual({ restoreSucceeded: false });
    expect(consoleError).toHaveBeenCalledWith(
      "  Restore blocked: could not read fresh OpenClaw plugin install registry",
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("error=could not read fresh OpenClaw plugin install registry"),
    );
  });
});
