// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CONFIDENTIALITY_STATE_DIRS, HIGH_RISK_STATE_DIRS } from "../shields/state-dir-lock";
import { loadAgent } from "./defs";
import {
  findHermesManagedArtifact,
  HERMES_CONTRACT_GAPS,
  HERMES_LEGACY_MIGRATION,
  HERMES_MANAGED_ARTIFACTS,
  type HermesManagedArtifact,
  type HermesPostureRequirement,
  resolveHermesArtifactBackup,
  resolveHermesArtifactPath,
  resolveHermesBackupAction,
  resolveHermesIdentities,
  resolveHermesPosture,
} from "./hermes-path-ownership";

const TOPOLOGIES = ["root-separated", "same-uid"] as const;

function expectArtifact(
  result: HermesManagedArtifact | undefined,
  message: string,
): HermesManagedArtifact {
  expect(result, message).toBeDefined();
  return result as HermesManagedArtifact;
}

function artifact(id: string): HermesManagedArtifact {
  return expectArtifact(
    HERMES_MANAGED_ARTIFACTS.find((candidate) => candidate.id === id),
    "Missing Hermes artifact '" + id + "'",
  );
}

function expectRestoredPosture(
  requirement: HermesPostureRequirement | "absent",
  message: string,
): HermesPostureRequirement {
  expect(requirement, message).not.toBe("absent");
  return requirement as HermesPostureRequirement;
}

function topLevelPath(artifactRule: HermesManagedArtifact): string | null {
  const relativePath =
    typeof artifactRule.relativePath === "string"
      ? artifactRule.relativePath
      : artifactRule.relativePath.default;
  return relativePath === "." || relativePath.includes("/") ? null : relativePath;
}

function materializePathPattern(pathPattern: string): string {
  return pathPattern.replace(/\{[^/{}]+\}/gu, "sample");
}

describe("Hermes path ownership lifecycle contract", () => {
  it("keeps Curator state writable without exposing protected skill transitions (#8006)", () => {
    for (const id of ["curator-state", "curator-recovery"] as const) {
      expect(artifact(id)).toMatchObject({
        artifactClass: "durable-state",
        shields: "keep-writable",
        restore: "restore",
        migration: "preserve",
      });
    }
    expect(artifact("curator-state").backup).toBe("file");
    expect(artifact("curator-recovery").backup).toBe("directory");

    for (const id of ["curator-archive", "curator-suppression"] as const) {
      expect(artifact(id)).toMatchObject({
        artifactClass: "protected-configuration",
        shields: "seal",
        restore: "restore",
        migration: "preserve",
      });
      expect(artifact(id).required.shields).toBeDefined();
    }

    expect(findHermesManagedArtifact("/sandbox/.hermes/skills/.curator_state")).toMatchObject({
      artifact: { id: "curator-state" },
      pathRole: "migration-source",
    });
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/skills/.curator_backups/snapshot/skills.tar.gz"),
    ).toMatchObject({
      artifact: { id: "curator-recovery" },
      pathRole: "migration-source",
    });
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/skills/.archive/reviewer/SKILL.md"),
    ).toMatchObject({
      artifact: { id: "curator-archive" },
      pathRole: "target",
    });
  });

  it("preserves supported gateway preferences and authorization state (#8006)", () => {
    for (const id of ["discord-thread-state", "gateway-voice-mode"] as const) {
      expect(artifact(id)).toMatchObject({
        artifactClass: "durable-state",
        backup: "file",
        restore: "restore",
        migration: "preserve",
      });
      expect(resolveHermesPosture(artifact(id).required.create, "root-separated")).toMatchObject({
        owner: "gateway",
        group: "sandbox",
        mode: "0600",
      });
    }
    expect(artifact("shell-hook-allowlist")).toMatchObject({
      artifactClass: "protected-configuration",
      backup: "file",
      restore: "restore",
      migration: "preserve",
      shields: "seal",
    });
    expect(
      resolveHermesPosture(
        artifact("shell-hook-allowlist").required.create,
        "root-separated",
        "gateway",
      ),
    ).toMatchObject({ owner: "gateway", group: "sandbox", mode: "0660" });
    expect(
      resolveHermesPosture(artifact("shell-hook-allowlist").required.shields!.up, "root-separated"),
    ).toMatchObject({ owner: "root", group: "root", mode: "0444" });

    for (const home of ["/sandbox/.hermes", "/sandbox/.hermes/profiles/research"] as const) {
      expect(findHermesManagedArtifact(home + "/discord_threads.json")?.artifact.id).toBe(
        "discord-thread-state",
      );
      expect(findHermesManagedArtifact(home + "/gateway_voice_mode.json")?.artifact.id).toBe(
        "gateway-voice-mode",
      );
      expect(findHermesManagedArtifact(home + "/shell-hooks-allowlist.json")?.artifact.id).toBe(
        "shell-hook-allowlist",
      );
    }
  });

  it("backs up pairing grants without transient requests or throttling state (#8006)", () => {
    const backup = resolveHermesArtifactBackup(artifact("pairing-state"), { kind: "default" });
    expect(artifact("pairing-state").presence).toBe("required");
    expect(resolveHermesBackupAction(backup, "slack-approved.json")).toBe("file");
    expect(resolveHermesBackupAction(backup, "slack-pending.json")).toBe("exclude");
    expect(resolveHermesBackupAction(backup, "_rate_limits.json")).toBe("exclude");
    expect(resolveHermesBackupAction(backup, "tmpabc123.tmp")).toBe("exclude");

    const approved = artifact("pairing-approved");
    expect(approved).toMatchObject({
      artifactClass: "protected-configuration",
      producers: ["root"],
      shields: "seal",
      backup: "file",
      restore: "restore",
      migration: "preserve",
    });
    expect(resolveHermesPosture(approved.required.shields!.up, "root-separated")).toEqual({
      kind: "path",
      owner: "root",
      group: "root",
      mode: "0444",
    });

    for (const id of ["pairing-pending", "pairing-rate-limits"] as const) {
      const runtime = artifact(id);
      expect(runtime).toMatchObject({
        artifactClass: "mutable-runtime-state",
        backup: "exclude",
        restore: "discard",
        migration: "discard",
      });
      expect(resolveHermesIdentities(runtime.producers, "root-separated")).toEqual(["gateway"]);
      expect(resolveHermesIdentities(runtime.readers, "root-separated")).toEqual(["gateway"]);
      expect(resolveHermesPosture(runtime.required.create, "root-separated")).toMatchObject({
        owner: "gateway",
        mode: "0600",
      });
    }
    expect(artifact("pairing-write-staging")).toMatchObject({
      artifactClass: "derived-disposable-state",
      backup: "exclude",
      restore: "discard",
      migration: "discard",
    });

    for (const [id, relativePath] of [
      ["pairing-approved-write-staging", "pairing/tmpabc123.tmp"],
      ["feishu-comment-pairing-write-staging", "feishu_comment_pairing.tmp"],
    ] as const) {
      const staging = artifact(id);
      expect(staging).toMatchObject({
        artifactClass: "derived-disposable-state",
        producers: ["root"],
        readers: ["root"],
        shields: "unchanged",
        backup: "exclude",
        restore: "discard",
        migration: "discard",
      });
      expect(resolveHermesPosture(staging.required.create, "root-separated")).toEqual({
        kind: "path",
        owner: "root",
        group: "root",
        mode: "0600",
      });
      for (const home of ["/sandbox/.hermes", "/sandbox/.hermes/profiles/research"] as const) {
        expect(findHermesManagedArtifact(home + "/" + relativePath)).toMatchObject({
          artifact: { id },
          pathRole: "target",
        });
      }
    }

    for (const home of ["/sandbox/.hermes", "/sandbox/.hermes/profiles/research"] as const) {
      expect(findHermesManagedArtifact(home + "/pairing/slack-approved.json")).toMatchObject({
        artifact: { id: "pairing-approved" },
        pathRole: "target",
      });
      expect(
        findHermesManagedArtifact(home + "/platforms/pairing/slack-approved.json"),
      ).toMatchObject({ artifact: { id: "pairing-approved" }, pathRole: "migration-source" });
      for (const [relativePath, id] of [
        ["runtime/pairing/slack-pending.json", "pairing-pending"],
        ["runtime/pairing/_rate_limits.json", "pairing-rate-limits"],
        ["runtime/pairing/tmpabc123.tmp", "pairing-write-staging"],
      ] as const) {
        expect(findHermesManagedArtifact(home + "/" + relativePath)).toMatchObject({
          artifact: { id },
          pathRole: "target",
        });
      }
      for (const oldRoot of ["pairing", "platforms/pairing"] as const) {
        expect(
          findHermesManagedArtifact(home + "/" + oldRoot + "/slack-pending.json"),
        ).toMatchObject({ artifact: { id: "pairing-pending" }, pathRole: "migration-source" });
      }
    }

    const platformsBackup = resolveHermesArtifactBackup(artifact("platform-state"), {
      kind: "default",
    });
    expect(resolveHermesBackupAction(platformsBackup, "pairing/slack-approved.json")).toBe(
      "exclude",
    );
    expect(resolveHermesBackupAction(platformsBackup, "pairing/slack-pending.json")).toBe(
      "exclude",
    );
    expect(resolveHermesBackupAction(platformsBackup, "pairing/_rate_limits.json")).toBe("exclude");
    expect(resolveHermesBackupAction(platformsBackup, "pairing/tmpabc123.tmp")).toBe("exclude");
  });

  it("records the writable-runtime roots that the current Shields inventory still seals (#8006)", () => {
    const sealedDirectoryRoots = HERMES_MANAGED_ARTIFACTS.filter(
      (entry) => entry.kind === "directory" && entry.shields === "seal",
    )
      .map(topLevelPath)
      .filter((entry): entry is string => entry !== null);

    expect(
      sealedDirectoryRoots.filter((entry) => HIGH_RISK_STATE_DIRS.includes(entry)).sort(),
    ).toEqual(["cron", "hooks", "plugins", "profiles", "skills", "skins", "workspace"]);
    expect(
      sealedDirectoryRoots.filter((entry) => CONFIDENTIALITY_STATE_DIRS.includes(entry)),
    ).toEqual(["pairing"]);

    const writableDirectoryRoots = new Set(
      HERMES_MANAGED_ARTIFACTS.filter(
        (entry) => entry.kind === "directory" && entry.shields === "keep-writable",
      )
        .map(topLevelPath)
        .filter((entry): entry is string => entry !== null),
    );
    expect(HIGH_RISK_STATE_DIRS.filter((entry) => writableDirectoryRoots.has(entry))).toEqual([
      "whatsapp",
      "platforms",
      "weixin",
    ]);
    expect(CONFIDENTIALITY_STATE_DIRS.filter((entry) => writableDirectoryRoots.has(entry))).toEqual(
      [],
    );
  });

  it("keeps gateway-produced live state writable in the target contract (#8006)", () => {
    for (const [id, artifactClass] of [
      ["tool-home", "mutable-runtime-state"],
      ["kanban-state", "durable-state"],
    ] as const) {
      const entry = artifact(id);
      expect(entry.artifactClass, id).toBe(artifactClass);
      expect(entry.shields, id).toBe("keep-writable");
      expect(entry.required.shields, id).toBeUndefined();
      expect(resolveHermesIdentities(entry.producers, "root-separated"), id).toContain("gateway");
      expect(resolveHermesIdentities(entry.readers, "root-separated"), id).toContain("gateway");
      expect(
        resolveHermesPosture(entry.required.create, "root-separated", "gateway"),
        id,
      ).toMatchObject({
        kind: "tree",
        descendantOwner: "gateway",
        group: "sandbox",
        fileMode: "g+rwX,o-rwx",
      });
    }

    for (const id of [
      "pairing-runtime-state",
      "whatsapp-session",
      "legacy-whatsapp-session",
    ] as const) {
      const entry = artifact(id);
      expect(entry.shields, id).toBe("keep-writable");
      expect(entry.backup, id).toBe("exclude");
      expect(entry.restore, id).toBe("discard");
      expect(entry.required.restore, id).toBe("absent");
      expect(resolveHermesIdentities(entry.producers, "root-separated"), id).toEqual(["gateway"]);
      expect(resolveHermesIdentities(entry.readers, "root-separated"), id).toEqual(["gateway"]);
      expect(resolveHermesPosture(entry.required.create, "root-separated"), id).toMatchObject({
        kind: "tree",
        owner: "gateway",
        descendantOwner: "gateway",
        directoryMode: "0700",
        fileMode: "u-only",
      });
      expect(resolveHermesIdentities(entry.producers, "same-uid"), id).toEqual(["sandbox"]);
      expect(resolveHermesPosture(entry.required.create, "same-uid"), id).toMatchObject({
        kind: "tree",
        owner: "sandbox",
        descendantOwner: "sandbox",
        directoryMode: "0700",
        fileMode: "0600",
      });
    }

    expect(
      resolveHermesPosture(artifact("weixin-accounts").required.create, "root-separated"),
    ).toMatchObject({
      kind: "tree",
      owner: "sandbox",
      descendantOwner: "preserve",
      group: "sandbox",
      directoryMode: "02770",
      fileMode: "preserve",
    });

    expect(artifact("feishu-comment-pairing")).toMatchObject({
      presence: "required",
      artifactClass: "protected-configuration",
      producers: ["root"],
      shields: "seal",
      backup: "file",
      restore: "restore",
    });
    expect(
      resolveHermesPosture(
        artifact("feishu-comment-pairing").required.shields!.up,
        "root-separated",
      ),
    ).toMatchObject({ owner: "root", group: "root", mode: "0444" });
    expect(
      resolveHermesPosture(artifact("feishu-comment-rules").required.shields!.up, "root-separated"),
    ).toMatchObject({ owner: "root", group: "root", mode: "0444" });
  });

  it("protects private children from writable ancestor replacement (#8006)", () => {
    const home = artifact("agent-home-root");
    const restoredHome = expectRestoredPosture(
      home.required.restore,
      "Hermes home must exist after restore",
    );
    for (const posture of [
      home.required.create,
      restoredHome,
      home.required.shields!.up,
      home.required.shields!.down,
    ]) {
      expect(resolveHermesPosture(posture, "root-separated")).toEqual({
        kind: "path",
        owner: "root",
        group: "sandbox",
        mode: "03770",
      });
    }

    for (const id of ["platform-state", "whatsapp-platform", "legacy-whatsapp-platform"] as const) {
      expect(
        resolveHermesPosture(artifact(id).required.create, "root-separated", "gateway"),
        id,
      ).toMatchObject({
        kind: "tree",
        owner: "root",
        directoryMode: "03770",
      });
    }

    expect(
      resolveHermesPosture(
        artifact("runtime-directory").required.create,
        "root-separated",
        "gateway",
      ),
    ).toMatchObject({
      kind: "tree",
      owner: "gateway",
      directoryMode: "03770",
    });
    expect(
      resolveHermesPosture(artifact("pairing-state").required.create, "root-separated"),
    ).toMatchObject({
      kind: "tree",
      owner: "root",
      descendantOwner: "root",
      directoryMode: "0755",
    });

    for (const [target, id, mode] of [
      ["/sandbox/.hermes/platforms/whatsapp/session/creds.json", "whatsapp-session", "0700"],
      ["/sandbox/.hermes/runtime/pairing/slack-pending.json", "pairing-pending", "0600"],
      ["/sandbox/.hermes/pairing/slack-approved.json", "pairing-approved", "0444"],
    ] as const) {
      const resolved = expectArtifact(
        findHermesManagedArtifact(target)?.artifact,
        "Missing Hermes artifact for '" + target + "'",
      );
      expect(resolved.id, target).toBe(id);
      const posture = resolveHermesPosture(resolved.required.create, "root-separated", "gateway");
      expect(posture.kind === "tree" ? posture.directoryMode : posture.mode, target).toBe(mode);
    }
  });

  it("separates Weixin credentials, durable context, and runtime cursors (#8006)", () => {
    const contextTokens = findHermesManagedArtifact(
      "/sandbox/.hermes/weixin/accounts/primary.context-tokens.json",
    )?.artifact;
    const syncCursor = findHermesManagedArtifact(
      "/sandbox/.hermes/weixin/accounts/primary.sync.json",
    )?.artifact;

    expect(findHermesManagedArtifact("/sandbox/.hermes/weixin/accounts/primary.json")).toBeNull();
    expect(contextTokens?.id).toBe("weixin-context-tokens");
    expect(syncCursor?.id).toBe("weixin-sync-cursor");
    expect(
      findHermesManagedArtifact(
        "/sandbox/.hermes/profiles/research/weixin/accounts/primary.context-tokens.json",
      )?.artifact.id,
    ).toBe("weixin-context-tokens");

    expect(contextTokens).toMatchObject({
      artifactClass: "durable-state",
      backup: "file",
      restore: "restore",
      migration: "preserve",
    });
    expect(
      resolveHermesPosture(contextTokens!.required.create, "root-separated", "gateway"),
    ).toMatchObject({ owner: "gateway", group: "sandbox", mode: "0600" });
    const restoredContextTokens = expectRestoredPosture(
      contextTokens!.required.restore,
      "Weixin context must restore",
    );
    expect(resolveHermesPosture(restoredContextTokens, "root-separated")).toMatchObject({
      owner: "gateway",
      group: "sandbox",
      mode: "0600",
    });

    expect(syncCursor).toMatchObject({
      artifactClass: "mutable-runtime-state",
      backup: "exclude",
      restore: "discard",
      migration: "preserve",
    });
    expect(resolveHermesPosture(syncCursor!.required.create, "root-separated")).toMatchObject({
      owner: "gateway",
      group: "sandbox",
      mode: "0600",
    });

    const weixinBackup = resolveHermesArtifactBackup(artifact("weixin-state"), {
      kind: "default",
    });
    expect(resolveHermesBackupAction(weixinBackup, "accounts/primary.json")).toBe("exclude");
    expect(resolveHermesBackupAction(weixinBackup, "accounts/primary.context-tokens.json")).toBe(
      "file",
    );
    expect(resolveHermesBackupAction(weixinBackup, "accounts/primary.sync.json")).toBe("exclude");
    expect(resolveHermesBackupAction(weixinBackup, "accounts/unknown.tmp")).toBe("exclude");
  });

  it("seals LSP installs while keeping PowerShell sessions writable (#8006)", () => {
    const powershellRuntime = artifact("lsp-powershell-runtime");
    expect(powershellRuntime).toMatchObject({
      shields: "keep-writable",
      backup: "exclude",
      restore: "regenerate",
      migration: "discard",
    });
    expect(resolveHermesIdentities(powershellRuntime.producers, "root-separated")).toEqual([
      "sandbox",
      "gateway",
    ]);
    const restoreRequirement = expectRestoredPosture(
      powershellRuntime.required.restore,
      "PowerShell runtime must be recreated",
    );
    for (const topology of TOPOLOGIES) {
      expect(resolveHermesPosture(restoreRequirement, topology), topology).toMatchObject({
        owner: "sandbox",
        descendantOwner: "sandbox",
        group: "sandbox",
        directoryMode: "02770",
      });
    }

    for (const home of ["/sandbox/.hermes", "/sandbox/.hermes/profiles/research"] as const) {
      for (const relativePath of [
        "lsp/bin/pyright",
        "lsp/node_modules/pyright/package.json",
        "lsp/python-packages/pyright/__init__.py",
        "lsp/package-lock.json",
      ]) {
        expect(findHermesManagedArtifact(home + "/" + relativePath)?.artifact).toMatchObject({
          id: "lsp-cache",
          artifactClass: "derived-disposable-state",
          backup: "exclude",
          restore: "regenerate",
          shields: "seal",
        });
      }
      for (const relativePath of ["lsp/pses/pses-session-42.json", "lsp/pses/pses.log"]) {
        expect(findHermesManagedArtifact(home + "/" + relativePath)?.artifact).toMatchObject({
          id: "lsp-powershell-runtime",
          artifactClass: "mutable-runtime-state",
          backup: "exclude",
          restore: "regenerate",
        });
      }
    }
    expect(findHermesManagedArtifact("/sandbox/.hermes/bin/tirith")?.artifact.id).toBe(
      "tirith-binary",
    );
  });

  it("classifies oversized hook output spill files as disposable (#8006)", () => {
    for (const home of ["/sandbox/.hermes", "/sandbox/.hermes/profiles/research"] as const) {
      expect(
        findHermesManagedArtifact(home + "/hook_outputs/session/1234.txt")?.artifact,
      ).toMatchObject({
        id: "hook-output-spill",
        artifactClass: "derived-disposable-state",
        backup: "exclude",
        restore: "regenerate",
        migration: "regenerate",
        shields: "keep-writable",
      });
    }
  });

  it("keeps supported model metadata caches disposable in every UI home (#8006)", () => {
    for (const [id, relativePath] of [
      ["context-length-cache", "context_length_cache.yaml"],
      ["models-dev-cache", "models_dev_cache.json"],
      ["ollama-cloud-models-cache", "ollama_cloud_models_cache.json"],
    ] as const) {
      for (const home of [
        { kind: "default" },
        { kind: "named-profile", name: "research" },
      ] as const) {
        expect(
          findHermesManagedArtifact(resolveHermesArtifactPath(artifact(id), home)),
        ).toMatchObject({
          artifact: {
            id,
            artifactClass: "derived-disposable-state",
            backup: "exclude",
            restore: "discard",
            migration: "discard",
          },
          pathRole: "target",
        });
      }

      const dashboardId = "dashboard-" + id;
      expect(
        findHermesManagedArtifact(
          resolveHermesArtifactPath(artifact(dashboardId), { kind: "dashboard" }),
        ),
      ).toMatchObject({
        artifact: {
          id: dashboardId,
          artifactClass: "derived-disposable-state",
          backup: "exclude",
          restore: "discard",
          migration: "discard",
        },
        pathRole: "target",
      });

      expect(resolveHermesArtifactPath(artifact(id), { kind: "default" })).toBe(
        "/sandbox/.hermes/" + relativePath,
      );
    }

    expect(findHermesManagedArtifact("/sandbox/.hermes/.anthropic_oauth.json")).toBeNull();
    expect(findHermesManagedArtifact("/sandbox/.hermes/provider_models_cache.json")).toBeNull();
  });

  it("excludes raw WhatsApp session credentials from ordinary backups (#8006)", () => {
    const platformBackup = resolveHermesArtifactBackup(artifact("platform-state"), {
      kind: "default",
    });
    const preferredBackup = resolveHermesArtifactBackup(artifact("whatsapp-platform"), {
      kind: "default",
    });
    const legacyBackup = resolveHermesArtifactBackup(artifact("legacy-whatsapp-platform"), {
      kind: "default",
    });

    expect(resolveHermesBackupAction(platformBackup, "pairing/slack-approved.json")).toBe(
      "exclude",
    );
    expect(resolveHermesBackupAction(platformBackup, "whatsapp/session/creds.json")).toBe(
      "exclude",
    );
    expect(
      resolveHermesBackupAction(platformBackup, "whatsapp/session/app-state-sync-key/key-1.json"),
    ).toBe("exclude");
    expect(resolveHermesBackupAction(platformBackup, "whatsapp/bridge.log")).toBe("exclude");
    expect(resolveHermesBackupAction(platformBackup, "whatsapp/session/bridge.pid")).toBe(
      "exclude",
    );
    expect(resolveHermesBackupAction(preferredBackup, "session/creds.json")).toBe("exclude");
    expect(
      resolveHermesBackupAction(preferredBackup, "session/app-state-sync-key/key-1.json"),
    ).toBe("exclude");
    expect(resolveHermesBackupAction(preferredBackup, "bridge.log")).toBe("exclude");
    expect(resolveHermesBackupAction(legacyBackup, "session/bridge.pid")).toBe("exclude");
    expect(resolveHermesBackupAction(legacyBackup, "session/creds.json")).toBe("exclude");

    for (const id of ["whatsapp-session", "legacy-whatsapp-session"] as const) {
      expect(artifact(id)).toMatchObject({
        artifactClass: "credential-reference",
        backup: "exclude",
        restore: "discard",
        migration: "preserve",
      });
      expect(artifact(id).required.restore).toBe("absent");
      expect(resolveHermesIdentities(artifact(id).producers, "root-separated")).toEqual([
        "gateway",
      ]);
      expect(resolveHermesIdentities(artifact(id).readers, "root-separated")).toEqual(["gateway"]);
    }

    for (const home of ["/sandbox/.hermes", "/sandbox/.hermes/profiles/research"] as const) {
      for (const [root, id] of [
        ["platforms/whatsapp/session", "whatsapp-session"],
        ["whatsapp/session", "legacy-whatsapp-session"],
      ] as const) {
        for (const relativePath of ["creds.json", "app-state-sync-key/key-1.json"] as const) {
          expect(
            findHermesManagedArtifact(home + "/" + root + "/" + relativePath)?.artifact.id,
            root + "/" + relativePath,
          ).toBe(id);
        }
      }
    }

    for (const [target, id] of [
      ["/sandbox/.hermes/platforms/whatsapp/bridge.log", "whatsapp-bridge-log"],
      ["/sandbox/.hermes/platforms/whatsapp/session/bridge.pid", "whatsapp-bridge-pid"],
      ["/sandbox/.hermes/whatsapp/bridge.log", "legacy-whatsapp-bridge-log"],
      ["/sandbox/.hermes/whatsapp/session/bridge.pid", "legacy-whatsapp-bridge-pid"],
    ] as const) {
      expect(findHermesManagedArtifact(target)?.artifact, target).toMatchObject({
        id,
        backup: "exclude",
        restore: "discard",
        migration: "discard",
      });
    }
  });

  it("excludes interrupted session staging writes from durable backups (#8006)", () => {
    const backup = resolveHermesArtifactBackup(artifact("sessions"), { kind: "default" });
    expect(resolveHermesBackupAction(backup, "sessions.json")).toBe("file");
    expect(resolveHermesBackupAction(backup, "history/conversation.json")).toBe("file");
    expect(resolveHermesBackupAction(backup, ".sessions_abc123.tmp")).toBe("exclude");

    for (const home of ["/sandbox/.hermes", "/sandbox/.hermes/profiles/research"] as const) {
      expect(
        findHermesManagedArtifact(home + "/sessions/.sessions_abc123.tmp")?.artifact,
      ).toMatchObject({
        id: "sessions-write-staging",
        artifactClass: "derived-disposable-state",
        backup: "exclude",
        restore: "discard",
        migration: "discard",
      });
    }
  });

  it("excludes crash-residual atomic staging files from durable state (#8006)", () => {
    for (const [parentId, relativePath] of [
      ["memories", ".mem_abc123.tmp"],
      ["skills", ".usage_abc123.tmp"],
      ["skills", "..curator_state_abc123.tmp"],
      ["skills", ".curator_suppressed_abc123.tmp"],
      ["skills", ".bundled_manifest_abc123.tmp"],
      ["skills", ".lock_abc123.tmp"],
      ["skills", ".hub/.lock_abc123.tmp"],
      ["skills", ".SKILL.md.tmp.abc123"],
      ["skills", "reviewer/.SKILL.md.tmp.abc123"],
      ["skills", "reviewer/references/.notes.md.tmp.abc123"],
      ["cron-definitions-root", ".jobs_abc123.tmp"],
      ["cron-definitions-root", ".sugg_abc123.tmp"],
      ["cron-definitions-root", ".hb_abc123.tmp"],
      ["cron-definitions-root", "output/job/.output_abc123.tmp"],
    ] as const) {
      const backup = resolveHermesArtifactBackup(artifact(parentId), { kind: "default" });
      expect(resolveHermesBackupAction(backup, relativePath), parentId + ":" + relativePath).toBe(
        "exclude",
      );
    }

    const stagingPaths = [
      [".processes_abc123.tmp", "top-level-atomic-staging", "keep-writable"],
      ["..restart_notify_abc123.tmp", "top-level-atomic-staging", "keep-writable"],
      ["..restart_last_processed_abc123.tmp", "top-level-atomic-staging", "keep-writable"],
      ["..restart_pending_abc123.tmp", "top-level-atomic-staging", "keep-writable"],
      ["..restart_failure_counts_abc123.tmp", "top-level-atomic-staging", "keep-writable"],
      ["..drain_request_abc123.tmp", "top-level-atomic-staging", "keep-writable"],
      [".discord_threads_abc123.tmp", "top-level-atomic-staging", "keep-writable"],
      ["tmpabc123.tmp", "top-level-temporary-staging", "keep-writable"],
      [".config.yaml.nemoclaw.1234.0123456789abcdef", "nemoclaw-protected-write-staging", "seal"],
      ["auth.json.tmp.1234.0123456789abcdef", "authentication-write-staging", "keep-writable"],
      ["gateway-starts.tmp", "gateway-start-ledger-write-staging", "keep-writable"],
      ["memories/.mem_abc123.tmp", "memory-write-staging", "keep-writable"],
      ["skills/.usage_abc123.tmp", "skills-write-staging", "seal"],
      ["skills/..curator_state_abc123.tmp", "skills-write-staging", "seal"],
      ["skills/.curator_suppressed_abc123.tmp", "skills-write-staging", "seal"],
      ["skills/.bundled_manifest_abc123.tmp", "skills-write-staging", "seal"],
      ["skills/.lock_abc123.tmp", "skills-write-staging", "seal"],
      ["skills/.hub/.lock_abc123.tmp", "skills-hub-lock-staging", "seal"],
      ["skills/.SKILL.md.tmp.abc123", "skills-descendant-write-staging", "seal"],
      ["skills/reviewer/.SKILL.md.tmp.abc123", "skills-descendant-write-staging", "seal"],
      [
        "skills/reviewer/references/.notes.md.tmp.abc123",
        "skills-descendant-write-staging",
        "seal",
      ],
      ["shell-hooks-allowlist.json.abc123.tmp", "shell-hook-allowlist-write-staging", "seal"],
      ["cron/.jobs_abc123.tmp", "cron-write-staging", "seal"],
      ["cron/.sugg_abc123.tmp", "cron-write-staging", "seal"],
      ["cron/.hb_abc123.tmp", "cron-write-staging", "seal"],
      ["cron/output/job/.output_abc123.tmp", "cron-output-write-staging", "seal"],
      [
        "runtime/cron/output/job/.output_abc123.tmp",
        "runtime-cron-output-write-staging",
        "keep-writable",
      ],
    ] as const;

    for (const home of ["/sandbox/.hermes", "/sandbox/.hermes/profiles/research"] as const) {
      for (const [relativePath, id, shields] of stagingPaths) {
        const staging = findHermesManagedArtifact(home + "/" + relativePath)?.artifact;
        expect(staging, relativePath).toMatchObject({
          id,
          artifactClass: "derived-disposable-state",
          backup: "exclude",
          restore: "discard",
          migration: "discard",
        });
        expect(staging?.shields, relativePath).toBe(shields);
      }
    }

    expect(
      findHermesManagedArtifact("/sandbox/.hermes/active_profile.tmp")?.artifact,
    ).toMatchObject({
      id: "active-profile-write-staging",
      artifactClass: "derived-disposable-state",
      shields: "seal",
      backup: "exclude",
      restore: "discard",
      migration: "discard",
    });
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/dashboard-home/config.yaml.nemoclaw.tmp")
        ?.artifact,
    ).toMatchObject({
      id: "dashboard-config-write-staging",
      artifactClass: "derived-disposable-state",
      shields: "keep-writable",
      backup: "exclude",
      restore: "discard",
      migration: "discard",
    });
  });

  it("makes the Kanban selective backup contract executable (#8006)", () => {
    const backup = resolveHermesArtifactBackup(artifact("kanban-state"), { kind: "default" });
    const expectations = new Map([
      ["current", "file"],
      ["boards/release/kanban.db", "sqlite"],
      ["boards/release/kanban.db-wal", "exclude"],
      ["boards/release/kanban.db-shm", "exclude"],
      ["boards/release/kanban.db-journal", "exclude"],
      ["boards/release/kanban.db-future", "file"],
      ["boards/release/kanban.db.init.lock", "exclude"],
      ["boards/release/kanban.db.dispatch.lock", "exclude"],
      ["boards/release/kanban.db.corrupt.0123456789abcdef.bak", "file"],
      ["boards/release/kanban.db.corrupt.0123456789abcdef.bak-wal", "file"],
      ["boards/release/metadata.json", "file"],
      ["boards/release/workspaces/task/output.txt", "exclude"],
      ["attachments/task/design.png", "file"],
      ["boards/release/attachments/task/design.png", "file"],
      ["boards/_archived/release/kanban.db", "sqlite"],
      ["boards/_archived/release/kanban.db-wal", "exclude"],
      ["boards/_archived/release/kanban.db.init.lock", "exclude"],
      ["boards/_archived/release/kanban.db.corrupt.0123456789abcdef.bak", "file"],
      ["boards/_archived/release/metadata.json", "file"],
      ["boards/_archived/release/attachments/task/design.png", "file"],
      ["boards/_archived/release/logs/task.log", "exclude"],
      ["logs/task.log", "exclude"],
    ] as const);

    for (const [relativePath, action] of expectations) {
      expect(resolveHermesBackupAction(backup, relativePath), relativePath).toBe(action);
    }

    const contracts = new Map([
      ["kanban/current", "kanban-current"],
      ["kanban/attachments/task/design.png", "kanban-attachments"],
      ["kanban/boards/release/kanban.db", "kanban-board-database"],
      ["kanban/boards/release/kanban.db-wal", "kanban-board-database-sidecar-wal"],
      ["kanban/boards/release/kanban.db.init.lock", "kanban-board-lock"],
      ["kanban/boards/release/kanban.db.corrupt.0123456789abcdef.bak", "kanban-board-recovery"],
      ["kanban/boards/release/workspaces/task/output.txt", "kanban-board-workspaces"],
      ["kanban/boards/release/attachments/task/design.png", "kanban-board-attachments"],
      ["kanban/boards/release/logs/task.log", "kanban-board-logs"],
      ["kanban/boards/_archived/release/kanban.db", "archived-kanban-board-database"],
      [
        "kanban/boards/_archived/release/kanban.db-shm",
        "archived-kanban-board-database-sidecar-shm",
      ],
      ["kanban/boards/_archived/release/kanban.db.dispatch.lock", "archived-kanban-board-lock"],
      [
        "kanban/boards/_archived/release/kanban.db.corrupt.0123456789abcdef.bak-shm",
        "archived-kanban-board-recovery",
      ],
      [
        "kanban/boards/_archived/release/workspaces/task/output.txt",
        "archived-kanban-board-workspaces",
      ],
    ] as const);

    for (const home of ["/sandbox/.hermes", "/sandbox/.hermes/profiles/research"] as const) {
      for (const [relativePath, id] of contracts) {
        expect(
          findHermesManagedArtifact(home + "/" + relativePath)?.artifact.id,
          relativePath,
        ).toBe(id);
      }
    }
    expect(
      findHermesManagedArtifact(
        "/sandbox/.hermes/dashboard-home/kanban/boards/release/attachments/task/design.png",
      )?.artifact.id,
    ).toBe("dashboard-kanban-board-attachments");
    expect(findHermesManagedArtifact("/sandbox/.hermes/kanban.db.init.lock")?.artifact.id).toBe(
      "default-kanban-lock",
    );
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/kanban.db.corrupt.0123456789abcdef.bak-wal")
        ?.artifact.id,
    ).toBe("default-kanban-recovery");
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/dashboard-home/kanban.db.dispatch.lock")?.artifact
        .id,
    ).toBe("dashboard-default-kanban-lock");
    expect(
      findHermesManagedArtifact(
        "/sandbox/.hermes/dashboard-home/kanban.db.corrupt.0123456789abcdef.bak",
      )?.artifact.id,
    ).toBe("dashboard-default-kanban-recovery");
    expect(artifact("kanban-board-database")).toMatchObject({
      artifactClass: "durable-state",
      backup: "sqlite",
      restore: "restore",
    });
    expect(artifact("kanban-board-database-sidecar-wal")).toMatchObject({
      artifactClass: "derived-disposable-state",
      backup: "exclude",
      restore: "discard",
    });
    expect(artifact("kanban-board-lock")).toMatchObject({
      artifactClass: "mutable-runtime-state",
      backup: "exclude",
      restore: "discard",
      migration: "discard",
    });
    expect(artifact("kanban-board-recovery")).toMatchObject({
      artifactClass: "durable-state",
      backup: "file",
      restore: "restore",
      migration: "preserve",
    });
    expect(artifact("archived-kanban-board-workspaces")).toMatchObject({
      artifactClass: "derived-disposable-state",
      backup: "exclude",
      restore: "regenerate",
    });
    expect(artifact("archived-kanban-board-attachments")).toMatchObject({
      artifactClass: "durable-state",
      backup: "directory",
      restore: "restore",
      migration: "preserve",
    });
  });

  it("rejects equally specific selective backup rules (#8006)", () => {
    expect(() =>
      resolveHermesBackupAction(
        {
          kind: "selective",
          fallback: "exclude",
          selectors: [
            { relativePattern: "{first}.json", action: "file" },
            { relativePattern: "{second}.json", action: "exclude" },
          ],
        },
        "state.json",
      ),
    ).toThrow("Ambiguous Hermes selective backup contract");
  });

  it("prefers constrained backup rules over recursive fallbacks (#8006)", () => {
    const backup = {
      kind: "selective",
      fallback: "exclude",
      selectors: [
        { relativePattern: "skills/{name}", action: "exclude" },
        { relativePattern: "skills/**/{name}", action: "file" },
      ],
    } as const;

    expect(resolveHermesBackupAction(backup, "skills/reviewer")).toBe("exclude");
    expect(resolveHermesBackupAction(backup, "skills/nested/reviewer")).toBe("file");
  });

  it("matches repeated recursive segments without combinatorial backtracking (#8006)", () => {
    expect(
      resolveHermesBackupAction(
        {
          kind: "selective",
          fallback: "exclude",
          selectors: [
            {
              relativePattern: "**/**/**/**/**/**/**/**/**/**/expected",
              action: "file",
            },
          ],
        },
        "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/other",
      ),
    ).toBe("exclude");
  });

  it("rejects parent traversal in backup candidates and selectors (#8006)", () => {
    expect(() => resolveHermesBackupAction("file", "../secret")).toThrow("parent traversal");
    expect(() => resolveHermesBackupAction("file", "secret/")).toThrow("canonical relative path");
    expect(() =>
      resolveHermesBackupAction(
        {
          kind: "selective",
          fallback: "exclude",
          selectors: [{ relativePattern: "../{file}", action: "file" }],
        },
        "secret",
      ),
    ).toThrow("parent traversal");
  });

  it("records current manifest gaps separately from the target backup contract (#8006)", () => {
    const hermes = loadAgent("hermes");
    expect([...hermes.stateDirs].sort()).toEqual(
      [
        "memories",
        "sessions",
        "skills",
        "plugins",
        "cron",
        "logs",
        "skins",
        "plans",
        "workspace",
        "profiles",
        "cache",
        "pairing",
        "dashboard-home",
        "platforms",
        "weixin",
      ].sort(),
    );
    expect(
      [...hermes.stateFiles].sort((left, right) => left.path.localeCompare(right.path)),
    ).toEqual(
      [
        { path: "SOUL.md", strategy: "copy" },
        { path: ".hermes_history", strategy: "copy" },
        { path: "runtime/state.db", strategy: "sqlite_backup" },
        { path: "runtime/cron-executions.db", strategy: "sqlite_backup" },
        { path: "gateway/discord_message_recovery.db", strategy: "sqlite_backup" },
        { path: "kanban.db", strategy: "sqlite_backup" },
      ].sort((left, right) => left.path.localeCompare(right.path)),
    );

    expect(artifact("soul").backup).toBe("file");
    expect(artifact("tui-history").backup).toBe("file");
    expect(artifact("main-state-database").backup).toBe("sqlite");
    expect(artifact("response-store-database").backup).toBe("sqlite");
    expect(artifact("verification-evidence-database").backup).toBe("sqlite");
    expect(artifact("channel-aliases").backup).toBe("file");
    expect(artifact("discord-thread-state").backup).toBe("file");
    expect(artifact("gateway-voice-mode").backup).toBe("file");
    expect(artifact("shell-hook-allowlist").backup).toBe("file");
    expect(artifact("logs").backup).toBe("exclude");
    expect(artifact("cache").backup).toBe("exclude");
    expect(artifact("profiles-root").backup).toBe("exclude");
    expect(artifact("nemoclaw-plugin").backup).toBe("exclude");
    expect(artifact("dashboard-home").backup).toBe("exclude");
    expect(artifact("dashboard-memory").backup).toBe("file");
    expect(artifact("dashboard-user").backup).toBe("file");
    expect(artifact("dashboard-config").backup).toBe("exclude");
    expect(artifact("dashboard-status").restore).toBe("discard");
    expect(artifact("kanban-state").backup).toMatchObject({ kind: "selective" });
  });

  it("records migration retention and privileged transition gaps (#8006)", () => {
    expect(HERMES_LEGACY_MIGRATION).toEqual({
      source: "/sandbox/.hermes-data",
      destination: "/sandbox/.hermes",
      failure: {
        required: "retain-source",
        knownGap: "source-removal-precedes-final-validation",
      },
    });
    const gapIds = HERMES_CONTRACT_GAPS.map((gap) => gap.id);
    expect(new Set(gapIds).size).toBe(gapIds.length);
    expect(new Set(gapIds)).toEqual(
      new Set([
        "cron-jobs-schema-split",
        "curator-runtime-relocation",
        "skills-protected-transition",
        "lsp-install-privileged-transition",
        "pairing-runtime-relocation",
        "pairing-approval-privileged-transition",
        "whatsapp-session-secure-handoff",
      ]),
    );
    for (const gap of HERMES_CONTRACT_GAPS) {
      expect(gap.failure, gap.id).toBe("retain-source");
      for (const targetArtifactId of gap.targetArtifactIds) {
        const targetArtifact = artifact(targetArtifactId);
        const targetPath = materializePathPattern(
          resolveHermesArtifactPath(targetArtifact, { kind: "default" }),
        );
        expect(
          findHermesManagedArtifact(targetPath),
          gap.id + ":" + targetArtifactId,
        ).toMatchObject({
          artifact: { id: targetArtifactId },
          pathRole: "target",
        });
      }
      for (const currentPath of gap.currentPaths) {
        const materializedPath = materializePathPattern("/sandbox/.hermes/" + currentPath);
        expect(
          findHermesManagedArtifact(materializedPath),
          gap.id + ":" + currentPath,
        ).not.toBeNull();
      }
    }
    expect(
      findHermesManagedArtifact("/sandbox/.hermes/platforms/pairing/slack-approved.json"),
    ).toMatchObject({
      artifact: {
        id: "pairing-approved",
        migrationSources: [
          expect.objectContaining({ action: "migrate", onFailure: "leave-source" }),
        ],
      },
      pathRole: "migration-source",
    });
    expect(findHermesManagedArtifact("/sandbox/.hermes/cron/jobs.json")).toMatchObject({
      artifact: { id: "cron-job-definitions" },
      pathRole: "target",
    });
    expect(resolveHermesArtifactPath(artifact("cron-job-runtime-state"), { kind: "default" })).toBe(
      "/sandbox/.hermes/runtime/cron/job-state.json",
    );
    expect(artifact("migration-marker")).toMatchObject({
      restore: "discard",
      migration: "regenerate",
    });
  });
});
