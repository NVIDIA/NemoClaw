// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

// Use a temp dir so tests don't touch real ~/.nemoclaw.
// HOME must be set before loading registry (it reads HOME at require time),
// so we use createRequire instead of a static import.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-test-"));
process.env.HOME = tmpDir;

const require = createRequire(import.meta.url);
const registry = require("../bin/lib/registry");

const regFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");

beforeEach(() => {
  if (fs.existsSync(regFile)) fs.unlinkSync(regFile);
});

describe("registry", () => {
  it("starts empty", () => {
    const { sandboxes, defaultSandbox } = registry.listSandboxes();
    expect(sandboxes.length).toBe(0);
    expect(defaultSandbox).toBe(null);
  });

  it("registers a sandbox and sets it as default", () => {
    registry.registerSandbox({ name: "alpha", model: "test-model", provider: "nvidia-nim" });
    const sb = registry.getSandbox("alpha");
    expect(sb.name).toBe("alpha");
    expect(sb.model).toBe("test-model");
    expect(registry.getDefault()).toBe("alpha");
  });

  it("first registered becomes default", () => {
    registry.registerSandbox({ name: "first" });
    registry.registerSandbox({ name: "second" });
    expect(registry.getDefault()).toBe("first");
  });

  it("setDefault changes the default", () => {
    registry.registerSandbox({ name: "a" });
    registry.registerSandbox({ name: "b" });
    registry.setDefault("b");
    expect(registry.getDefault()).toBe("b");
  });

  it("setDefault returns false for nonexistent sandbox", () => {
    expect(registry.setDefault("nope")).toBe(false);
  });

  it("updateSandbox modifies fields", () => {
    registry.registerSandbox({ name: "up" });
    registry.updateSandbox("up", { policies: ["pypi", "npm"], model: "new-model" });
    const sb = registry.getSandbox("up");
    expect(sb.policies).toEqual(["pypi", "npm"]);
    expect(sb.model).toBe("new-model");
  });

  it("updateSandbox returns false for nonexistent sandbox", () => {
    expect(registry.updateSandbox("nope", {})).toBe(false);
  });

  it("updateSandbox rejects name changes", () => {
    registry.registerSandbox({ name: "orig" });
    expect(registry.updateSandbox("orig", { name: "renamed" })).toBe(false);
    // Original entry unchanged
    expect(registry.getSandbox("orig").name).toBe("orig");
    // No ghost entry under new name
    expect(registry.getSandbox("renamed")).toBe(null);
  });

  it("removeSandbox deletes and shifts default", () => {
    registry.registerSandbox({ name: "x" });
    registry.registerSandbox({ name: "y" });
    registry.setDefault("x");
    registry.removeSandbox("x");
    expect(registry.getSandbox("x")).toBe(null);
    expect(registry.getDefault()).toBe("y");
  });

  it("removeSandbox last sandbox sets default to null", () => {
    registry.registerSandbox({ name: "only" });
    registry.removeSandbox("only");
    expect(registry.getDefault()).toBe(null);
    expect(registry.listSandboxes().sandboxes.length).toBe(0);
  });

  it("removeSandbox returns false for nonexistent", () => {
    expect(registry.removeSandbox("nope")).toBe(false);
  });

  it("getSandbox returns null for nonexistent", () => {
    expect(registry.getSandbox("nope")).toBe(null);
  });

  it("persists to disk and survives reload", () => {
    registry.registerSandbox({ name: "persist", model: "m1" });
    // Read file directly
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes.persist.model).toBe("m1");
    expect(data.defaultSandbox).toBe("persist");
  });

  it("handles corrupt registry file gracefully", () => {
    fs.mkdirSync(path.dirname(regFile), { recursive: true });
    fs.writeFileSync(regFile, "NOT JSON");
    // Should not throw, returns empty
    const { sandboxes } = registry.listSandboxes();
    expect(sandboxes.length).toBe(0);
  });
});

describe("atomic writes", () => {
  const regDir = path.dirname(regFile);

  beforeEach(() => {
    if (fs.existsSync(regFile)) fs.unlinkSync(regFile);
    // Clean up any leftover tmp files
    if (fs.existsSync(regDir)) {
      for (const f of fs.readdirSync(regDir)) {
        if (f.startsWith("sandboxes.json.tmp.")) {
          fs.unlinkSync(path.join(regDir, f));
        }
      }
    }
  });

  it("save() writes via temp file + rename (no partial writes on disk)", () => {
    registry.registerSandbox({ name: "atomic-test" });
    // File must exist and be valid JSON after save
    const raw = fs.readFileSync(regFile, "utf-8");
    const data = JSON.parse(raw);
    expect(data.sandboxes["atomic-test"].name).toBe("atomic-test");
    // No leftover .tmp files
    const tmpFiles = fs.readdirSync(regDir).filter((f) => f.startsWith("sandboxes.json.tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("save() cleans up temp file when rename fails", () => {
    fs.mkdirSync(regDir, { recursive: true });
    fs.writeFileSync(regFile, '{"sandboxes":{},"defaultSandbox":null}', { mode: 0o600 });

    // Stub renameSync so writeFileSync succeeds (temp file is created)
    // but the rename step throws — exercising the cleanup branch.
    const original = fs.renameSync;
    fs.renameSync = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    try {
      expect(() => registry.save({ sandboxes: {}, defaultSandbox: null })).toThrow(
        /Cannot write config file|EACCES/,
      );
    } finally {
      fs.renameSync = original;
    }
    // The save() catch block should have removed the temp file
    const tmpFiles = fs.readdirSync(regDir).filter((f) => f.startsWith("sandboxes.json.tmp."));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe("advisory file locking", () => {
  const lockDir = regFile + ".lock";
  const ownerFile = path.join(lockDir, "owner");

  beforeEach(() => {
    if (fs.existsSync(regFile)) fs.unlinkSync(regFile);
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it("acquireLock creates lock directory with owner file and releaseLock removes both", () => {
    registry.acquireLock();
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.existsSync(ownerFile)).toBe(true);
    expect(fs.readFileSync(ownerFile, "utf-8").trim()).toBe(String(process.pid));
    registry.releaseLock();
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("withLock releases lock even when callback throws", () => {
    expect(() => {
      registry.withLock(() => {
        expect(fs.existsSync(lockDir)).toBe(true);
        throw new Error("intentional");
      });
    }).toThrow("intentional");
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("acquireLock cleans up lock dir when owner file write fails", () => {
    const origWrite = fs.writeFileSync;
    let firstCall = true;
    fs.writeFileSync = (...args) => {
      // Fail only the first writeFileSync targeting the owner tmp file
      if (String(args[0]).includes("owner.tmp.") && firstCall) {
        firstCall = false;
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
      return origWrite.apply(fs, args);
    };
    try {
      // First attempt should throw, but no stale lock dir left behind
      expect(() => registry.acquireLock()).toThrow("ENOSPC");
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      fs.writeFileSync = origWrite;
    }
  });

  it("acquireLock removes stale lock owned by dead process", () => {
    // Create a lock with a PID that doesn't exist (99999999)
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(ownerFile, "99999999", { mode: 0o600 });

    // Should succeed by detecting the dead owner and removing the stale lock
    registry.acquireLock();
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.readFileSync(ownerFile, "utf-8").trim()).toBe(String(process.pid));
    registry.releaseLock();
  });

  it("mutating operations acquire and release the lock", () => {
    const mkdirCalls = [];
    const rmCalls = [];
    const origMkdir = fs.mkdirSync;
    const origRm = fs.rmSync;
    fs.mkdirSync = (...args) => {
      if (args[0] === lockDir) mkdirCalls.push(args[0]);
      return origMkdir.apply(fs, args);
    };
    fs.rmSync = (...args) => {
      if (args[0] === lockDir) rmCalls.push(args[0]);
      return origRm.apply(fs, args);
    };
    try {
      registry.registerSandbox({ name: "lock-test" });
    } finally {
      fs.mkdirSync = origMkdir;
      fs.rmSync = origRm;
    }
    expect(mkdirCalls.length).toBeGreaterThanOrEqual(1);
    expect(rmCalls.length).toBeGreaterThanOrEqual(1);
    expect(registry.getSandbox("lock-test").name).toBe("lock-test");
  });

  it("concurrent writers do not corrupt the registry", () => {
    const { spawnSync } = require("child_process");
    const registryPath = path.resolve(
      path.join(import.meta.dirname, "..", "bin", "lib", "registry.js"),
    );
    const homeDir = path.dirname(path.dirname(regFile));
    // Script that spawns 4 workers in parallel, each writing 5 sandboxes
    const orchestrator = `
      const { spawn } = require("child_process");
      const workerScript = \`
        process.env.HOME = ${JSON.stringify(homeDir)};
        const reg = require(${JSON.stringify(registryPath)});
        const id = process.argv[1];
        for (let i = 0; i < 5; i++) {
          reg.registerSandbox({ name: id + "-" + i, model: "m" });
        }
      \`;
      const workers = [];
      for (let w = 0; w < 4; w++) {
        workers.push(spawn(process.execPath, ["-e", workerScript, "w" + w]));
      }
      let exitCount = 0;
      let allOk = true;
      for (const child of workers) {
        child.on("exit", (code) => {
          if (code !== 0) allOk = false;
          exitCount++;
          if (exitCount === workers.length) {
            process.exit(allOk ? 0 : 1);
          }
        });
      }
    `;
    const result = spawnSync(process.execPath, ["-e", orchestrator], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    // All 20 sandboxes (4 workers × 5 each) must be present
    const { sandboxes } = registry.listSandboxes();
    expect(sandboxes.length).toBe(20);
  });

  it("clearAll removes all sandboxes and resets default", () => {
    registry.registerSandbox({ name: "alpha" });
    registry.registerSandbox({ name: "beta" });
    registry.setDefault("beta");

    registry.clearAll();

    const { sandboxes, defaultSandbox } = registry.listSandboxes();
    expect(sandboxes).toHaveLength(0);
    expect(defaultSandbox).toBe(null);
  });

  it("clearAll persists empty state to disk", () => {
    registry.registerSandbox({ name: "persist-me" });

    registry.clearAll();

    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes).toEqual({});
    expect(data.defaultSandbox).toBe(null);
  });

  it("clearAll is safe to call on empty registry", () => {
    registry.clearAll();

    const { sandboxes, defaultSandbox } = registry.listSandboxes();
    expect(sandboxes).toHaveLength(0);
    expect(defaultSandbox).toBe(null);
  });
});
