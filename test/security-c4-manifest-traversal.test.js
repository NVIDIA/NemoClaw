// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Security regression test: C-4 — Snapshot manifest path traversal.
//
// restoreSnapshotToHost() reads manifest.stateDir and manifest.configPath
// from snapshot.json and uses them as filesystem write targets. Without
// validation, a tampered manifest can cause writes outside ~/.nemoclaw/.
//
// The fix validates both fields are within manifest.homeDir before any write.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════
// Helpers — simulate restoreSnapshotToHost's vulnerable vs fixed logic
// ═══════════════════════════════════════════════════════════════════

/**
 * normalizeHostPath — mirrors migration-state.ts:115-118
 * On Windows, lowercases the resolved path for case-insensitive comparison.
 */
function normalizeHostPath(p) {
  const resolved = path.resolve(p);
  if (process.platform === "win32") {
    return resolved.toLowerCase();
  }
  return resolved;
}

/**
 * isWithinRoot — same logic as migration-state.ts:120-125
 */
function isWithinRoot(candidatePath, rootPath) {
  const candidate = normalizeHostPath(candidatePath);
  const root = normalizeHostPath(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * copyDirectory — minimal recursive copy matching migration-state.ts:476
 */
function copyDirectory(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * Build a minimal snapshot directory with a tampered manifest.
 */
function buildSnapshotDir(parentDir, manifest) {
  const snapshotDir = path.join(parentDir, "snapshot");
  fs.mkdirSync(path.join(snapshotDir, "openclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(snapshotDir, "openclaw", "sentinel.txt"),
    "attacker-controlled-content",
  );
  fs.mkdirSync(path.join(snapshotDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(snapshotDir, "config", "openclaw.json"),
    JSON.stringify({ model: "attacker-model" }),
  );
  fs.writeFileSync(
    path.join(snapshotDir, "snapshot.json"),
    JSON.stringify(manifest, null, 2),
  );
  return snapshotDir;
}

/**
 * Simulate restoreSnapshotToHost WITHOUT the fix (vulnerable).
 * Returns { result, errors, written }.
 */
function restoreVulnerable(snapshotDir) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(snapshotDir, "snapshot.json"), "utf-8"),
  );
  const snapshotStateDir = path.join(snapshotDir, "openclaw");
  const errors = [];
  let written = false;

  try {
    // No validation — directly writes to manifest.stateDir
    fs.mkdirSync(path.dirname(manifest.stateDir), { recursive: true });
    copyDirectory(snapshotStateDir, manifest.stateDir);
    written = true;

    if (manifest.hasExternalConfig && manifest.configPath) {
      const configSrc = path.join(snapshotDir, "config", "openclaw.json");
      fs.mkdirSync(path.dirname(manifest.configPath), { recursive: true });
      fs.copyFileSync(configSrc, manifest.configPath);
    }
    return { result: true, errors, written };
  } catch (err) {
    errors.push(err.message);
    return { result: false, errors, written };
  }
}

/**
 * Simulate restoreSnapshotToHost WITH the fix (validates paths).
 * Uses a trusted root instead of manifest.homeDir.
 * Returns { result, errors, written }.
 * @param {string} snapshotDir
 * @param {string} [trustedRoot] - trusted host root (defaults to os.homedir())
 */
function restoreFixed(snapshotDir, trustedRoot) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(snapshotDir, "snapshot.json"), "utf-8"),
  );
  const snapshotStateDir = path.join(snapshotDir, "openclaw");
  const errors = [];
  let written = false;
  const root = trustedRoot || os.homedir();

  // FIX: validate manifest.homeDir is within trusted root
  if (typeof manifest.homeDir !== "string" || !isWithinRoot(manifest.homeDir, root)) {
    errors.push(
      `Snapshot manifest homeDir is outside the trusted host root. ` +
        `homeDir=${String(manifest.homeDir)}, trustedRoot=${root}`,
    );
    return { result: false, errors, written };
  }

  // FIX: validate stateDir type and containment
  if (typeof manifest.stateDir !== "string") {
    errors.push(`Snapshot manifest stateDir is not a string.`);
    return { result: false, errors, written };
  }

  if (!isWithinRoot(manifest.stateDir, root)) {
    errors.push(
      `Snapshot manifest stateDir is outside the trusted host root. ` +
        `stateDir=${manifest.stateDir}, trustedRoot=${root}`,
    );
    return { result: false, errors, written };
  }

  if (manifest.hasExternalConfig) {
    if (typeof manifest.configPath !== "string" || !manifest.configPath.trim()) {
      errors.push(
        `Snapshot manifest has hasExternalConfig=true but configPath is missing or empty.`,
      );
      return { result: false, errors, written };
    }

    if (!isWithinRoot(manifest.configPath, root)) {
      errors.push(
        `Snapshot manifest configPath is outside the trusted host root. ` +
          `configPath=${manifest.configPath}, trustedRoot=${root}`,
      );
      return { result: false, errors, written };
    }
  }

  try {
    fs.mkdirSync(path.dirname(manifest.stateDir), { recursive: true });
    copyDirectory(snapshotStateDir, manifest.stateDir);
    written = true;

    if (manifest.hasExternalConfig && manifest.configPath) {
      const configSrc = path.join(snapshotDir, "config", "openclaw.json");
      fs.mkdirSync(path.dirname(manifest.configPath), { recursive: true });
      fs.copyFileSync(configSrc, manifest.configPath);
    }
    return { result: true, errors, written };
  } catch (err) {
    errors.push(err.message);
    return { result: false, errors, written };
  }
}

// ═══════════════════════════════════════════════════════════════════
// 1. PoC — vulnerable code writes to traversal target
// ═══════════════════════════════════════════════════════════════════
describe("C-4 PoC: vulnerable restoreSnapshotToHost allows path traversal", () => {
  it("tampered stateDir outside homeDir — vulnerable code writes the file", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-c4-poc-"));
    try {
      const homeDir = path.join(workDir, "home", "victim");
      const traversalTarget = path.join(workDir, "evil-payload");
      fs.mkdirSync(homeDir, { recursive: true });

      const snapshotDir = buildSnapshotDir(workDir, {
        version: 2,
        createdAt: "2026-03-22T00:00:00.000Z",
        homeDir,
        stateDir: traversalTarget, // TAMPERED: outside homeDir
        configPath: null,
        hasExternalConfig: false,
        externalRoots: [],
        warnings: [],
      });

      const { result, written } = restoreVulnerable(snapshotDir);

      // Vulnerable code writes to the traversal target
      expect(result).toBeTruthy();
      expect(written).toBeTruthy();
      expect(fs.existsSync(path.join(traversalTarget, "sentinel.txt"))).toBeTruthy();
      expect(fs.readFileSync(path.join(traversalTarget, "sentinel.txt"), "utf-8")).toBe("attacker-controlled-content");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("tampered configPath outside homeDir — vulnerable code writes the file", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-c4-cfg-"));
    try {
      const homeDir = path.join(workDir, "home", "victim");
      const legitimateStateDir = path.join(homeDir, ".openclaw");
      const evilConfigPath = path.join(workDir, "evil-config.json");
      fs.mkdirSync(homeDir, { recursive: true });

      const snapshotDir = buildSnapshotDir(workDir, {
        version: 2,
        createdAt: "2026-03-22T00:00:00.000Z",
        homeDir,
        stateDir: legitimateStateDir,
        configPath: evilConfigPath, // TAMPERED: outside homeDir
        hasExternalConfig: true,
        externalRoots: [],
        warnings: [],
      });

      const { result } = restoreVulnerable(snapshotDir);

      expect(result).toBeTruthy();
      expect(fs.existsSync(evilConfigPath)).toBeTruthy();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Fix verification — fixed code rejects traversal
// ═══════════════════════════════════════════════════════════════════
describe("C-4 fix: restoreSnapshotToHost rejects path traversal", () => {
  it("tampered stateDir outside homeDir is rejected", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-c4-fix-"));
    try {
      const homeDir = path.join(workDir, "home", "victim");
      const traversalTarget = path.join(workDir, "evil-payload");
      fs.mkdirSync(homeDir, { recursive: true });

      const snapshotDir = buildSnapshotDir(workDir, {
        version: 2,
        createdAt: "2026-03-22T00:00:00.000Z",
        homeDir,
        stateDir: traversalTarget,
        configPath: null,
        hasExternalConfig: false,
        externalRoots: [],
        warnings: [],
      });

      // Pass homeDir as trustedRoot to simulate resolveHostHome()
      const { result, errors, written } = restoreFixed(snapshotDir, homeDir);

      expect(result).toBe(false);
      expect(written).toBe(false);
      expect(!fs.existsSync(traversalTarget)).toBeTruthy();
      expect(errors[0].includes("outside the trusted host root")).toBeTruthy();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("tampered configPath outside homeDir is rejected", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-c4-fcfg-"));
    try {
      const homeDir = path.join(workDir, "home", "victim");
      const legitimateStateDir = path.join(homeDir, ".openclaw");
      const evilConfigPath = path.join(workDir, "evil-config.json");
      fs.mkdirSync(homeDir, { recursive: true });

      const snapshotDir = buildSnapshotDir(workDir, {
        version: 2,
        createdAt: "2026-03-22T00:00:00.000Z",
        homeDir,
        stateDir: legitimateStateDir,
        configPath: evilConfigPath,
        hasExternalConfig: true,
        externalRoots: [],
        warnings: [],
      });

      const { result, errors } = restoreFixed(snapshotDir, homeDir);

      expect(result).toBe(false);
      expect(!fs.existsSync(evilConfigPath)).toBeTruthy();
      expect(errors[0].includes("outside the trusted host root")).toBeTruthy();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("sibling path (not a child of homeDir) is also rejected", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-c4-sib-"));
    try {
      const homeDir = path.join(workDir, "home");
      const siblingDir = path.join(workDir, "not-home");
      fs.mkdirSync(homeDir, { recursive: true });

      const snapshotDir = buildSnapshotDir(workDir, {
        version: 2,
        createdAt: "2026-03-22T00:00:00.000Z",
        homeDir,
        stateDir: siblingDir,
        configPath: null,
        hasExternalConfig: false,
        externalRoots: [],
        warnings: [],
      });

      const { result } = restoreFixed(snapshotDir, homeDir);
      expect(result).toBe(false);
      expect(!fs.existsSync(siblingDir)).toBeTruthy();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("tampered homeDir set to / is rejected based on trusted host root", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-c4-root-"));
    try {
      const trustedRoot = path.join(workDir, "home", "victim");
      fs.mkdirSync(trustedRoot, { recursive: true });

      const snapshotDir = buildSnapshotDir(workDir, {
        version: 2,
        createdAt: "2026-03-22T00:00:00.000Z",
        homeDir: "/", // TAMPERED: set to filesystem root
        stateDir: "/tmp/evil",
        configPath: null,
        hasExternalConfig: false,
        externalRoots: [],
        warnings: [],
      });

      const { result, errors, written } = restoreFixed(snapshotDir, trustedRoot);

      expect(result).toBe(false);
      expect(written).toBe(false);
      expect(errors[0].includes("homeDir is outside the trusted host root")).toBeTruthy();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("legitimate stateDir within homeDir succeeds", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-c4-ok-"));
    try {
      const homeDir = path.join(workDir, "home", "victim");
      const legitimateStateDir = path.join(homeDir, ".openclaw");
      fs.mkdirSync(homeDir, { recursive: true });

      const snapshotDir = buildSnapshotDir(workDir, {
        version: 2,
        createdAt: "2026-03-22T00:00:00.000Z",
        homeDir,
        stateDir: legitimateStateDir,
        configPath: null,
        hasExternalConfig: false,
        externalRoots: [],
        warnings: [],
      });

      // trustedRoot = homeDir (simulates resolveHostHome() returning this dir)
      const { result, errors, written } = restoreFixed(snapshotDir, homeDir);

      expect(result).toBe(true);
      expect(errors.length).toBe(0);
      expect(written).toBeTruthy();
      expect(fs.existsSync(path.join(legitimateStateDir, "sentinel.txt"))).toBeTruthy();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("legitimate configPath within homeDir succeeds", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-c4-cfgok-"));
    try {
      const homeDir = path.join(workDir, "home", "victim");
      const legitimateStateDir = path.join(homeDir, ".openclaw");
      const legitimateConfigPath = path.join(homeDir, ".config", "openclaw.json");
      fs.mkdirSync(homeDir, { recursive: true });

      const snapshotDir = buildSnapshotDir(workDir, {
        version: 2,
        createdAt: "2026-03-22T00:00:00.000Z",
        homeDir,
        stateDir: legitimateStateDir,
        configPath: legitimateConfigPath,
        hasExternalConfig: true,
        externalRoots: [],
        warnings: [],
      });

      const { result, errors } = restoreFixed(snapshotDir, homeDir);

      expect(result).toBe(true);
      expect(errors.length).toBe(0);
      expect(fs.existsSync(legitimateConfigPath)).toBeTruthy();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Regression guard — migration-state.ts must contain the validation
// ═══════════════════════════════════════════════════════════════════
describe("C-4 regression: migration-state.ts contains path validation", () => {
  /** Extract the restoreSnapshotToHost function body from the source. */
  function getRestoreFnBody() {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "..", "nemoclaw", "src", "commands", "migration-state.ts"),
      "utf-8",
    );
    const fnStart = src.indexOf("function restoreSnapshotToHost");
    expect(fnStart !== -1).toBeTruthy();
    return src.slice(fnStart);
  }

  it("restoreSnapshotToHost calls isWithinRoot on manifest.stateDir", () => {
    const fnBody = getRestoreFnBody();
    expect(/isWithinRoot\s*\(\s*manifest\.stateDir/.test(fnBody)).toBeTruthy();
  });

  it("restoreSnapshotToHost calls isWithinRoot on manifest.configPath", () => {
    const fnBody = getRestoreFnBody();
    expect(/isWithinRoot\s*\(\s*manifest\.configPath/.test(fnBody)).toBeTruthy();
  });

  it("restoreSnapshotToHost validates manifest.homeDir against trusted root", () => {
    const fnBody = getRestoreFnBody();
    expect(/isWithinRoot\s*\(\s*manifest\.homeDir/.test(fnBody)).toBeTruthy();
  });

  it("restoreSnapshotToHost fails closed when hasExternalConfig is true with missing configPath", () => {
    const fnBody = getRestoreFnBody();
    expect(/manifest\.hasExternalConfig\b/.test(fnBody) &&
      /typeof\s+manifest\.configPath\s*!==\s*["']string["']/.test(fnBody)).toBeTruthy();
  });
});
