// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import type fs from "node:fs";
import { homedir } from "node:os";
import { loadState, saveState, clearState, type NemoClawState } from "./state.js";

const store = new Map<string, string>();

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => store.has(p),
    mkdirSync: vi.fn(),
    readFileSync: (p: string) => {
      const content = store.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFileSync: (p: string, data: string) => {
      store.set(p, data);
    },
  };
});

const STATE_PATH = `${homedir()}/.nemoclaw/state/nemoclaw.json`;

describe("blueprint/state", () => {
  beforeEach(() => {
    store.clear();
  });

  describe("loadState", () => {
    it("returns blank state when no file exists", () => {
      const state = loadState();
      expect(state.lastRunId).toBeNull();
      expect(state.lastAction).toBeNull();
      expect(state.blueprintVersion).toBeNull();
      expect(state.sandboxName).toBeNull();
      expect(state.migrationSnapshot).toBeNull();
      expect(state.hostBackupPath).toBeNull();
      expect(state.createdAt).toBeNull();
      expect(state.updatedAt).toBeDefined();
      // Shields defaults
      expect(state.shieldsDown).toBe(false);
      expect(state.shieldsDownAt).toBeNull();
      expect(state.shieldsDownTimeout).toBeNull();
      expect(state.shieldsDownReason).toBeNull();
      expect(state.shieldsDownPolicy).toBeNull();
      expect(state.shieldsPolicySnapshotPath).toBeNull();
    });

    it("returns parsed state when file exists", () => {
      const saved: NemoClawState = {
        lastRunId: "run-1",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        migrationSnapshot: null,
        hostBackupPath: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
        lastRebuildAt: null,
        lastRebuildBackupPath: null,
        shieldsDown: false,
        shieldsDownAt: null,
        shieldsDownTimeout: null,
        shieldsDownReason: null,
        shieldsDownPolicy: null,
        shieldsPolicySnapshotPath: null,
      };
      store.set(STATE_PATH, JSON.stringify(saved));
      expect(loadState()).toEqual(saved);
    });

    it("fills shields defaults for pre-shields state files", () => {
      // Simulate a state file written before shields fields were added
      const legacyState = {
        lastRunId: "run-1",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        migrationSnapshot: null,
        hostBackupPath: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      };
      store.set(STATE_PATH, JSON.stringify(legacyState));
      const loaded = loadState();
      // Original fields preserved
      expect(loaded.lastRunId).toBe("run-1");
      expect(loaded.lastAction).toBe("deploy");
      // Shields fields filled with defaults
      expect(loaded.shieldsDown).toBe(false);
      expect(loaded.shieldsDownAt).toBeNull();
      expect(loaded.shieldsDownTimeout).toBeNull();
      expect(loaded.shieldsDownReason).toBeNull();
      expect(loaded.shieldsDownPolicy).toBeNull();
      expect(loaded.shieldsPolicySnapshotPath).toBeNull();
    });
  });

  describe("saveState", () => {
    it("writes state and sets updatedAt", () => {
      const state = loadState();
      state.lastAction = "deploy";
      saveState(state);
      const loaded = loadState();
      expect(loaded.lastAction).toBe("deploy");
      expect(loaded.updatedAt).toBeDefined();
    });

    it("sets createdAt on first save", () => {
      const state = loadState();
      expect(state.createdAt).toBeNull();
      saveState(state);
      const loaded = loadState();
      expect(loaded.createdAt).toBeDefined();
      expect(loaded.createdAt).toBe(loaded.updatedAt);
    });

    it("preserves existing createdAt", () => {
      const state = loadState();
      state.createdAt = "2026-01-01T00:00:00.000Z";
      saveState(state);
      const loaded = loadState();
      expect(loaded.createdAt).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  describe("clearState", () => {
    it("resets state to blank when file exists", () => {
      const state = loadState();
      state.lastAction = "deploy";
      state.lastRunId = "run-1";
      saveState(state);
      clearState();
      const loaded = loadState();
      expect(loaded.lastAction).toBeNull();
      expect(loaded.lastRunId).toBeNull();
    });

    it("does nothing when no file exists", () => {
      expect(() => {
        clearState();
      }).not.toThrow();
    });
  });
});
