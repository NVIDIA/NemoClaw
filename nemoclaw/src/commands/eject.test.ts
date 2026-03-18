// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NemoClawState } from "../blueprint/state.js";
import type { PluginLogger, NemoClawConfig } from "../index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("../blueprint/state.js", () => ({
  loadState: vi.fn(),
  clearState: vi.fn(),
}));

vi.mock("../blueprint/exec.js", () => ({
  execBlueprint: vi.fn(),
}));

vi.mock("./migration-state.js", () => ({
  restoreSnapshotToHost: vi.fn(),
}));

const { existsSync } = await import("node:fs");
const { loadState, clearState } = await import("../blueprint/state.js");
const { execBlueprint } = await import("../blueprint/exec.js");
const { restoreSnapshotToHost } = await import("./migration-state.js");
const { cliEject } = await import("./eject.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blankState(): NemoClawState {
  return {
    lastRunId: null,
    lastAction: null,
    blueprintVersion: null,
    sandboxName: null,
    migrationSnapshot: null,
    hostBackupPath: null,
    createdAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function deployedState(): NemoClawState {
  return {
    lastRunId: "run-a1b2c3d4",
    lastAction: "migrate",
    blueprintVersion: "0.1.0",
    sandboxName: "openclaw",
    migrationSnapshot: "/root/.nemoclaw/snapshots/2026-03-15",
    hostBackupPath: "/root/.nemoclaw/backups/host-backup",
    createdAt: "2026-03-15T10:30:00.000Z",
    updatedAt: "2026-03-15T10:32:45.000Z",
  };
}

const defaultConfig: NemoClawConfig = {
  blueprintVersion: "latest",
  blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
  sandboxName: "openclaw",
  inferenceProvider: "nvidia",
};

function captureLogger(): { lines: string[]; logger: PluginLogger } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (msg: string) => lines.push(msg),
      warn: (msg: string) => lines.push(`WARN: ${msg}`),
      error: (msg: string) => lines.push(`ERROR: ${msg}`),
      debug: (_msg: string) => {},
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(loadState).mockReturnValue(blankState());
});

describe("cliEject", () => {
  // =========================================================================
  // Guard: no deployment
  // =========================================================================
  describe("no deployment found", () => {
    it("errors when state has no lastAction", async () => {
      const { lines, logger } = captureLogger();

      await cliEject({ confirm: true, logger, pluginConfig: defaultConfig });

      expect(lines.join("\n")).toContain("No NemoClaw deployment found");
      expect(clearState).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Guard: no snapshot
  // =========================================================================
  describe("no migration snapshot", () => {
    it("errors when neither snapshot nor backup path exists in state", async () => {
      vi.mocked(loadState).mockReturnValue({
        ...deployedState(),
        migrationSnapshot: null,
        hostBackupPath: null,
      });

      const { lines, logger } = captureLogger();
      await cliEject({ confirm: true, logger, pluginConfig: defaultConfig });

      expect(lines.join("\n")).toContain("No migration snapshot found");
      expect(lines.join("\n")).toContain("--skip-backup");
    });
  });

  // =========================================================================
  // Guard: snapshot directory missing on disk
  // =========================================================================
  describe("snapshot directory missing on disk", () => {
    it("errors when snapshot openclaw dir does not exist", async () => {
      vi.mocked(loadState).mockReturnValue(deployedState());
      vi.mocked(existsSync).mockReturnValue(false);

      const { lines, logger } = captureLogger();
      await cliEject({ confirm: true, logger, pluginConfig: defaultConfig });

      expect(lines.join("\n")).toContain("Snapshot directory not found");
    });
  });

  // =========================================================================
  // Dry run (--confirm not passed)
  // =========================================================================
  describe("dry run without --confirm", () => {
    it("shows planned steps without executing", async () => {
      vi.mocked(loadState).mockReturnValue(deployedState());
      vi.mocked(existsSync).mockReturnValue(true);

      const { lines, logger } = captureLogger();
      await cliEject({ confirm: false, logger, pluginConfig: defaultConfig });

      const output = lines.join("\n");
      expect(output).toContain("Eject will:");
      expect(output).toContain("Stop the OpenShell sandbox");
      expect(output).toContain("Rollback blueprint state");
      expect(output).toContain("Restore ~/.openclaw from snapshot");
      expect(output).toContain("Run with --confirm to proceed");
      expect(execBlueprint).not.toHaveBeenCalled();
      expect(restoreSnapshotToHost).not.toHaveBeenCalled();
      expect(clearState).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Confirmed eject — happy path
  // =========================================================================
  describe("confirmed eject — success", () => {
    beforeEach(() => {
      vi.mocked(loadState).mockReturnValue(deployedState());
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execBlueprint).mockResolvedValue({ success: true, output: "", runId: "run-a1b2c3d4" });
      vi.mocked(restoreSnapshotToHost).mockReturnValue(true);
    });

    it("runs blueprint rollback, restores host, and clears state", async () => {
      const { lines, logger } = captureLogger();
      await cliEject({ confirm: true, logger, pluginConfig: defaultConfig });

      expect(execBlueprint).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "rollback",
          profile: "default",
          runId: "run-a1b2c3d4",
        }),
        logger,
      );
      expect(restoreSnapshotToHost).toHaveBeenCalledWith(
        "/root/.nemoclaw/snapshots/2026-03-15",
        logger,
      );
      expect(clearState).toHaveBeenCalled();
      expect(lines.join("\n")).toContain("Eject complete");
    });

    it("uses custom runId when provided", async () => {
      const { logger } = captureLogger();
      await cliEject({ confirm: true, runId: "custom-run", logger, pluginConfig: defaultConfig });

      expect(execBlueprint).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "custom-run" }),
        logger,
      );
    });
  });

  // =========================================================================
  // Confirmed eject — blueprint rollback fails
  // =========================================================================
  describe("confirmed eject — blueprint rollback fails", () => {
    it("warns but continues with host restoration", async () => {
      vi.mocked(loadState).mockReturnValue(deployedState());
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execBlueprint).mockResolvedValue({ success: false, output: "rollback error", runId: "run-a1b2c3d4" });
      vi.mocked(restoreSnapshotToHost).mockReturnValue(true);

      const { lines, logger } = captureLogger();
      await cliEject({ confirm: true, logger, pluginConfig: defaultConfig });

      const output = lines.join("\n");
      expect(output).toContain("WARN:");
      expect(output).toContain("rollback error");
      expect(output).toContain("Continuing with host restoration");
      expect(restoreSnapshotToHost).toHaveBeenCalled();
      expect(clearState).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Confirmed eject — host restoration fails
  // =========================================================================
  describe("confirmed eject — host restoration fails", () => {
    it("shows manual restore path and does not clear state", async () => {
      vi.mocked(loadState).mockReturnValue(deployedState());
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execBlueprint).mockResolvedValue({ success: true, output: "", runId: "run-a1b2c3d4" });
      vi.mocked(restoreSnapshotToHost).mockReturnValue(false);

      const { lines, logger } = captureLogger();
      await cliEject({ confirm: true, logger, pluginConfig: defaultConfig });

      expect(lines.join("\n")).toContain("Manual restore available at");
      expect(clearState).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge: no blueprint path on disk — skips rollback
  // =========================================================================
  describe("skips blueprint rollback when blueprint path missing", () => {
    it("proceeds directly to host restoration", async () => {
      vi.mocked(loadState).mockReturnValue(deployedState());
      // existsSync returns true for snapshot dir, false for blueprint path
      vi.mocked(existsSync).mockImplementation((p: string | URL | Buffer) => {
        const path = String(p);
        return path.includes("snapshots") || path.includes("openclaw");
      });
      vi.mocked(restoreSnapshotToHost).mockReturnValue(true);

      const { logger } = captureLogger();
      await cliEject({ confirm: true, logger, pluginConfig: defaultConfig });

      expect(execBlueprint).not.toHaveBeenCalled();
      expect(restoreSnapshotToHost).toHaveBeenCalled();
      expect(clearState).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge: falls back to hostBackupPath
  // =========================================================================
  describe("falls back to hostBackupPath when migrationSnapshot is null", () => {
    it("uses hostBackupPath for restore", async () => {
      vi.mocked(loadState).mockReturnValue({
        ...deployedState(),
        migrationSnapshot: null,
      });
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(execBlueprint).mockResolvedValue({ success: true, output: "", runId: "run-a1b2c3d4" });
      vi.mocked(restoreSnapshotToHost).mockReturnValue(true);

      const { logger } = captureLogger();
      await cliEject({ confirm: true, logger, pluginConfig: defaultConfig });

      expect(restoreSnapshotToHost).toHaveBeenCalledWith(
        "/root/.nemoclaw/backups/host-backup",
        logger,
      );
    });
  });
});
