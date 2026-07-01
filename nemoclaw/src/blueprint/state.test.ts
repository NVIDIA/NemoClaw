// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";
import { homedir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearState, loadState, type NemoClawState, saveState } from "./state.js";

const store = new Map<string, string>();
const writes: Array<{ path: string; options: unknown }> = [];
const renames: Array<{ from: string; to: string }> = [];

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
    writeFileSync: (p: string, data: string, options?: unknown) => {
      writes.push({ path: p, options });
      store.set(p, data);
    },
    renameSync: (from: string, to: string) => {
      renames.push({ from, to });
      const content = store.get(from);
      if (content === undefined) throw new Error(`ENOENT: ${from}`);
      store.set(to, content);
      store.delete(from);
    },
  };
});

const STATE_PATH = `${homedir()}/.nemoclaw/state/nemoclaw.json`;

describe("blueprint/state", () => {
  beforeEach(() => {
    store.clear();
    writes.length = 0;
    renames.length = 0;
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
        lastRebuildAt: null,
        lastRebuildBackupPath: null,
      };
      store.set(STATE_PATH, JSON.stringify(saved));
      expect(loadState()).toEqual(saved);
    });

    it("falls back to blank defaults when the persisted JSON root is not an object", () => {
      store.set(STATE_PATH, JSON.stringify(["not", "an", "object"]));
      const loaded = loadState();
      expect(loaded.lastRunId).toBeNull();
    });

    it("ignores malformed persisted field types while preserving valid partial state", () => {
      store.set(
        STATE_PATH,
        JSON.stringify({
          lastRunId: "run-1",
          sandboxName: "sb",
          updatedAt: {},
        }),
      );
      const loaded = loadState();
      expect(loaded.lastRunId).toBe("run-1");
      expect(loaded.sandboxName).toBe("sb");
      expect(typeof loaded.updatedAt).toBe("string");
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

    it("creates blank state when no file exists", () => {
      expect(() => {
        clearState();
      }).not.toThrow();
      expect(store.has(STATE_PATH)).toBe(true);
      const write = writes.at(-1);
      const rename = renames.at(-1);
      expect(write?.path.startsWith(`${STATE_PATH}.${process.pid}.`)).toBe(true);
      expect(write?.path.endsWith(".tmp")).toBe(true);
      expect(write?.options).toMatchObject({ mode: 0o600 });
      expect(rename).toEqual({ from: write?.path, to: STATE_PATH });
      expect(store.has(write?.path || "")).toBe(false);
      expect(JSON.parse(store.get(STATE_PATH) || "{}").lastAction).toBeNull();
    });
  });
});
