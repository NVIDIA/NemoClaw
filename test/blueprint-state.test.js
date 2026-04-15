// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let origHome;
let tmpHome;
let moduleVersion = 0;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function loadModule() {
  moduleVersion += 1;
  const moduleUrl = new URL("../nemoclaw/dist/blueprint/state.js", import.meta.url);
  return import(`${moduleUrl.href}?v=${moduleVersion}`);
}

describe("blueprint state", () => {
  it("returns blank state when no file exists", async () => {
    const { loadState } = await loadModule();
    const state = loadState();
    expect(state.lastRunId).toBe(null);
    expect(state.lastAction).toBe(null);
    expect(state.sandboxName).toBe(null);
    expect(typeof state.updatedAt).toBe("string");
  });

  it("saves and loads state round-trip", async () => {
    const { saveState, loadState } = await loadModule();
    const state = loadState();
    state.lastRunId = "nc-20260317-abc12345";
    state.lastAction = "apply";
    state.sandboxName = "my-sandbox";
    state.blueprintVersion = "0.1.0";
    saveState(state);

    const loaded = loadState();
    expect(loaded.lastRunId).toBe("nc-20260317-abc12345");
    expect(loaded.lastAction).toBe("apply");
    expect(loaded.sandboxName).toBe("my-sandbox");
    expect(loaded.blueprintVersion).toBe("0.1.0");
  });

  it("sets updatedAt on save", async () => {
    const { saveState, loadState } = await loadModule();
    const state = loadState();
    const before = new Date().toISOString();
    saveState(state);
    const loaded = loadState();
    expect(loaded.updatedAt >= before).toBe(true);
  });

  it("sets createdAt on first save only", async () => {
    const { saveState, loadState } = await loadModule();
    const state = loadState();
    saveState(state);
    const first = loadState();
    const createdAt = first.createdAt;

    // Second save should not change createdAt
    first.lastAction = "plan";
    saveState(first);
    const second = loadState();
    expect(second.createdAt).toBe(createdAt);
    expect(createdAt).toBeTruthy();
  });

  it("creates .nemoclaw/state directory", async () => {
    const { loadState } = await loadModule();
    loadState();
    expect(fs.existsSync(path.join(tmpHome, ".nemoclaw", "state"))).toBe(true);
  });

  it("clears state back to blank", async () => {
    const { saveState, clearState, loadState } = await loadModule();
    const state = loadState();
    state.lastRunId = "nc-test";
    state.lastAction = "apply";
    saveState(state);

    clearState();
    const cleared = loadState();
    expect(cleared.lastRunId).toBe(null);
    expect(cleared.lastAction).toBe(null);
  });
});
