// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadState, saveState, clearState, type NemoClawState } from "./state.js";

const store = new Map<string, string>();

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal();
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

const STATE_PATH = `${process.env.HOME ?? "/tmp"}/.nemoclaw/state/nemoclaw.json`;

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
      };
      store.set(STATE_PATH, JSON.stringify(saved));
      expect(loadState()).toEqual(saved);
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
