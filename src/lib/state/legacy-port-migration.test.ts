// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type OnboardEntryOptionsDeps,
  resolveOnboardEntryOptions,
} from "../onboard/entry-options";
import { migrateLegacyPortState } from "./legacy-port-migration";
import {
  listRetainedSandboxRecoveryRecords,
  recordRetainedSandboxRecovery,
} from "./onboard-session/retained-sandbox-recovery";

const homes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-port-state-"));
  homes.push(home);
  return home;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function recordRecovery(
  filePath: string,
  sandboxName: string,
  gatewayPort: number,
  seed: string,
): void {
  recordRetainedSandboxRecovery(filePath, {
    sandboxName,
    sandboxIdentityFingerprint: seed.repeat(64),
    gatewayName: gatewayPort === 8080 ? "nemoclaw" : `nemoclaw-${String(gatewayPort)}`,
    gatewayPort,
    lifecycleGeneration: `generation-${seed}`,
    createAttemptNonce: seed.repeat(62),
    resources: {
      sharedInferenceProviders: [],
      sandboxScopedProviders: [],
      credentialEnvironmentVariables: [],
    },
    reason: "retained_after_sandbox_creation_failure",
    recordedAt: "2026-08-29T00:00:00.000Z",
  });
}

function expectRetainedNameBlocked(
  records: readonly { readonly sandboxName: string }[],
  sandboxName: string,
): void {
  const entryDeps: OnboardEntryOptionsDeps = {
    isNonInteractive: () => false,
    validateName: (name) => name,
    reservedSandboxNames: new Set(),
    cliDisplayName: () => "NemoClaw",
    getNameValidationGuidance: () => [],
    error: vi.fn(),
    exitProcess: vi.fn(() => {
      throw new Error("blocked retained recovery name");
    }),
  };
  expect(() =>
    resolveOnboardEntryOptions(
      {
        opts: { fresh: true, sandboxName },
        env: {},
        stdinIsTty: true,
        stdoutIsTty: true,
        retainedRecoverySandboxNames: records.map((record) => record.sandboxName),
      },
      entryDeps,
    ),
  ).toThrow("blocked retained recovery name");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("legacy non-default gateway state migration", () => {
  it("partitions a recovery-only session and mixed-gateway recovery authority", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const selected = path.join(shared, "gateways", "9123");
    writeJson(path.join(shared, "sandboxes.json"), {
      defaultSandbox: "default-box",
      extraProviders: ["custom-provider"],
      sandboxes: {
        "default-box": {
          name: "default-box",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          dashboardPort: 18789,
        },
        "port-box": {
          name: "port-box",
          gatewayName: "nemoclaw-9123",
          gatewayPort: 9123,
          dashboardPort: 18790,
        },
      },
    });
    writeJson(path.join(shared, "onboard-session.json"), {
      sandboxName: "port-box",
      status: "recovery_required",
      metadata: { gatewayName: "nemoclaw-9123" },
    });
    const sharedRecovery = path.join(shared, "retained-sandbox-recovery.json");
    recordRecovery(sharedRecovery, "port-box", 9123, "a");
    recordRecovery(sharedRecovery, "default-box", 8080, "b");
    writeJson(path.join(shared, "credentials.json"), { NVIDIA_API_KEY: "legacy-secret" });
    writeJson(path.join(shared, "usage-notice.json"), { acceptedVersion: "1" });
    writeJson(path.join(shared, "state", "default-forward.json"), { pid: 123 });
    writeJson(path.join(shared, "rebuild-backups", "default-box", "one", "manifest.json"), {});
    writeJson(path.join(shared, "rebuild-backups", "port-box", "two", "manifest.json"), {});

    const result = migrateLegacyPortState({ home, gatewayPort: 9123 });

    expect(result).toEqual({
      migratedSandboxNames: ["port-box"],
      migratedSession: true,
      warnings: [expect.stringContaining("Left ambiguous legacy state")],
    });
    expect(Object.keys(readJson(path.join(shared, "sandboxes.json")).sandboxes as object)).toEqual([
      "default-box",
    ]);
    expect(
      Object.keys(readJson(path.join(selected, "sandboxes.json")).sandboxes as object),
    ).toEqual(["port-box"]);
    expect(fs.existsSync(path.join(shared, "onboard-session.json"))).toBe(false);
    expect(fs.existsSync(path.join(selected, "onboard-session.json"))).toBe(true);
    const selectedRecoveryRecords = listRetainedSandboxRecoveryRecords(
      path.join(selected, "retained-sandbox-recovery.json"),
    );
    const remainingRecoveryRecords = listRetainedSandboxRecoveryRecords(sharedRecovery);
    expect(selectedRecoveryRecords.map((record) => record.sandboxName)).toEqual(["port-box"]);
    expect(remainingRecoveryRecords.map((record) => record.sandboxName)).toEqual(["default-box"]);
    expectRetainedNameBlocked(selectedRecoveryRecords, "port-box");
    expectRetainedNameBlocked(remainingRecoveryRecords, "default-box");
    expect(fs.existsSync(path.join(shared, "credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(selected, "credentials.json"))).toBe(true);
    expect(fs.existsSync(path.join(shared, "usage-notice.json"))).toBe(true);
    expect(fs.existsSync(path.join(selected, "usage-notice.json"))).toBe(false);
    expect(fs.existsSync(path.join(shared, "state", "default-forward.json"))).toBe(true);
    expect(fs.existsSync(path.join(selected, "state"))).toBe(false);
    expect(
      fs.existsSync(path.join(selected, "rebuild-backups", "port-box", "two", "manifest.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(shared, "rebuild-backups", "default-box", "one", "manifest.json")),
    ).toBe(true);

    expect(migrateLegacyPortState({ home, gatewayPort: 9123 })).toEqual({
      migratedSandboxNames: [],
      migratedSession: false,
      warnings: [],
    });
  });

  it("refuses a row whose persisted gateway name and port conflict without mutating state", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    writeJson(path.join(shared, "sandboxes.json"), {
      defaultSandbox: "ambiguous",
      sandboxes: {
        ambiguous: {
          name: "ambiguous",
          gatewayName: "nemoclaw-9124",
          gatewayPort: 9123,
        },
      },
    });
    const before = fs.readFileSync(path.join(shared, "sandboxes.json"), "utf8");

    expect(() => migrateLegacyPortState({ home, gatewayPort: 9123 })).toThrow(
      /conflicting gateway identity/,
    );
    expect(fs.readFileSync(path.join(shared, "sandboxes.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(shared, "gateways", "9123", "sandboxes.json"))).toBe(false);
  });

  it("refuses conflicting retained recovery identity without mutating state", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const recoveryFile = path.join(shared, "retained-sandbox-recovery.json");
    recordRetainedSandboxRecovery(recoveryFile, {
      sandboxName: "port-box",
      sandboxIdentityFingerprint: "c".repeat(64),
      gatewayName: "nemoclaw-9124",
      gatewayPort: 9123,
      lifecycleGeneration: "generation-c",
      createAttemptNonce: "c".repeat(62),
      resources: {
        sharedInferenceProviders: [],
        sandboxScopedProviders: [],
        credentialEnvironmentVariables: [],
      },
      reason: "retained_after_sandbox_creation_failure",
      recordedAt: "2026-08-29T00:00:00.000Z",
    });
    const before = fs.readFileSync(recoveryFile, "utf8");

    expect(() => migrateLegacyPortState({ home, gatewayPort: 9123 })).toThrow(
      /conflicting gateway identity/,
    );
    expect(fs.readFileSync(recoveryFile, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(shared, "gateways", "9123"))).toBe(false);
  });

  it("refuses an older published intent that omitted retained recovery", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const migration = path.join(shared, ".gateway-state-migration");
    const legacyRegistry = path.join(shared, "sandboxes.json");
    const recoveryFile = path.join(shared, "retained-sandbox-recovery.json");
    writeJson(legacyRegistry, {
      defaultSandbox: "default-box",
      sandboxes: {
        "default-box": { name: "default-box", gatewayName: "nemoclaw", gatewayPort: 8080 },
        "port-box": { name: "port-box", gatewayName: "nemoclaw-9123", gatewayPort: 9123 },
      },
    });
    writeJson(path.join(migration, "intent.json"), {
      version: 1,
      gatewayPort: 9123,
      selectedSandboxNames: ["port-box"],
      sandboxBackupNames: [],
      moveSession: false,
      bundleEntries: [],
      warnAmbiguousSession: false,
      rewriteLegacyRegistry: true,
    });
    writeJson(path.join(migration, "selected-registry.json"), {
      defaultSandbox: "port-box",
      sandboxes: {
        "port-box": { name: "port-box", gatewayName: "nemoclaw-9123", gatewayPort: 9123 },
      },
    });
    writeJson(path.join(migration, "remaining-registry.json"), {
      defaultSandbox: "default-box",
      sandboxes: {
        "default-box": { name: "default-box", gatewayName: "nemoclaw", gatewayPort: 8080 },
      },
    });
    recordRecovery(recoveryFile, "port-box", 9123, "f");
    const registryBefore = fs.readFileSync(legacyRegistry, "utf8");
    const recoveryBefore = fs.readFileSync(recoveryFile, "utf8");

    expect(() => migrateLegacyPortState({ home, gatewayPort: 9123 })).toThrow(
      /intent predates retained recovery partitioning/,
    );
    expect(fs.readFileSync(legacyRegistry, "utf8")).toBe(registryBefore);
    expect(fs.readFileSync(recoveryFile, "utf8")).toBe(recoveryBefore);
    expect(fs.existsSync(migration)).toBe(true);
    expect(fs.existsSync(path.join(shared, "gateways", "9123"))).toBe(false);
  });

  it("preflights backup collisions before publishing the selected registry", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const selected = path.join(shared, "gateways", "9123");
    const legacyRegistry = path.join(shared, "sandboxes.json");
    const selectedRegistry = path.join(selected, "sandboxes.json");
    writeJson(legacyRegistry, {
      defaultSandbox: "port-box",
      sandboxes: {
        "port-box": { name: "port-box", gatewayName: "nemoclaw-9123", gatewayPort: 9123 },
      },
    });
    writeJson(path.join(shared, "rebuild-backups", "port-box", "old", "manifest.json"), {});
    writeJson(path.join(selected, "rebuild-backups", "port-box", "existing", "manifest.json"), {});
    const legacyBefore = fs.readFileSync(legacyRegistry, "utf8");

    expect(() => migrateLegacyPortState({ home, gatewayPort: 9123 })).toThrow(
      /already exists; refusing to overwrite/,
    );
    expect(fs.existsSync(selectedRegistry)).toBe(false);
    expect(fs.readFileSync(legacyRegistry, "utf8")).toBe(legacyBefore);
    expect(
      fs.existsSync(path.join(shared, "rebuild-backups", "port-box", "old", "manifest.json")),
    ).toBe(true);
  });

  it.each([
    { scenario: "migration lock" },
    { scenario: "legacy registry lock" },
    { scenario: "selected registry lock" },
  ])(
    "removes shared ownership before moves and resumes an interrupted migration [$scenario]",
    ({ scenario }) => {
      const home = makeHome();
      const shared = path.join(home, ".nemoclaw");
      const selected = path.join(shared, "gateways", "9123");
      const legacyRegistry = path.join(shared, "sandboxes.json");
      const selectedRegistry = path.join(selected, "sandboxes.json");
      const backupSource = path.join(shared, "rebuild-backups", "port-box");
      const backupDestination = path.join(selected, "rebuild-backups", "port-box");
      writeJson(legacyRegistry, {
        defaultSandbox: "default-box",
        sandboxes: {
          "default-box": { name: "default-box", gatewayName: "nemoclaw", gatewayPort: 8080 },
          "port-box": { name: "port-box", gatewayName: "nemoclaw-9123", gatewayPort: 9123 },
        },
      });
      recordRecovery(path.join(shared, "retained-sandbox-recovery.json"), "port-box", 9123, "e");
      writeJson(path.join(backupSource, "snapshot", "manifest.json"), {});

      const renameSync = fs.renameSync.bind(fs);
      const failMove = (): never => {
        throw new Error("injected post-registry move failure");
      };
      const renameSpy = vi
        .spyOn(fs, "renameSync")
        .mockImplementation((source, destination) =>
          String(source) === backupSource ? failMove() : renameSync(source, destination),
        );

      expect(() => migrateLegacyPortState({ home, gatewayPort: 9123 })).toThrow(
        /injected post-registry move failure/,
      );
      renameSpy.mockRestore();

      expect(Object.keys(readJson(legacyRegistry).sandboxes as object)).toEqual(["default-box"]);
      expect(fs.existsSync(selectedRegistry)).toBe(false);
      expect(fs.existsSync(path.join(shared, "retained-sandbox-recovery.json"))).toBe(false);
      expect(
        listRetainedSandboxRecoveryRecords(
          path.join(selected, "retained-sandbox-recovery.json"),
        ).map((record) => record.sandboxName),
      ).toEqual(["port-box"]);
      expect(fs.existsSync(path.join(shared, ".gateway-state-migration"))).toBe(true);
      expect(() => migrateLegacyPortState({ home, gatewayPort: 8080 })).toThrow(
        /recoverable migration for gateway port 9123 is pending/,
      );

      const staleLock = (
        {
          "migration lock": path.join(shared, ".gateway-state-migration.lock"),
          "legacy registry lock": `${legacyRegistry}.lock`,
          "selected registry lock": `${selectedRegistry}.lock`,
        } as const
      )[scenario]!;
      fs.mkdirSync(staleLock, { recursive: true });
      fs.writeFileSync(path.join(staleLock, "owner"), String(Number.MAX_SAFE_INTEGER));

      expect(migrateLegacyPortState({ home, gatewayPort: 9123 })).toEqual({
        migratedSandboxNames: ["port-box"],
        migratedSession: false,
        warnings: [],
      });
      expect(Object.keys(readJson(selectedRegistry).sandboxes as object)).toEqual(["port-box"]);
      expect(fs.existsSync(path.join(backupDestination, "snapshot", "manifest.json"))).toBe(true);
      expect(fs.existsSync(path.join(shared, ".gateway-state-migration"))).toBe(false);
    },
  );

  it("partitions provable rows and recovery without a session but leaves credentials", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const selected = path.join(shared, "gateways", "9123");
    writeJson(path.join(shared, "sandboxes.json"), {
      defaultSandbox: "default-box",
      sandboxes: {
        "default-box": { name: "default-box" },
        "port-box": { name: "port-box", gatewayName: "nemoclaw-9123", gatewayPort: 9123 },
      },
    });
    recordRecovery(path.join(shared, "retained-sandbox-recovery.json"), "port-box", 9123, "d");
    writeJson(path.join(shared, "credentials.json"), { NVIDIA_API_KEY: "ambiguous-secret" });

    const result = migrateLegacyPortState({ home, gatewayPort: 9123 });

    expect(result.migratedSandboxNames).toEqual(["port-box"]);
    expect(result.warnings.join("\n")).toContain("Left ambiguous");
    expect(fs.existsSync(path.join(shared, "credentials.json"))).toBe(true);
    expect(fs.existsSync(path.join(selected, "credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(shared, "retained-sandbox-recovery.json"))).toBe(false);
    const recoveryRecords = listRetainedSandboxRecoveryRecords(
      path.join(selected, "retained-sandbox-recovery.json"),
    );
    expect(recoveryRecords.map((record) => record.sandboxName)).toEqual(["port-box"]);
    expectRetainedNameBlocked(recoveryRecords, "port-box");
  });

  it("moves singleton state when every legacy registry row belongs to the selected gateway", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const selected = path.join(shared, "gateways", "9123");
    writeJson(path.join(shared, "sandboxes.json"), {
      defaultSandbox: "port-box",
      sandboxes: {
        "port-box": { name: "port-box", gatewayName: "nemoclaw-9123", gatewayPort: 9123 },
      },
    });
    writeJson(path.join(shared, "credentials.json"), { NVIDIA_API_KEY: "selected-secret" });

    const result = migrateLegacyPortState({ home, gatewayPort: 9123 });

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(path.join(shared, "credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(selected, "credentials.json"))).toBe(true);
  });

  it.each([
    ["shared", (shared: string, _selected: string) => shared],
    ["selected", (_shared: string, selected: string) => selected],
  ])("refuses recovery-only migration while the %s onboarding lock is present", (_scope, root) => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const selected = path.join(shared, "gateways", "9123");
    const recoveryFile = path.join(shared, "retained-sandbox-recovery.json");
    recordRecovery(recoveryFile, "port-box", 9123, "d");
    const before = fs.readFileSync(recoveryFile, "utf8");
    fs.mkdirSync(root(shared, selected), { recursive: true });
    fs.writeFileSync(path.join(root(shared, selected), "onboard.lock"), "active writer");

    expect(() => migrateLegacyPortState({ home, gatewayPort: 9123 })).toThrow(
      /onboarding lock .* is present/u,
    );
    expect(fs.readFileSync(recoveryFile, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(selected, "retained-sandbox-recovery.json"))).toBe(false);
  });

  it.each(
    ["ollama-proxy-token", "ollama-proxy-port", "ollama-auth-proxy.pid"],
  )("keeps host-shared Ollama proxy state out of a non-default gateway migration [%s]", (entry) => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const selected = path.join(shared, "gateways", "9123");
    writeJson(path.join(shared, "sandboxes.json"), {
      defaultSandbox: "port-box",
      sandboxes: {
        "port-box": { name: "port-box", gatewayName: "nemoclaw-9123", gatewayPort: 9123 },
      },
    });
    writeJson(path.join(shared, "credentials.json"), { NVIDIA_API_KEY: "selected-secret" });
    fs.writeFileSync(path.join(shared, "ollama-proxy-token"), "host-token\n");
    fs.writeFileSync(path.join(shared, "ollama-proxy-port"), "11435\n");
    fs.writeFileSync(path.join(shared, "ollama-auth-proxy.pid"), "4242\n");

    const result = migrateLegacyPortState({ home, gatewayPort: 9123 });

    expect(result.warnings).toEqual([]);

    expect(fs.existsSync(path.join(shared, entry))).toBe(true);
    expect(fs.existsSync(path.join(selected, entry))).toBe(false);

    expect(fs.existsSync(path.join(shared, "credentials.json"))).toBe(false);
    expect(fs.existsSync(path.join(selected, "credentials.json"))).toBe(true);
  });

  it.each([8080, 9123])(
    "removes only generated stale migration-intent directories for gateway port %i",
    (gatewayPort) => {
      const home = makeHome();
      const shared = path.join(home, ".nemoclaw");
      const preparing = path.join(shared, ".gateway-state-migration.preparing.999999.1");
      const completed = path.join(shared, ".gateway-state-migration.completed.999999.2");
      const unrelated = path.join(shared, ".gateway-state-migration.preparing.not-a-pid.3");
      fs.mkdirSync(preparing, { recursive: true });
      fs.mkdirSync(completed, { recursive: true });
      fs.mkdirSync(unrelated, { recursive: true });

      expect(migrateLegacyPortState({ home, gatewayPort })).toEqual({
        migratedSandboxNames: [],
        migratedSession: false,
        warnings: [],
      });

      expect(fs.existsSync(preparing)).toBe(false);
      expect(fs.existsSync(completed)).toBe(false);
      expect(fs.existsSync(unrelated)).toBe(true);
      expect(fs.existsSync(path.join(shared, ".gateway-state-migration.lock"))).toBe(false);
    },
  );

  it("refuses to follow a stale-intent symlink", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const controlled = path.join(home, "controlled");
    const candidate = path.join(shared, ".gateway-state-migration.completed.999999.4");
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(controlled);
    fs.writeFileSync(path.join(controlled, "sentinel"), "keep");
    fs.symlinkSync(controlled, candidate, "dir");

    expect(() => migrateLegacyPortState({ home, gatewayPort: 9123 })).toThrow(/symbolic link/);
    expect(fs.readFileSync(path.join(controlled, "sentinel"), "utf8")).toBe("keep");
    expect(fs.lstatSync(candidate).isSymbolicLink()).toBe(true);
  });

  it("does not sweep intent directories while another migration owns the lock", () => {
    const home = makeHome();
    const shared = path.join(home, ".nemoclaw");
    const stale = path.join(shared, ".gateway-state-migration.preparing.999999.5");
    const lock = path.join(shared, ".gateway-state-migration.lock");
    fs.mkdirSync(stale, { recursive: true });
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), String(process.pid));

    expect(() => migrateLegacyPortState({ home, gatewayPort: 9123 })).toThrow(
      /another state operation owns/,
    );
    expect(fs.existsSync(stale)).toBe(true);
  });

  it("does not modify the byte-compatible default gateway root", () => {
    const home = makeHome();
    const registry = path.join(home, ".nemoclaw", "sandboxes.json");
    writeJson(registry, {
      defaultSandbox: "default-box",
      sandboxes: { "default-box": { name: "default-box" } },
    });
    const before = fs.readFileSync(registry, "utf8");

    expect(migrateLegacyPortState({ home, gatewayPort: 8080 })).toEqual({
      migratedSandboxNames: [],
      migratedSession: false,
      warnings: [],
    });
    expect(fs.readFileSync(registry, "utf8")).toBe(before);
  });
});
