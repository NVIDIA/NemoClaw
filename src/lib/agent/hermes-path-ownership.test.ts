// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  findHermesManagedArtifact,
  HERMES_MANAGED_ARTIFACTS,
  HERMES_UNSUPPORTED_RESIDUAL_PATHS,
  type HermesHome,
  type HermesManagedArtifact,
  type HermesPosture,
  type HermesPostureRequirement,
  type HermesRequiredPostures,
  resolveHermesArtifactBackup,
  resolveHermesArtifactPath,
  resolveHermesArtifactRestore,
  resolveHermesBackupAction,
  resolveHermesHomePath,
  resolveHermesIdentities,
  resolveHermesPosture,
} from "./hermes-path-ownership";

const TOPOLOGIES = ["root-separated", "same-uid"] as const;

type HermesTopology = (typeof TOPOLOGIES)[number];
type HermesMigrationSource = NonNullable<HermesManagedArtifact["migrationSources"]>[number];
type HermesUnsupportedResidual = (typeof HERMES_UNSUPPORTED_RESIDUAL_PATHS)[number];

function artifact(id: string): HermesManagedArtifact {
  const result = HERMES_MANAGED_ARTIFACTS.find((candidate) => candidate.id === id);
  expect(result, "Missing Hermes artifact '" + id + "'").toBeDefined();
  return result as HermesManagedArtifact;
}

function homesFor(artifactRule: HermesManagedArtifact): HermesHome[] {
  switch (artifactRule.scope) {
    case "agent-home":
      return [{ kind: "default" }, { kind: "named-profile", name: "research" }];
    case "default-home":
      return [{ kind: "default" }];
    case "dashboard":
      return [{ kind: "dashboard" }];
    case "named-profile":
      return [{ kind: "named-profile", name: "research" }];
  }
}

function homesForResidual(residual: HermesUnsupportedResidual): HermesHome[] {
  switch (residual.scope) {
    case "agent-home":
      return [{ kind: "default" }, { kind: "named-profile", name: "research" }];
    case "default-home":
      return [{ kind: "default" }];
    case "named-profile":
      return [{ kind: "named-profile", name: "research" }];
  }
}

function postures(requirement: HermesPostureRequirement): HermesPosture[] {
  return TOPOLOGIES.map((topology) => resolveHermesPosture(requirement, topology, "sandbox"));
}

function materializePattern(pattern: string): string {
  return pattern.replace(/\*\*/gu, "nested/item").replace(/\{[^/{}]+\}/gu, "sample");
}

function migrationSourcesFor(
  artifactRule: HermesManagedArtifact,
): readonly HermesMigrationSource[] {
  return artifactRule.migrationSources ?? [];
}

function lifecyclePostures(required: HermesRequiredPostures): HermesPostureRequirement[] {
  return [required.create, required.restore, required.shields?.up, required.shields?.down].filter(
    (requirement): requirement is HermesPostureRequirement =>
      requirement !== undefined && requirement !== "absent",
  );
}

function requiredPosture(
  requirement: HermesPostureRequirement | "absent",
  message: string,
): HermesPostureRequirement {
  expect(requirement, message).not.toBe("absent");
  return requirement as HermesPostureRequirement;
}

function contentOwner(posture: ReturnType<typeof resolveHermesPosture>): string {
  switch (posture.kind) {
    case "path":
      return posture.owner;
    case "tree":
      return posture.descendantOwner;
  }
}

function expectProducerOwnership(entry: HermesManagedArtifact, topology: HermesTopology): void {
  const producers = resolveHermesIdentities(entry.producers, topology);
  const readers = resolveHermesIdentities(entry.readers, topology);
  expect(producers.length, entry.id).toBeGreaterThan(0);
  expect(readers.length, entry.id).toBeGreaterThan(0);

  for (const producer of producers.filter((candidate) => candidate !== "root")) {
    const create = resolveHermesPosture(entry.required.create, topology, producer);
    expect(readers, entry.id + ":" + producer).toContain(producer);
    expect([producer, "preserve"], entry.id + ":" + producer).toContain(contentOwner(create));
  }
}

function expectScopeRules(entry: HermesManagedArtifact): void {
  switch (typeof entry.relativePath) {
    case "object":
      expect(entry.scope, entry.id).toBe("agent-home");
      break;
    default:
      break;
  }

  for (const rule of [entry.backup, entry.restore]) {
    switch (typeof rule) {
      case "object":
        switch ("default" in rule) {
          case true:
            expect(entry.scope, entry.id).toBe("agent-home");
            break;
          case false:
            break;
        }
        break;
      default:
        break;
    }
  }
}

function expectPostureShape(
  entry: HermesManagedArtifact,
  requirement: HermesPostureRequirement,
): void {
  for (const posture of postures(requirement)) {
    switch (entry.match) {
      case "subtree":
        expect(posture.kind, entry.id).toBe("tree");
        break;
      default:
        break;
    }
    switch (posture.kind) {
      case "path":
        expect(posture.mode, entry.id).toMatch(/^0[0-7]{3,4}$/);
        break;
      case "tree":
        expect(posture.directoryMode, entry.id).toMatch(/^0[0-7]{3,4}$/);
        expect(posture.descendantOwner, entry.id).not.toBe("producer");
        expect(posture.symlinks, entry.id).toBe("ownership-only");
        break;
    }
  }
}

function expectSelectiveBackup(
  backup: ReturnType<typeof resolveHermesArtifactBackup>,
  id: string,
): void {
  switch (typeof backup) {
    case "object":
      expect(backup.kind, id).toBe("selective");
      expect(backup.selectors.length, id).toBeGreaterThan(0);
      expect(new Set(backup.selectors.map((selector) => selector.relativePattern)).size).toBe(
        backup.selectors.length,
      );
      break;
    default:
      break;
  }
}

function expectMigrationFailurePolicy(source: HermesMigrationSource, sourcePath: string): void {
  switch (source.action) {
    case "migrate":
      expect(source.onFailure, sourcePath).toBe("leave-source");
      break;
    case "discard":
      break;
  }
}

function expectShieldsContract(entry: HermesManagedArtifact): void {
  switch (entry.shields) {
    case "seal":
      expect(entry.required.shields, entry.id).toBeDefined();
      break;
    case "keep-writable":
    case "unchanged":
      break;
  }
}

function expectRecoveryContract(entry: HermesManagedArtifact, home: HermesHome): void {
  const backup = resolveHermesArtifactBackup(entry, home);
  const restore = resolveHermesArtifactRestore(entry, home);

  switch (backup) {
    case "exclude":
      expect(restore, entry.id).not.toBe("restore");
      break;
    default:
      break;
  }
  switch (restore) {
    case "discard":
      expect(entry.required.restore, entry.id).toBe("absent");
      break;
    case "regenerate":
    case "restore":
      expect(entry.required.restore, entry.id).not.toBe("absent");
      break;
  }
  expectSelectiveBackup(backup, entry.id);
}

describe("Hermes path ownership contract", () => {
  it("uses unique artifact ids and every ownership class (#8006)", () => {
    expect(new Set(HERMES_MANAGED_ARTIFACTS.map((entry) => entry.id)).size).toBe(
      HERMES_MANAGED_ARTIFACTS.length,
    );
    expect(new Set(HERMES_MANAGED_ARTIFACTS.map((entry) => entry.artifactClass))).toEqual(
      new Set([
        "protected-configuration",
        "credential-reference",
        "mutable-runtime-state",
        "durable-state",
        "derived-disposable-state",
      ]),
    );
  });

  it("names producer and reader ownership in every topology (#8006)", () => {
    for (const entry of HERMES_MANAGED_ARTIFACTS) {
      for (const topology of TOPOLOGIES) {
        expectProducerOwnership(entry, topology);
      }
      expect(resolveHermesIdentities(entry.producers, "same-uid"), entry.id).not.toContain(
        "gateway",
      );
      expect(resolveHermesIdentities(entry.readers, "same-uid"), entry.id).not.toContain("gateway");
    }
  });

  it("defines scope, lifecycle posture, and Shields policy for every artifact (#8006)", () => {
    for (const entry of HERMES_MANAGED_ARTIFACTS) {
      expectScopeRules(entry);
      for (const requirement of lifecyclePostures(entry.required)) {
        expectPostureShape(entry, requirement);
      }
      expectShieldsContract(entry);
    }
  });

  it("aligns backup and restore policy for every home layout (#8006)", () => {
    for (const entry of HERMES_MANAGED_ARTIFACTS) {
      for (const home of homesFor(entry)) {
        expectRecoveryContract(entry, home);
      }
    }
  });

  it("resolves unique targets and migration sources for every home layout (#8006)", () => {
    const concreteTargets = new Map<string, string>();
    for (const entry of HERMES_MANAGED_ARTIFACTS) {
      for (const home of homesFor(entry)) {
        const target = resolveHermesArtifactPath(entry, home);
        const key = home.kind + ":" + target + ":" + entry.match;
        expect(concreteTargets.get(key), entry.id).toBeUndefined();
        concreteTargets.set(key, entry.id);

        const resolvedTarget = findHermesManagedArtifact(materializePattern(target));
        expect(resolvedTarget?.artifact.id, entry.id + ":" + home.kind).toBe(entry.id);
        expect(resolvedTarget?.pathRole, entry.id + ":" + home.kind).toBe("target");

        for (const source of migrationSourcesFor(entry)) {
          expect(source.relativePath, entry.id).not.toBe(".");
          expect(source.relativePath, entry.id).not.toMatch(/^\//u);
          const sourcePath =
            resolveHermesHomePath(home) + "/" + materializePattern(source.relativePath);
          const resolvedSource = findHermesManagedArtifact(sourcePath);
          expect(resolvedSource?.artifact.id, sourcePath).toBe(entry.id);
          expect(resolvedSource?.pathRole, sourcePath).toBe("migration-source");
          expectMigrationFailurePolicy(source, sourcePath);
        }
      }
    }
  });

  it("resolves every dynamic path for default and named homes without ambiguity (#8006)", () => {
    for (const entry of HERMES_MANAGED_ARTIFACTS.filter(
      (candidate) => candidate.match === "pattern",
    )) {
      for (const home of homesFor(entry)) {
        const target = materializePattern(resolveHermesArtifactPath(entry, home));
        expect(findHermesManagedArtifact(target)?.artifact.id, entry.id + ":" + home.kind).toBe(
          entry.id,
        );
      }
    }
  });

  it("resolves exact and nested paths while unknown profile state fails closed (#8006)", () => {
    expect(resolveHermesHomePath({ kind: "default" })).toBe("/sandbox/.hermes");
    expect(resolveHermesHomePath({ kind: "named-profile", name: "research" })).toBe(
      "/sandbox/.hermes/profiles/research",
    );
    expect(resolveHermesHomePath({ kind: "dashboard" })).toBe("/sandbox/.hermes/dashboard-home");

    expect(findHermesManagedArtifact("/sandbox/.hermes/config.yaml")?.artifact.id).toBe("config");
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/profiles/research/config.yaml")?.artifact.id,
    ).toBe("config");
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/platforms/whatsapp/session/credentials.json")
        ?.artifact.id,
    ).toBe("whatsapp-session");
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/whatsapp/session/credentials.json")?.artifact.id,
    ).toBe("legacy-whatsapp-session");
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/platforms/pairing/slack-pending.json"),
    ).toMatchObject({ artifact: { id: "pairing-pending" }, pathRole: "migration-source" });
    expect(
      findHermesManagedArtifact(
        "/sandbox/.hermes/profiles/research/platforms/pairing/slack-pending.json",
      ),
    ).toMatchObject({ artifact: { id: "pairing-pending" }, pathRole: "migration-source" });
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/runtime/pairing/slack-pending.json"),
    ).toMatchObject({ artifact: { id: "pairing-pending" }, pathRole: "target" });
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/pairing/slack-approved.json")?.artifact.id,
    ).toBe("pairing-approved");
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/skills/reviewer/SKILL.md")?.artifact.id,
    ).toBe("skills");
    expect(findHermesManagedArtifact("/sandbox/.hermes/runtime/future.tmp")?.artifact.id).toBe(
      "runtime-directory",
    );
    expect(findHermesManagedArtifact("/sandbox/.hermes/state/gateway.heartbeat")?.artifact.id).toBe(
      "process-state-directory",
    );
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/dashboard-home/MEMORY.md")?.artifact.id,
    ).toBe("dashboard-memory");
    expect(findHermesManagedArtifact("/sandbox/.hermes/profiles/research/future-state")).toBeNull();
    expect(findHermesManagedArtifact("/sandbox/.hermes/dashboard-home/future-state")).toBeNull();
    expect(findHermesManagedArtifact("/sandbox/.hermes/unmanaged.tmp")).toBeNull();
    expect(findHermesManagedArtifact("/outside/.hermes/config.yaml")).toBeNull();
    expect(findHermesManagedArtifact("/")).toBeNull();
    expect(() => findHermesManagedArtifact("/sandbox/.hermes/config.yaml/")).toThrow(
      "canonical absolute path",
    );
  });

  it("maps default and named runtime layouts without widening durability (#8006)", () => {
    const research = { kind: "named-profile", name: "research" } as const;
    expect(resolveHermesArtifactPath(artifact("main-state-database"), { kind: "default" })).toBe(
      "/sandbox/.hermes/runtime/state.db",
    );
    expect(resolveHermesArtifactPath(artifact("main-state-database"), research)).toBe(
      "/sandbox/.hermes/profiles/research/state.db",
    );

    for (const id of ["gateway-pid", "gateway-lock", "gateway-status"]) {
      const basename = resolveHermesArtifactPath(artifact(id), { kind: "default" })
        .split("/")
        .at(-1);
      expect(resolveHermesArtifactPath(artifact(id), { kind: "default" })).toBe(
        "/sandbox/.hermes/runtime/" + basename,
      );
      expect(resolveHermesArtifactPath(artifact(id), research)).toBe(
        "/sandbox/.hermes/profiles/research/runtime/" + basename,
      );
    }

    expect(resolveHermesArtifactPath(artifact("channel-directory"), { kind: "default" })).toBe(
      "/sandbox/.hermes/runtime/channel_directory.json",
    );
    expect(resolveHermesArtifactPath(artifact("channel-directory"), research)).toBe(
      "/sandbox/.hermes/profiles/research/channel_directory.json",
    );
    expect(resolveHermesArtifactPath(artifact("channel-aliases"), { kind: "default" })).toBe(
      "/sandbox/.hermes/channel_aliases.json",
    );
    expect(resolveHermesArtifactPath(artifact("channel-aliases"), research)).toBe(
      "/sandbox/.hermes/profiles/research/channel_aliases.json",
    );
    expect(findHermesManagedArtifact("/sandbox/.hermes/profiles/research/kanban.db")).toBeNull();
  });

  it("keeps unsupported residuals discard-only and outside the managed resolver (#8006)", () => {
    const residualIds = HERMES_UNSUPPORTED_RESIDUAL_PATHS.map((entry) => entry.id);
    const managedIds = HERMES_MANAGED_ARTIFACTS.map((entry) => entry.id);
    expect(new Set(residualIds).size).toBe(residualIds.length);
    expect(new Set(HERMES_UNSUPPORTED_RESIDUAL_PATHS.map((entry) => entry.disposition))).toEqual(
      new Set(["discard"]),
    );

    for (const residual of HERMES_UNSUPPORTED_RESIDUAL_PATHS) {
      expect(managedIds, residual.id).not.toContain(residual.id);
      expect(residual.relativePath, residual.id).not.toBe(".");
      expect(residual.relativePath, residual.id).not.toMatch(/^\//u);

      for (const home of homesForResidual(residual)) {
        const target =
          resolveHermesHomePath(home) + "/" + materializePattern(residual.relativePath);
        expect(findHermesManagedArtifact(target), residual.id + ":" + home.kind).toBeNull();
      }
    }
  });

  it("resolves the pinned core profile surface for default and named homes (#8006)", () => {
    const relativePaths = [
      "MEMORY.md",
      "USER.md",
      "todo.json",
      "system_prompt.md",
      "AGENTS.md",
      "CLAUDE.md",
      ".cursorrules",
      "scripts/task.sh",
      "knowledge/index.md",
      "preferences/theme.json",
      "home/.config/tool/settings.json",
      "web_cache/index.json",
      "delegation_cache/result.json",
      "piper_voices_cache/en_US.onnx",
      "document_cache/item.json",
      "browser_screenshots/page.png",
      "checkpoints/session/checkpoint.json",
      "sandboxes/task/rootfs",
      "backups/archive.tar.gz",
      "state-snapshots/quick/state.json",
      "bin/tirith",
      "local/runtime.json",
      "processes.json",
      ".drain_request.json",
      "state/gateway.heartbeat",
      "gateway-starts.log",
      "auth.lock",
      "response_store.db",
      "verification_evidence.db",
      "feishu_comment_rules.json",
      "feishu_comment_pairing.json",
    ];

    for (const relativePath of relativePaths) {
      expect(
        findHermesManagedArtifact("/sandbox/.hermes/" + relativePath),
        relativePath,
      ).not.toBeNull();
      expect(
        findHermesManagedArtifact("/sandbox/.hermes/profiles/research/" + relativePath),
        relativePath,
      ).not.toBeNull();
    }
    expect(findHermesManagedArtifact("/sandbox/.hermes/active_profile")?.artifact.id).toBe(
      "active-profile",
    );
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/kanban/boards/roadmap/kanban.db")?.artifact.id,
    ).toBe("kanban-board-database");
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/kanban/workspaces/task/output")?.artifact.id,
    ).toBe("kanban-workspaces");
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/dashboard-home/kanban.db")?.artifact.id,
    ).toBe("dashboard-kanban-database");
    for (const [relativePath, id] of [
      ["web_cache/index.json", "legacy-web-cache"],
      ["delegation_cache/result.json", "legacy-delegation-cache"],
      ["piper_voices_cache/en_US.onnx", "legacy-piper-voices-cache"],
    ] as const) {
      expect(findHermesManagedArtifact("/sandbox/.hermes/" + relativePath)?.artifact).toMatchObject(
        {
          id,
          artifactClass: "derived-disposable-state",
          backup: "exclude",
          restore: "regenerate",
          migration: "regenerate",
        },
      );
    }
  });

  it.each([
    "",
    ".",
    "..",
    "team/alpha",
    "team\\alpha",
    "bad\nname",
    "Uppercase",
    "has space",
    "default",
  ])("rejects the unsafe profile name %j (#8006)", (name) => {
    expect(() => resolveHermesHomePath({ kind: "named-profile", name })).toThrow(
      "must match [a-z0-9][a-z0-9_-]{0,63}",
    );
  });

  it("keeps default and named ownership equal while their recovery policy can differ (#8006)", () => {
    const defaultHome = { kind: "default" } as const;
    const namedHome = { kind: "named-profile", name: "research" } as const;

    for (const id of ["config", "environment", "runtime-directory", "main-state-database"]) {
      const entry = artifact(id);
      const defaultRule = findHermesManagedArtifact(resolveHermesArtifactPath(entry, defaultHome));
      const namedRule = findHermesManagedArtifact(resolveHermesArtifactPath(entry, namedHome));
      expect(defaultRule?.artifact.id).toBe(id);
      expect(namedRule?.artifact.id).toBe(id);
      expect(defaultRule?.artifact.required).toEqual(namedRule?.artifact.required);
      expect(defaultRule?.home).toEqual(defaultHome);
      expect(namedRule?.home).toEqual(namedHome);
      expect(resolveHermesArtifactPath(entry, defaultHome)).not.toBe(
        resolveHermesArtifactPath(entry, namedHome),
      );
    }

    expect(resolveHermesArtifactBackup(artifact("config"), defaultHome)).toBe("exclude");
    expect(resolveHermesArtifactRestore(artifact("config"), defaultHome)).toBe("regenerate");
    expect(resolveHermesArtifactBackup(artifact("config"), namedHome)).toBe("file");
    expect(resolveHermesArtifactRestore(artifact("config"), namedHome)).toBe("restore");
    expect(resolveHermesArtifactBackup(artifact("environment"), namedHome)).toBe("exclude");
    expect(resolveHermesArtifactRestore(artifact("environment"), namedHome)).toBe("regenerate");
    expect(
      resolveHermesPosture(artifact("environment").required.create, "root-separated"),
    ).toMatchObject({ owner: "sandbox", mode: "0640" });
    expect(resolveHermesPosture(artifact("environment").required.create, "same-uid")).toMatchObject(
      { owner: "sandbox", mode: "0600" },
    );
  });

  it("distinguishes topology, tree contents, and restore transitions (#8006)", () => {
    expect(
      resolveHermesPosture(artifact("agent-home-root").required.create, "root-separated"),
    ).toEqual({
      kind: "path",
      owner: "root",
      group: "sandbox",
      mode: "03770",
    });
    expect(
      resolveHermesPosture(artifact("agent-home-root").required.shields!.up, "root-separated"),
    ).toEqual({
      kind: "path",
      owner: "root",
      group: "sandbox",
      mode: "03770",
    });

    expect(
      resolveHermesPosture(
        artifact("runtime-directory").required.create,
        "root-separated",
        "gateway",
      ),
    ).toMatchObject({
      kind: "tree",
      owner: "gateway",
      descendantOwner: "gateway",
      group: "sandbox",
      directoryMode: "03770",
    });
    expect(
      resolveHermesPosture(artifact("runtime-directory").required.create, "same-uid", "sandbox"),
    ).toMatchObject({
      kind: "tree",
      owner: "sandbox",
      descendantOwner: "sandbox",
      group: "sandbox",
      directoryMode: "03770",
    });
    expect(
      resolveHermesPosture(artifact("authentication-state").required.create, "root-separated"),
    ).toEqual({
      kind: "path",
      owner: "gateway",
      group: "sandbox",
      mode: "0600",
    });
    expect(artifact("authentication-state").required.restore).toBe("absent");
    expect(artifact("authentication-state").artifactClass).toBe("credential-reference");
    expect(artifact("telegram-sticker-cache")).toMatchObject({
      artifactClass: "derived-disposable-state",
      backup: "exclude",
      restore: "discard",
      migration: "discard",
    });
    expect(
      resolveHermesPosture(artifact("telegram-sticker-cache").required.create, "root-separated"),
    ).toMatchObject({ owner: "gateway", mode: "0600" });
    expect(
      resolveHermesPosture(artifact("authentication-lock").required.create, "same-uid"),
    ).toMatchObject({ owner: "sandbox", mode: "0600" });
    expect(() =>
      resolveHermesPosture(artifact("drain-request").required.create, "root-separated"),
    ).toThrow("producer identity is required");
    expect(
      resolveHermesPosture(artifact("drain-request").required.create, "root-separated", "sandbox"),
    ).toMatchObject({ owner: "sandbox", mode: "0660" });

    expect(resolveHermesPosture(artifact("skills").required.shields!.up, "root-separated")).toEqual(
      {
        kind: "tree",
        owner: "root",
        descendantOwner: "root",
        group: "sandbox",
        directoryMode: "0755",
        fileMode: "go-w",
        symlinks: "ownership-only",
      },
    );
    expect(artifact("pairing-state").required.shields).toBeDefined();
    expect(
      resolveHermesPosture(artifact("pairing-state").required.shields!.up, "root-separated"),
    ).toEqual({
      kind: "tree",
      owner: "root",
      descendantOwner: "root",
      group: "sandbox",
      directoryMode: "0755",
      fileMode: "go-w",
      symlinks: "ownership-only",
    });
    expect(
      resolveHermesPosture(artifact("dashboard-home").required.create, "root-separated"),
    ).toMatchObject({
      kind: "tree",
      directoryMode: "0700",
      fileMode: "0600",
    });

    const restoredMainDatabase = requiredPosture(
      artifact("main-state-database").required.restore,
      "Main state database must restore",
    );
    expect(resolveHermesPosture(restoredMainDatabase, "root-separated")).toEqual({
      kind: "path",
      owner: "sandbox",
      group: "sandbox",
      mode: "0660",
    });
    expect(
      resolveHermesPosture(
        artifact("cron-execution-database").required.create,
        "root-separated",
        "gateway",
      ),
    ).toMatchObject({
      owner: "gateway",
      mode: "0660",
    });
    expect(findHermesManagedArtifact("/sandbox/.hermes/cron/executions.db")).toMatchObject({
      artifact: { id: "cron-execution-database", backup: "sqlite" },
      pathRole: "migration-source",
    });
    expect(artifact("main-state-sidecar-wal").required.restore).toBe("absent");
    expect(artifact("restart-seal-marker").required.restore).toBe("absent");
    expect(artifact("tirith-retry-marker").required.restore).toBe("absent");
    expect(
      resolveHermesPosture(artifact("gateway-lock").required.create, "root-separated"),
    ).toMatchObject({ owner: "gateway", mode: "0660" });
    expect(
      resolveHermesPosture(artifact("tirith-retry-marker").required.create, "root-separated"),
    ).toMatchObject({ owner: "gateway", mode: "0660" });
  });

  it("names every identity that creates shared and transient artifacts (#8006)", () => {
    expect(resolveHermesIdentities(artifact("skills").producers, "root-separated")).toEqual([
      "root",
      "sandbox",
      "gateway",
    ]);
    expect(
      resolveHermesIdentities(artifact("main-state-database").producers, "root-separated"),
    ).toEqual(["root", "sandbox", "gateway"]);
    expect(resolveHermesIdentities(artifact("tui-history").producers, "root-separated")).toEqual([
      "root",
      "sandbox",
    ]);
    expect(
      resolveHermesIdentities(artifact("tirith-retry-marker").producers, "root-separated"),
    ).toEqual(["gateway"]);
    expect(resolveHermesIdentities(artifact("tirith-retry-marker").producers, "same-uid")).toEqual([
      "sandbox",
    ]);
    expect(
      resolveHermesIdentities(artifact("agent-home-root").producers, "root-separated"),
    ).toEqual(["root"]);
  });

  it("classifies SQLite sidecars as disposable across every home layout (#8006)", () => {
    const paths = new Map([
      ["/sandbox/.hermes/runtime/state.db-journal", "main-state-sidecar-journal"],
      ["/sandbox/.hermes/profiles/research/state.db-wal", "main-state-sidecar-wal"],
      ["/sandbox/.hermes/runtime/cron-executions.db-shm", "cron-execution-sidecar-shm"],
      [
        "/sandbox/.hermes/gateway/discord_message_recovery.db-journal",
        "discord-recovery-sidecar-journal",
      ],
      ["/sandbox/.hermes/kanban.db-journal", "default-kanban-sidecar-journal"],
      ["/sandbox/.hermes/dashboard-home/kanban.db-journal", "dashboard-kanban-sidecar-journal"],
      ["/sandbox/.hermes/projects.db-journal", "projects-database-sidecar-journal"],
      [
        "/sandbox/.hermes/profiles/research/response_store.db-journal",
        "response-store-database-sidecar-journal",
      ],
      ["/sandbox/.hermes/memory_store.db-wal", "memory-store-database-sidecar-wal"],
      [
        "/sandbox/.hermes/verification_evidence.db-shm",
        "verification-evidence-database-sidecar-shm",
      ],
    ] as const);

    for (const [target, id] of paths) {
      expect(findHermesManagedArtifact(target)?.artifact, target).toMatchObject({
        id,
        artifactClass: "derived-disposable-state",
        backup: "exclude",
        restore: "discard",
      });
    }
    for (const suffix of ["wal", "shm", "journal"] as const) {
      const source = findHermesManagedArtifact("/sandbox/.hermes/cron/executions.db-" + suffix);
      expect(source, suffix).toMatchObject({
        artifact: {
          id: "cron-execution-sidecar-" + suffix,
          artifactClass: "derived-disposable-state",
          backup: "exclude",
          restore: "discard",
        },
        pathRole: "migration-source",
      });
      expect(source?.artifact.migrationSources).toContainEqual({
        relativePath: "cron/executions.db-" + suffix,
        match: "exact",
        action: "migrate",
        onFailure: "leave-source",
      });
    }
    expect(findHermesManagedArtifact("/sandbox/.hermes/projects.db-backup")).toBeNull();
    expect(findHermesManagedArtifact("/sandbox/.hermes/kanban.db-future")).toBeNull();
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/dashboard-home/kanban.db-future"),
    ).toBeNull();
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/kanban/boards/release/kanban.db-future")?.artifact
        .id,
    ).toBe("kanban-state");

    for (const prefix of [
      "main-state-sidecar",
      "cron-execution-sidecar",
      "discord-recovery-sidecar",
      "default-kanban-sidecar",
      "dashboard-kanban-sidecar",
      "projects-database-sidecar",
      "response-store-database-sidecar",
      "memory-store-database-sidecar",
      "verification-evidence-database-sidecar",
      "kanban-board-database-sidecar",
      "archived-kanban-board-database-sidecar",
      "dashboard-kanban-board-database-sidecar",
      "dashboard-archived-kanban-board-database-sidecar",
    ]) {
      for (const suffix of ["wal", "shm", "journal"]) {
        expect(artifact(prefix + "-" + suffix).backup, prefix).toBe("exclude");
      }
    }
  });

  it("separates advisory locks from the durable trees they protect (#8006)", () => {
    const runtimePaths = new Map([
      ["runtime/cron/.tick.lock", "cron-tick-lock"],
      ["runtime/cron/.jobs.lock", "cron-jobs-lock"],
      ["runtime/cron/ticker_heartbeat", "cron-ticker-heartbeat"],
      ["runtime/cron/ticker_last_success", "cron-ticker-last-success"],
      ["memories/MEMORY.md.lock", "memory-document-lock"],
      ["memories/USER.md.lock", "user-document-lock"],
      ["runtime/skill-usage.json.lock", "skill-usage-lock"],
      ["kanban/.dispatcher.lock", "kanban-dispatcher-lock"],
      ["shell-hooks-allowlist.json.lock", "shell-hook-allowlist-lock"],
      [".sync.lock", "environment-sync-lock"],
      [".clean_shutdown", "clean-shutdown-marker"],
      [".restart_pending.json", "restart-pending"],
      [".restart_failure_counts", "restart-failure-counts"],
    ] as const);

    for (const home of ["/sandbox/.hermes", "/sandbox/.hermes/profiles/research"] as const) {
      for (const [relativePath, id] of runtimePaths) {
        expect(
          findHermesManagedArtifact(home + "/" + relativePath)?.artifact,
          relativePath,
        ).toMatchObject({
          id,
          artifactClass: "mutable-runtime-state",
          backup: "exclude",
          restore: "discard",
          shields: "keep-writable",
        });
      }
    }

    expect(
      findHermesManagedArtifact("/sandbox/.hermes/runtime/skills-prompt-snapshot.json"),
    ).toMatchObject({
      artifact: {
        id: "skills-prompt-snapshot",
        artifactClass: "derived-disposable-state",
        backup: "exclude",
        restore: "discard",
        migration: "discard",
      },
      pathRole: "target",
    });
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/.skills_prompt_snapshot.json"),
    ).toMatchObject({
      artifact: { id: "skills-prompt-snapshot" },
      pathRole: "migration-source",
    });

    for (const [relativePath, id] of [
      ["cron/.tick.lock", "cron-tick-lock"],
      ["cron/.jobs.lock", "cron-jobs-lock"],
      ["cron/ticker_heartbeat", "cron-ticker-heartbeat"],
      ["cron/ticker_last_success", "cron-ticker-last-success"],
    ] as const) {
      const source = findHermesManagedArtifact("/sandbox/.hermes/" + relativePath);
      expect(source?.artifact.id).toBe(id);
      expect(source?.pathRole).toBe("migration-source");
      expect(source?.artifact.migrationSources).toContainEqual({
        relativePath,
        match: "exact",
        action: "discard",
      });
    }

    for (const [id, relativePath, durablePath] of [
      ["cron-definitions-root", ".tick.lock", "jobs.json"],
      ["memories", "MEMORY.md.lock", "notes.json"],
      ["skills", ".usage.json.lock", "reviewer/SKILL.md"],
      ["kanban-state", ".dispatcher.lock", "current"],
    ] as const) {
      const backup = resolveHermesArtifactBackup(artifact(id), { kind: "default" });
      expect(resolveHermesBackupAction(backup, relativePath), id).toBe("exclude");
      expect(resolveHermesBackupAction(backup, durablePath), id).toBe("file");
    }

    for (const id of [
      "cron-job-runtime-state",
      "cron-suggestions",
      "cron-output",
      "skill-usage-state",
    ] as const) {
      expect(artifact(id)).toMatchObject({
        artifactClass: "durable-state",
        shields: "keep-writable",
        restore: "restore",
        migration: "preserve",
      });
    }
    expect(artifact("cron-job-definitions")).toMatchObject({
      artifactClass: "protected-configuration",
      shields: "seal",
      backup: "file",
      restore: "restore",
      migration: "preserve",
    });
    expect(findHermesManagedArtifact("/sandbox/.hermes/skills/.usage.json")).toMatchObject({
      artifact: { id: "skill-usage-state" },
      pathRole: "migration-source",
    });
  });
});
