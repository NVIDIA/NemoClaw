// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

let origHome;
let tmpHome;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-"));
  process.env.HOME = tmpHome;
  delete require.cache[require.resolve("../nemoclaw/dist/blueprint/state.js")];
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function loadModule() {
  return require("../nemoclaw/dist/blueprint/state.js");
}

describe("blueprint state", () => {
  it("returns blank state when no file exists", () => {
    const { loadState } = loadModule();
    const state = loadState();
    assert.equal(state.lastRunId, null);
    assert.equal(state.lastAction, null);
    assert.equal(state.sandboxName, null);
    assert.equal(typeof state.updatedAt, "string");
  });

  it("saves and loads state round-trip", () => {
    const { saveState, loadState } = loadModule();
    const state = loadState();
    state.lastRunId = "nc-20260317-abc12345";
    state.lastAction = "apply";
    state.sandboxName = "my-sandbox";
    state.blueprintVersion = "0.1.0";
    saveState(state);

    const loaded = loadState();
    assert.equal(loaded.lastRunId, "nc-20260317-abc12345");
    assert.equal(loaded.lastAction, "apply");
    assert.equal(loaded.sandboxName, "my-sandbox");
    assert.equal(loaded.blueprintVersion, "0.1.0");
  });

  it("sets updatedAt on save", () => {
    const { saveState, loadState } = loadModule();
    const state = loadState();
    const before = new Date().toISOString();
    saveState(state);
    const loaded = loadState();
    assert.ok(loaded.updatedAt >= before);
  });

  it("sets createdAt on first save only", () => {
    const { saveState, loadState } = loadModule();
    const state = loadState();
    saveState(state);
    const first = loadState();
    const createdAt = first.createdAt;

    // Second save should not change createdAt
    first.lastAction = "plan";
    saveState(first);
    const second = loadState();
    assert.equal(second.createdAt, createdAt);
  });

  it("creates .nemoclaw/state directory", () => {
    const { loadState } = loadModule();
    loadState();
    assert.ok(fs.existsSync(path.join(tmpHome, ".nemoclaw", "state")));
  });

  it("clears state back to blank", () => {
    const { saveState, clearState, loadState } = loadModule();
    const state = loadState();
    state.lastRunId = "nc-test";
    state.lastAction = "apply";
    saveState(state);

    clearState();
    const cleared = loadState();
    assert.equal(cleared.lastRunId, null);
    assert.equal(cleared.lastAction, null);
  });
});
