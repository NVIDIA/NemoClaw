// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
import * as credentialFilter from "../security/credential-filter.js";
import * as snapshotSanitizer from "../security/snapshot-sanitizer.js";
import * as snapshotBoundary from "../shared/snapshot-sanitizer-boundary.cjs";
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

function expectSnapshotBundle(
  bundle: ReturnType<typeof createSnapshotBundle>,
): asserts bundle is NonNullable<ReturnType<typeof createSnapshotBundle>> {
  expect(bundle).not.toBeNull();
}

function makeMinimalHostSnapshot(): {
  home: string;
  configPath: string;
  logger: PluginLogger;
} {
  const home = makeHome();
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configPath, "{}");
  return { home, configPath, logger: makeLogger() };
}

function expectSnapshotFailure(
  home: string,
  logger: PluginLogger,
  bundle: ReturnType<typeof createSnapshotBundle>,
  message: string,
): void {
  expect(bundle).toBeNull();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(message));
  expect(readdirSync(path.join(home, ".nemoclaw", "staging"))).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
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
    expectSnapshotBundle(bundle);

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
      const externalConfigFd = openSync(externalConfigPath, "r");
      try {
        const originalMode = fstatSync(externalConfigFd).mode & 0o777;
        symlinkSync(externalConfigPath, configPath);
        const logger = makeLogger();

        const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
          persist: false,
        });

        expect(bundle).toBeNull();
        expect(logger.error).toHaveBeenCalled();
        expect(readFileSync(externalConfigFd, "utf-8")).toBe(original);
        expect(fstatSync(externalConfigFd).mode & 0o777).toBe(originalMode);
        const stagingDir = path.join(home, ".nemoclaw", "staging");
        expect(existsSync(stagingDir) ? readdirSync(stagingDir) : []).toEqual([]);
      } finally {
        closeSync(externalConfigFd);
      }
    },
  );
});

describe("migration-state prepared config fail-closed boundaries", () => {
  it("removes staging when the copied config parent cannot be inspected", () => {
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const inspect = vi
      .spyOn(snapshotBoundary, "inspectDescriptorSnapshotRoot")
      .mockReturnValue(null);

    const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
      persist: false,
    });

    expectSnapshotFailure(home, logger, bundle, "Failed to inspect copied OpenClaw config parent");
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("removes staging when copied config bytes cannot be decoded", () => {
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const decodeDescriptorSnapshotContent = snapshotBoundary.decodeDescriptorSnapshotContent;
    const decode = vi
      .spyOn(snapshotBoundary, "decodeDescriptorSnapshotContent")
      .mockImplementationOnce(decodeDescriptorSnapshotContent)
      .mockReturnValue(null);

    const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
      persist: false,
    });

    expectSnapshotFailure(
      home,
      logger,
      bundle,
      "Failed canonical decoding of copied OpenClaw config",
    );
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("removes staging when in-memory credential stripping returns a non-object", () => {
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const stripCredentials = credentialFilter.stripCredentials;
    const strip = vi
      .spyOn(credentialFilter, "stripCredentials")
      .mockImplementationOnce(stripCredentials)
      .mockReturnValue([]);

    const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
      persist: false,
    });

    expectSnapshotFailure(
      home,
      logger,
      bundle,
      "Failed to sanitize prepared OpenClaw config in memory",
    );
    expect(strip).toHaveBeenCalledTimes(2);
  });

  it("removes staging when the prepared config cannot be installed", () => {
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const install = vi
      .spyOn(snapshotBoundary, "installDescriptorSnapshotFile")
      .mockReturnValue(false);

    const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
      persist: false,
    });

    expectSnapshotFailure(
      home,
      logger,
      bundle,
      "Failed descriptor-bound installation of prepared OpenClaw config",
    );
    expect(install).toHaveBeenCalledOnce();
  });

  it("removes staging when the installed config cannot be sanitized", () => {
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const sanitize = vi
      .spyOn(snapshotSanitizer, "sanitizeOpenClawConfigFile")
      .mockReturnValue(false);

    const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
      persist: false,
    });

    expectSnapshotFailure(home, logger, bundle, "Failed to sanitize prepared OpenClaw config");
    expect(sanitize).toHaveBeenCalledOnce();
  });
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
  ])("rejects prototype-related config path segment: %s", (segment) => {
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
  ])("rejects prototype-related segment in nested config path: %s", (configPath) => {
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
