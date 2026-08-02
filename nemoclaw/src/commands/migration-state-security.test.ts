// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../index.js";
import {
  cleanupSnapshotBundle,
  createSnapshotBundle,
  type HostOpenClawState,
  setConfigValue,
} from "./migration-state.js";

const roots: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "nemoclaw-migration-state-security-"));
  roots.push(home);
  return home;
}

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeHostState(homeDir: string, configPath: string): HostOpenClawState {
  const stateDir = path.join(homeDir, ".openclaw");
  return {
    exists: true,
    homeDir,
    stateDir,
    configDir: stateDir,
    configPath,
    workspaceDir: null,
    extensionsDir: null,
    skillsDir: null,
    hooksDir: null,
    externalRoots: [],
    warnings: [],
    errors: [],
    hasExternalConfig: false,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("migration-state prepared config security", () => {
  it("installs a mode-0600 config after scrubbing contextual secrets in memory", () => {
    const home = makeHome();
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { auth: { token: "must-not-migrate" } },
        metadata: {
          environmentAssignment: "GITHUB_TOKEN=opaque-secret-value-123",
          camelAssignment: "apiKey=opaque-secret-value-123",
          model: "keep-me",
        },
      }),
    );

    const bundle = createSnapshotBundle(makeHostState(home, configPath), makeLogger(), {
      persist: false,
    });
    expect(bundle).not.toBeNull();
    if (bundle === null) return;

    const preparedConfigPath = path.join(bundle.preparedStateDir, "openclaw.json");
    const preparedConfig = JSON.parse(readFileSync(preparedConfigPath, "utf-8")) as {
      gateway?: unknown;
      metadata: Record<string, string>;
    };
    expect(preparedConfig.gateway).toBeUndefined();
    expect(preparedConfig.metadata).toEqual({
      environmentAssignment: "[STRIPPED_BY_MIGRATION]",
      camelAssignment: "[STRIPPED_BY_MIGRATION]",
      model: "keep-me",
    });
    expect(statSync(preparedConfigPath).mode & 0o777).toBe(0o600);

    cleanupSnapshotBundle(bundle);
  });

  it.runIf(process.platform !== "win32")(
    "rejects an in-tree config symlink without touching its external target",
    () => {
      const home = makeHome();
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const externalConfigPath = path.join(home, "external-openclaw.json");
      const original = JSON.stringify({ external: "must-remain" });
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(externalConfigPath, original, { mode: 0o640 });
      const originalMode = statSync(externalConfigPath).mode & 0o777;
      symlinkSync(externalConfigPath, configPath);
      const logger = makeLogger();

      const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
        persist: false,
      });

      expect(bundle).toBeNull();
      expect(logger.error).toHaveBeenCalled();
      expect(readFileSync(externalConfigPath, "utf-8")).toBe(original);
      expect(statSync(externalConfigPath).mode & 0o777).toBe(originalMode);
      const stagingDir = path.join(home, ".nemoclaw", "staging");
      expect(existsSync(stagingDir) ? readdirSync(stagingDir) : []).toEqual([]);
    },
  );
});

describe("migration-state config path security", () => {
  const expectPrototypeClean = (): void => {
    const probe: Record<string, unknown> = {};
    for (const key of ["polluted", "isAdmin", "bar"]) {
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, key)).toBe(false);
      expect(probe[key]).toBeUndefined();
    }
  };

  it.each([
    "__proto__",
    "constructor",
    "prototype",
  ])("rejects unsafe path segment: %s", (segment) => {
    const doc: Record<string, unknown> = {};
    expect(() => {
      setConfigValue(doc, `${segment}.polluted`, "true");
    }).toThrow(/Unsafe config path segment/);
    expectPrototypeClean();
  });

  it("rejects __proto__ in nested position", () => {
    const doc: Record<string, unknown> = {};
    expect(() => {
      setConfigValue(doc, "agents.__proto__.isAdmin", "true");
    }).toThrow(/Unsafe config path segment/);
    expectPrototypeClean();
  });

  it.each([
    "foo.prototype.bar",
    "foo.constructor.bar",
  ])("rejects unsafe segment in nested path: %s", (configPath) => {
    const doc: Record<string, unknown> = {};
    expect(() => {
      setConfigValue(doc, configPath, "true");
    }).toThrow(/Unsafe config path segment/);
    expectPrototypeClean();
  });

  it("allows simple top-level keys", () => {
    const doc: Record<string, unknown> = {};
    setConfigValue(doc, "theme", "dark");
    expect(doc.theme).toBe("dark");
  });
});
