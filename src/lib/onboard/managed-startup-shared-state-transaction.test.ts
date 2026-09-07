// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import type { ManagedStartupAgent, ManagedStartupProfile } from "./managed-startup/profile";
import { fingerprintManagedStartupProfile } from "./managed-startup/profile";
import {
  beginManagedStartupSharedStateTransaction,
  clearManagedStartupSharedStateCommitReceipt,
  commitManagedStartupSharedStateTransaction,
  getManagedStartupSharedStateTransactionStatus,
  MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY,
  type ManagedStartupSharedTransactionOptions,
  rollbackManagedStartupSharedStateTransaction,
} from "./managed-startup/shared-state-transaction";

function mode(target: string): number {
  return fs.lstatSync(target).mode & 0o7777;
}

function unavailableIdentity(name: string): never {
  throw new Error(`effective ${name} is unavailable`);
}

function effectiveUid(): number {
  return process.geteuid?.() ?? unavailableIdentity("uid");
}

function effectiveGid(): number {
  return process.getegid?.() ?? unavailableIdentity("gid");
}

describe("managed startup shared-state transaction", () => {
  let temporaryRoot = "";
  let sandboxRoot = "";
  let transactionDirectory = "";
  let options: ManagedStartupSharedTransactionOptions;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shared-transaction-"));
    sandboxRoot = path.join(temporaryRoot, "sandbox");
    const transactionParent = path.join(temporaryRoot, "root-state");
    transactionDirectory = path.join(transactionParent, "transaction");
    fs.mkdirSync(sandboxRoot, { mode: 0o755 });
    fs.mkdirSync(transactionParent, { mode: 0o755 });
    fs.chmodSync(transactionParent, 0o755);
    options = {
      sandboxRoot,
      transactionDirectory,
      trustedUid: effectiveUid(),
      trustedGid: effectiveGid(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  });

  function agentRoot(agent: ManagedStartupAgent): string {
    return path.join(
      sandboxRoot,
      agent === "openclaw"
        ? ".openclaw"
        : agent === "hermes"
          ? ".hermes"
          : agent === "pi"
            ? ".pi"
            : ".deepagents",
    );
  }

  function commitReceiptDirectory(): string {
    return path.join(
      path.dirname(transactionDirectory),
      path.basename(MANAGED_STARTUP_SHARED_COMMIT_RECEIPT_DIRECTORY),
    );
  }

  function simulateMountedStateRoot(root: string, ...nestedMounts: readonly string[]): void {
    const originalLstatSync = fs.lstatSync.bind(fs);
    const mountRoots = [root, ...nestedMounts].map((target) => path.resolve(target));
    vi.spyOn(fs, "lstatSync").mockImplementation(((
      target: fs.PathLike,
      statOptions?: { readonly bigint?: boolean },
    ) => {
      const stat =
        statOptions?.bigint === true
          ? originalLstatSync(target, { bigint: true })
          : originalLstatSync(target);
      const resolved = path.resolve(String(target));
      const deviceOffset = mountRoots.filter(
        (mountRoot) => resolved === mountRoot || resolved.startsWith(`${mountRoot}${path.sep}`),
      ).length;
      Object.defineProperty(stat, "dev", {
        configurable: true,
        value:
          typeof stat.dev === "bigint" ? stat.dev + BigInt(deviceOffset) : stat.dev + deviceOffset,
      });
      return stat;
    }) as typeof fs.lstatSync);
  }

  function simulateLinuxDirectoryMode(root: string, initialMode: number): void {
    const resolvedRoot = path.resolve(root);
    let exactMode = initialMode;
    const originalChmodSync = fs.chmodSync.bind(fs);
    vi.spyOn(fs, "chmodSync").mockImplementation((target, targetMode) => {
      originalChmodSync(target, targetMode);
      [path.resolve(String(target))]
        .filter((resolvedTarget) => resolvedTarget === resolvedRoot)
        .forEach(() => {
          exactMode = Number(targetMode);
        });
    });
    const originalLstatSync = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation(((
      target: fs.PathLike,
      statOptions?: { readonly bigint?: boolean },
    ) => {
      const stat =
        statOptions?.bigint === true
          ? originalLstatSync(target, { bigint: true })
          : originalLstatSync(target);
      [path.resolve(String(target))]
        .filter((resolvedTarget) => resolvedTarget === resolvedRoot)
        .forEach(() => {
          Object.defineProperty(stat, "mode", {
            configurable: true,
            value:
              typeof stat.mode === "bigint"
                ? (stat.mode & ~0o7777n) | BigInt(exactMode)
                : (stat.mode & ~0o7777) | exactMode,
          });
        });
      return stat;
    }) as typeof fs.lstatSync);
  }

  function rewriteManifest(
    rewrite: (manifest: Record<string, unknown>) => Record<string, unknown> = (manifest) =>
      manifest,
  ): void {
    const manifestFile = path.join(transactionDirectory, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
    expect(manifest.bootstrapIdentity).toBeNull();
    delete manifest.bootstrapIdentity;
    const rewritten = rewrite(manifest);
    fs.chmodSync(manifestFile, 0o600);
    fs.writeFileSync(manifestFile, `${JSON.stringify(rewritten, null, 2)}\n`);
    fs.chmodSync(manifestFile, 0o400);
  }

  it.each(["openclaw", "hermes", "langchain-deepagents-code", "pi"] as const)(
    "restores exact %s bytes, ownership, modes, and absence receipts",
    (agent) => {
      const root = agentRoot(agent);
      fs.mkdirSync(root, { mode: 0o750 });
      fs.chmodSync(root, 0o750);
      const originalFiles =
        agent === "openclaw"
          ? [["openclaw.json", "openclaw-original\n", 0o640] as const]
          : agent === "hermes"
            ? [
                ["config.yaml", "hermes-original\n", 0o640] as const,
                [".env", "TOKEN=original\n", 0o600] as const,
              ]
            : agent === "pi"
              ? []
              : [["config.toml", "dcode-original\n", 0o660] as const];
      originalFiles.forEach(([name, contents, fileMode]) => {
        const target = path.join(root, name);
        fs.writeFileSync(target, contents);
        fs.chmodSync(target, fileMode);
      });

      beginManagedStartupSharedStateTransaction(managedStartupE2eProfile(agent), options);
      originalFiles.forEach(([name]) => {
        const target = path.join(root, name);
        fs.writeFileSync(target, "changed\n");
        fs.chmodSync(target, 0o600);
      });
      const createManagedDrift: Record<ManagedStartupAgent, () => void> = {
        openclaw: () => fs.writeFileSync(path.join(root, ".config-hash"), "new\n"),
        hermes: () => fs.writeFileSync(path.join(root, ".config-hash"), "new\n"),
        "langchain-deepagents-code": () => {
          fs.mkdirSync(path.join(root, ".state"));
          fs.mkdirSync(path.join(root, "skills"));
        },
        pi: () => {
          fs.mkdirSync(path.join(root, "agent"));
          fs.writeFileSync(path.join(root, "agent", "models.json"), "{}\n");
        },
      };
      createManagedDrift[agent]();

      expect(rollbackManagedStartupSharedStateTransaction(agent, options)).toBe(true);
      originalFiles.forEach(([name, contents, fileMode]) => {
        const target = path.join(root, name);
        expect(fs.readFileSync(target, "utf8")).toBe(contents);
        expect(mode(target)).toBe(fileMode);
        expect(fs.lstatSync(target).uid).toBe(effectiveUid());
        expect(fs.lstatSync(target).gid).toBe(effectiveGid());
      });
      expect(mode(root)).toBe(0o750);
      const absentManagedPaths: Record<ManagedStartupAgent, readonly string[]> = {
        openclaw: [".config-hash"],
        hermes: [".config-hash"],
        "langchain-deepagents-code": [".state", "skills"],
        pi: ["agent", path.join("agent", "models.json")],
      };
      expect(
        absentManagedPaths[agent].every((relativePath) =>
          Object.is(fs.existsSync(path.join(root, relativePath)), false),
        ),
      ).toBe(true);
      expect(fs.existsSync(transactionDirectory)).toBe(false);
    },
  );

  it("preserves transaction rollback when the exact Hermes root is a named-volume mount", () => {
    const root = agentRoot("hermes");
    fs.mkdirSync(root, { mode: 0o770 });
    const config = path.join(root, "config.yaml");
    const env = path.join(root, ".env");
    fs.writeFileSync(config, "before: true\n");
    fs.writeFileSync(env, "TOKEN=before\n");
    simulateMountedStateRoot(root);

    expect(
      beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("hermes"), options),
    ).toBe(true);
    fs.writeFileSync(config, "after: true\n");
    fs.writeFileSync(env, "TOKEN=after\n");

    expect(rollbackManagedStartupSharedStateTransaction("hermes", options)).toBe(true);
    expect(fs.readFileSync(config, "utf8")).toBe("before: true\n");
    expect(fs.readFileSync(env, "utf8")).toBe("TOKEN=before\n");
  });

  it("restores the setgid bit on the exact Hermes state root (#9486)", () => {
    const root = agentRoot("hermes");
    fs.mkdirSync(root, { mode: 0o770 });
    simulateLinuxDirectoryMode(root, 0o3770);
    const config = path.join(root, "config.yaml");
    fs.writeFileSync(config, "before: true\n");

    expect(
      beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("hermes"), options),
    ).toBe(true);
    fs.chmodSync(root, 0o770);
    fs.writeFileSync(config, "after: true\n");

    expect(rollbackManagedStartupSharedStateTransaction("hermes", options)).toBe(true);
    expect(mode(root)).toBe(0o3770);
    expect(fs.readFileSync(config, "utf8")).toBe("before: true\n");
  });

  it("rejects a nested mount below the exact Hermes named-volume root", () => {
    const root = agentRoot("hermes");
    const nestedOutputDirectory = path.join(root, "channels");
    fs.mkdirSync(nestedOutputDirectory, { recursive: true });
    const plan: SandboxMessagingPlan = {
      schemaVersion: 1,
      sandboxName: "managed",
      agent: "hermes",
      workflow: "onboard",
      channels: [
        {
          channelId: "wechat",
          displayName: "WeChat",
          authMode: "host-qr",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: [],
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [
        {
          channelId: "wechat",
          agent: "hermes",
          target: "~/.hermes/channels/wechat.json",
          kind: "json-fragment",
          path: "channels.wechat",
          value: { enabled: true },
          templateRefs: [],
        },
      ],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    };
    const profile = {
      ...managedStartupE2eProfile("hermes"),
      messaging: { plan: plan as unknown as ManagedStartupProfile["messaging"]["plan"] },
    };

    simulateMountedStateRoot(root, nestedOutputDirectory);
    expect(() => beginManagedStartupSharedStateTransaction(profile, options)).toThrow(
      /crosses a nested filesystem mount/u,
    );
    expect(fs.existsSync(transactionDirectory)).toBe(false);

    vi.restoreAllMocks();
    simulateMountedStateRoot(root);
    expect(beginManagedStartupSharedStateTransaction(profile, options)).toBe(true);

    vi.restoreAllMocks();
    simulateMountedStateRoot(root, nestedOutputDirectory);
    expect(() => rollbackManagedStartupSharedStateTransaction("hermes", options)).toThrow(
      /crosses a nested filesystem mount/u,
    );
  });

  it("accepts the exact declared OpenClaw state root mount", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "openclaw.json"), "{}\n");
    simulateMountedStateRoot(root);

    expect(
      beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options),
    ).toBe(true);
    expect(fs.existsSync(transactionDirectory)).toBe(true);
  });

  it("tracks only active post-install messaging outputs and leaves disabled targets alone", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "openclaw.json"), "{}\n");
    const plan: SandboxMessagingPlan = {
      schemaVersion: 1,
      sandboxName: "managed",
      agent: "openclaw",
      workflow: "onboard",
      channels: [
        {
          channelId: "wechat",
          displayName: "WeChat",
          authMode: "host-qr",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [
            {
              channelId: "wechat",
              id: "seed",
              phase: "post-agent-install",
              handler: "wechat.seedOpenClawAccount",
            },
          ],
        },
        {
          channelId: "telegram",
          displayName: "Telegram",
          authMode: "token-paste",
          active: false,
          selected: true,
          configured: true,
          disabled: true,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: ["telegram"],
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [
        {
          channelId: "wechat",
          agent: "openclaw",
          target: "~/.openclaw/active-render.json",
          kind: "json-fragment",
          path: "channels.wechat",
          value: { enabled: true },
          templateRefs: [],
        },
        {
          channelId: "telegram",
          agent: "openclaw",
          target: "~/.openclaw/disabled-render.json",
          kind: "json-fragment",
          path: "channels.telegram",
          value: { enabled: true },
          templateRefs: [],
        },
      ],
      buildSteps: [
        {
          channelId: "wechat",
          kind: "build-file",
          hookId: "seed",
          outputId: "accounts",
          required: true,
          value: {
            path: "openclaw-weixin/accounts.json",
            content: ["primary"],
          },
        },
        {
          channelId: "telegram",
          kind: "build-file",
          outputId: "disabled",
          required: true,
          value: { path: "disabled/new.json", content: {} },
        },
      ],
      stateUpdates: [],
      healthChecks: [],
    };
    const profile = {
      ...managedStartupE2eProfile("openclaw"),
      messaging: { plan: plan as unknown as ManagedStartupProfile["messaging"]["plan"] },
    };
    beginManagedStartupSharedStateTransaction(profile, options);

    fs.writeFileSync(path.join(root, "active-render.json"), "active\n");
    fs.mkdirSync(path.join(root, "openclaw-weixin"));
    fs.writeFileSync(path.join(root, "openclaw-weixin", "accounts.json"), "active\n");
    fs.writeFileSync(path.join(root, "disabled-render.json"), "keep\n");
    fs.mkdirSync(path.join(root, "disabled"));
    fs.writeFileSync(path.join(root, "disabled", "new.json"), "keep\n");

    expect(rollbackManagedStartupSharedStateTransaction("openclaw", options)).toBe(true);
    expect(fs.existsSync(path.join(root, "active-render.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "openclaw-weixin"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "disabled-render.json"), "utf8")).toBe("keep\n");
    expect(fs.readFileSync(path.join(root, "disabled", "new.json"), "utf8")).toBe("keep\n");
  });

  it("commits applied output while removing its private backups", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    const config = path.join(root, "openclaw.json");
    fs.writeFileSync(config, "before\n");
    beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options);
    fs.writeFileSync(config, "after\n");

    expect(commitManagedStartupSharedStateTransaction("openclaw", options)).toBe(true);
    expect(fs.readFileSync(config, "utf8")).toBe("after\n");
    expect(fs.existsSync(transactionDirectory)).toBe(false);
    expect(commitManagedStartupSharedStateTransaction("openclaw", options)).toBe(false);
  });

  it.each([
    ["commits", "commit"],
    ["rolls back", "rollback"],
  ] as const)(
    "%s an exact historical schema-v1 manifest without bootstrap identity",
    (_description, action) => {
      const root = agentRoot("openclaw");
      fs.mkdirSync(root);
      const config = path.join(root, "openclaw.json");
      fs.writeFileSync(config, "before\n");
      beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options);
      rewriteManifest();
      fs.writeFileSync(config, "after\n");

      const result =
        action === "commit"
          ? commitManagedStartupSharedStateTransaction("openclaw", options)
          : rollbackManagedStartupSharedStateTransaction("openclaw", options);

      expect(result).toBe(true);
      expect(fs.readFileSync(config, "utf8")).toBe(action === "commit" ? "after\n" : "before\n");
      expect(fs.existsSync(transactionDirectory)).toBe(false);
      expect(fs.existsSync(commitReceiptDirectory())).toBe(false);
    },
  );

  it.each([
    ["an extra field", (manifest: Record<string, unknown>) => ({ ...manifest, extra: true })],
    [
      "a missing historical field",
      (manifest: Record<string, unknown>) => {
        delete manifest.directories;
        return manifest;
      },
    ],
  ] as const)("rejects a schema-v1 legacy manifest with %s", (_case, rewrite) => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "openclaw.json"), "before\n");
    beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options);
    rewriteManifest(rewrite);

    expect(() => commitManagedStartupSharedStateTransaction("openclaw", options)).toThrow(
      /unexpected fields/u,
    );
    expect(fs.existsSync(transactionDirectory)).toBe(true);
  });

  it("does not treat a legacy manifest as authority for an identity-bound bootstrap", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "openclaw.json"), "before\n");
    const boundOptions = { ...options, bootstrapIdentity: "b".repeat(64) };
    beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), boundOptions);
    const manifestFile = path.join(transactionDirectory, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
    delete manifest.bootstrapIdentity;
    fs.chmodSync(manifestFile, 0o600);
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.chmodSync(manifestFile, 0o400);

    expect(() => rollbackManagedStartupSharedStateTransaction("openclaw", boundOptions)).toThrow(
      /different bootstrap attempt/u,
    );
    expect(fs.existsSync(transactionDirectory)).toBe(true);
  });

  it("fsyncs every transaction namespace before exposing a pending receipt", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "openclaw.json"), "before\n");
    const open = vi.spyOn(fs, "openSync");
    const fsync = vi.spyOn(fs, "fsyncSync");

    expect(
      beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options),
    ).toBe(true);

    const transactionParent = path.dirname(transactionDirectory);
    const backupDirectory = path.join(transactionDirectory, "backups");
    expect(open).toHaveBeenCalledWith(transactionParent, fs.constants.O_RDONLY);
    expect(open).toHaveBeenCalledWith(transactionDirectory, fs.constants.O_RDONLY);
    expect(open).toHaveBeenCalledWith(backupDirectory, fs.constants.O_RDONLY);
    // File contents plus parent, backup, and manifest directory entries all
    // reach stable storage before the transaction is returned as pending.
    expect(fsync.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "persists one exact compact %s bootstrap commit across fresh calls, forbids rollback, and retires it for the next attempt",
    (agent) => {
      const profile = managedStartupE2eProfile(agent);
      const bootstrapIdentity = "b".repeat(64);
      const nextBootstrapIdentity = "d".repeat(64);
      const boundOptions = { ...options, bootstrapIdentity };
      const root = agentRoot(agent);
      fs.mkdirSync(root);
      const config = path.join(
        root,
        agent === "openclaw" ? "openclaw.json" : agent === "hermes" ? "config.yaml" : "config.toml",
      );
      fs.writeFileSync(config, "before\n");

      expect(beginManagedStartupSharedStateTransaction(profile, boundOptions)).toBe(true);
      fs.writeFileSync(config, "committed\n");
      expect(
        getManagedStartupSharedStateTransactionStatus(
          {
            agent,
            profileFingerprint: fingerprintManagedStartupProfile(profile),
            bootstrapIdentity,
          },
          options,
        ),
      ).toBe("pending");
      expect(() =>
        getManagedStartupSharedStateTransactionStatus(
          {
            agent,
            profileFingerprint: "e".repeat(64),
            bootstrapIdentity,
          },
          options,
        ),
      ).toThrow(/expected agent, profile fingerprint, or bootstrap identity/u);
      expect(commitManagedStartupSharedStateTransaction(agent, boundOptions)).toBe(true);

      const receiptDirectory = commitReceiptDirectory();
      const receiptFile = path.join(receiptDirectory, "receipt.json");
      expect(fs.existsSync(transactionDirectory)).toBe(false);
      expect(fs.readdirSync(receiptDirectory)).toEqual(["receipt.json"]);
      expect(mode(receiptDirectory)).toBe(0o700);
      expect(mode(receiptFile)).toBe(0o400);
      expect(JSON.parse(fs.readFileSync(receiptFile, "utf8"))).toEqual({
        schemaVersion: 1,
        agent,
        profileFingerprint: fingerprintManagedStartupProfile(profile),
        bootstrapIdentity,
      });

      // These calls reconstruct state solely from the image-owned receipt.
      expect(
        getManagedStartupSharedStateTransactionStatus(
          {
            agent,
            profileFingerprint: fingerprintManagedStartupProfile(profile),
            bootstrapIdentity,
          },
          options,
        ),
      ).toBe("committed");
      expect(commitManagedStartupSharedStateTransaction(agent, boundOptions)).toBe(true);
      expect(() => rollbackManagedStartupSharedStateTransaction(agent, boundOptions)).toThrow(
        /durably committed and cannot be rolled back/u,
      );
      expect(() =>
        getManagedStartupSharedStateTransactionStatus(
          {
            agent,
            profileFingerprint: "e".repeat(64),
            bootstrapIdentity,
          },
          options,
        ),
      ).toThrow(/different bootstrap attempt/u);
      expect(fs.readFileSync(config, "utf8")).toBe("committed\n");

      expect(clearManagedStartupSharedStateCommitReceipt(agent, boundOptions)).toBe(true);
      expect(fs.existsSync(receiptDirectory)).toBe(false);
      expect(
        getManagedStartupSharedStateTransactionStatus(
          {
            agent,
            profileFingerprint: fingerprintManagedStartupProfile(profile),
            bootstrapIdentity,
          },
          options,
        ),
      ).toBe("none");

      const nextOptions = { ...options, bootstrapIdentity: nextBootstrapIdentity };
      expect(beginManagedStartupSharedStateTransaction(profile, nextOptions)).toBe(true);
      expect(rollbackManagedStartupSharedStateTransaction(agent, nextOptions)).toBe(true);
    },
  );

  it.each([
    "during-compact-receipt-write",
    "before-backup-removal",
    "during-backup-removal",
    "after-backup-removal",
    "after-manifest-removal",
  ] as const)("recovers an atomically established commit interrupted %s", (interruption) => {
    const profile = managedStartupE2eProfile("openclaw");
    const bootstrapIdentity = "b".repeat(64);
    const boundOptions = { ...options, bootstrapIdentity };
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "openclaw.json"), "before\n");
    beginManagedStartupSharedStateTransaction(profile, boundOptions);
    fs.writeFileSync(path.join(root, "openclaw.json"), "committed\n");

    const originalRmSync = fs.rmSync.bind(fs);
    const rm = vi.spyOn(fs, "rmSync").mockImplementation(((
      target: fs.PathLike,
      removeOptions?: fs.RmDirOptions,
    ) =>
      String(target).endsWith(`${path.sep}backups`)
        ? (() => {
            throw new Error("injected post-rename cleanup interruption");
          })()
        : originalRmSync(target, removeOptions)) as typeof fs.rmSync);
    try {
      expect(() => commitManagedStartupSharedStateTransaction("openclaw", boundOptions)).toThrow(
        /injected post-rename cleanup interruption/u,
      );
    } finally {
      rm.mockRestore();
    }

    expect(fs.existsSync(transactionDirectory)).toBe(false);
    const committedDirectory = commitReceiptDirectory();
    const backups = path.join(committedDirectory, "backups");
    const manifest = path.join(committedDirectory, "manifest.json");
    const applyInterruption: Record<typeof interruption, () => void> = {
      "during-compact-receipt-write": () =>
        fs.renameSync(
          path.join(committedDirectory, "receipt.json"),
          path.join(committedDirectory, ".receipt.json.1234567890abcdef12345678"),
        ),
      "before-backup-removal": () => undefined,
      "during-backup-removal": () => {
        const [firstBackup] = fs.readdirSync(backups);
        expect(firstBackup).toBeTruthy();
        fs.unlinkSync(path.join(backups, firstBackup!));
      },
      "after-backup-removal": () => originalRmSync(backups, { force: false, recursive: true }),
      "after-manifest-removal": () => fs.unlinkSync(manifest),
    };
    applyInterruption[interruption]();
    expect(
      getManagedStartupSharedStateTransactionStatus(
        {
          agent: "openclaw",
          profileFingerprint: fingerprintManagedStartupProfile(profile),
          bootstrapIdentity,
        },
        options,
      ),
    ).toBe("committed");
    expect(commitManagedStartupSharedStateTransaction("openclaw", boundOptions)).toBe(true);
    expect(fs.readdirSync(committedDirectory)).toEqual(["receipt.json"]);
    expect(clearManagedStartupSharedStateCommitReceipt("openclaw", boundOptions)).toBe(true);
  });

  it("resumes the same pending profile idempotently and rejects profile drift", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "openclaw.json"), "{}\n");
    const profile = managedStartupE2eProfile("openclaw");
    expect(beginManagedStartupSharedStateTransaction(profile, options)).toBe(true);
    expect(beginManagedStartupSharedStateTransaction(profile, options)).toBe(false);
    expect(() =>
      beginManagedStartupSharedStateTransaction(
        managedStartupE2eProfile("openclaw", true),
        options,
      ),
    ).toThrow(/belongs to a different agent, profile fingerprint, or bootstrap attempt/u);
    expect(rollbackManagedStartupSharedStateTransaction("openclaw", options)).toBe(true);
  });

  it("validates a directly mounted copied receipt under an unchanged 0755 image parent", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "openclaw.json"), "{}\n");
    const profile = managedStartupE2eProfile("openclaw");
    const bootstrapIdentity = "b".repeat(64);
    const boundOptions = { ...options, bootstrapIdentity };
    beginManagedStartupSharedStateTransaction(profile, boundOptions);

    const imageParent = path.join(temporaryRoot, "image-var-lib-nemoclaw");
    const copiedReceipt = path.join(imageParent, "managed-startup-shared-state-transaction-v1");
    fs.mkdirSync(imageParent, { mode: 0o755 });
    fs.chmodSync(imageParent, 0o755);
    fs.cpSync(transactionDirectory, copiedReceipt, {
      recursive: true,
      preserveTimestamps: true,
    });
    // Node 22.23 normalizes copied directory modes to 0755. Recreate the
    // protected modes that the container-copy fixture is intended to model.
    fs.chmodSync(copiedReceipt, 0o700);
    fs.chmodSync(path.join(copiedReceipt, "backups"), 0o700);

    expect(
      getManagedStartupSharedStateTransactionStatus(
        {
          agent: "openclaw",
          profileFingerprint: fingerprintManagedStartupProfile(profile),
          bootstrapIdentity,
        },
        {
          ...boundOptions,
          transactionDirectory: copiedReceipt,
        },
      ),
    ).toBe("pending");

    fs.chmodSync(imageParent, 0o700);
    expect(() =>
      getManagedStartupSharedStateTransactionStatus(
        {
          agent: "openclaw",
          profileFingerprint: fingerprintManagedStartupProfile(profile),
          bootstrapIdentity,
        },
        {
          ...boundOptions,
          transactionDirectory: copiedReceipt,
        },
      ),
    ).toThrow(/must be .* mode 755/u);
  });

  it("rejects a writable copied receipt before transaction status parsing", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "openclaw.json"), "{}\n");
    const profile = managedStartupE2eProfile("openclaw");
    const bootstrapIdentity = "b".repeat(64);
    const boundOptions = { ...options, bootstrapIdentity };
    beginManagedStartupSharedStateTransaction(profile, boundOptions);

    const imageParent = path.join(temporaryRoot, "read-only-image-var-lib-nemoclaw");
    const copiedReceipt = path.join(imageParent, "managed-startup-shared-state-transaction-v1");
    fs.mkdirSync(imageParent, { mode: 0o755 });
    fs.cpSync(transactionDirectory, copiedReceipt, {
      recursive: true,
      preserveTimestamps: true,
    });
    fs.chmodSync(copiedReceipt, 0o700);
    fs.chmodSync(path.join(copiedReceipt, "backups"), 0o700);
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    vi.spyOn(process, "getegid").mockReturnValue(0);

    expect(() =>
      getManagedStartupSharedStateTransactionStatus(
        {
          agent: "openclaw",
          profileFingerprint: fingerprintManagedStartupProfile(profile),
          bootstrapIdentity,
        },
        {
          ...boundOptions,
          transactionDirectory: copiedReceipt,
          readOnlyReceipt: true,
        },
      ),
    ).toThrow(/copied receipt mount is writable/u);
  });

  it("rejects planted target and ancestor symlinks before creating a receipt", () => {
    const outside = path.join(temporaryRoot, "outside");
    fs.mkdirSync(outside);
    const root = agentRoot("openclaw");
    fs.symlinkSync(outside, root);
    expect(() =>
      beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options),
    ).toThrow(/ancestor is unsafe/u);
    expect(fs.existsSync(transactionDirectory)).toBe(false);

    fs.unlinkSync(root);
    fs.mkdirSync(root);
    const outsideConfig = path.join(outside, "openclaw.json");
    fs.writeFileSync(outsideConfig, "outside\n");
    fs.symlinkSync(outsideConfig, path.join(root, "openclaw.json"));
    expect(() =>
      beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options),
    ).toThrow(/not a safe regular file/u);
    expect(fs.readFileSync(outsideConfig, "utf8")).toBe("outside\n");
    expect(fs.existsSync(transactionDirectory)).toBe(false);
  });

  it("does not rewrite unchanged files or directory metadata", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root, { mode: 0o755 });
    const config = path.join(root, "openclaw.json");
    fs.writeFileSync(config, "unchanged\n");
    fs.chmodSync(config, 0o444);
    beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options);
    const rename = vi.spyOn(fs, "renameSync");
    const chown = vi.spyOn(fs, "chownSync");

    expect(rollbackManagedStartupSharedStateTransaction("openclaw", options)).toBe(true);
    expect(rename).not.toHaveBeenCalled();
    expect(chown).not.toHaveBeenCalled();
    expect(fs.readFileSync(config, "utf8")).toBe("unchanged\n");
    expect(mode(config)).toBe(0o444);
  });

  it("refuses to operate on a pending transaction for a different agent", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "openclaw.json"), "{}\n");
    beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options);
    expect(() => rollbackManagedStartupSharedStateTransaction("hermes", options)).toThrow(
      /targets openclaw, expected hermes/u,
    );
    expect(fs.existsSync(transactionDirectory)).toBe(true);
    expect(rollbackManagedStartupSharedStateTransaction("openclaw", options)).toBe(true);
  });

  it("rejects a malformed rollback receipt before restoring shared state", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    const config = path.join(root, "openclaw.json");
    fs.writeFileSync(config, "before\n");
    beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options);
    fs.writeFileSync(config, "changed\n");
    const manifest = path.join(transactionDirectory, "manifest.json");
    fs.chmodSync(manifest, 0o600);
    fs.writeFileSync(manifest, "{malformed\n");
    fs.chmodSync(manifest, 0o400);

    expect(() => rollbackManagedStartupSharedStateTransaction("openclaw", options)).toThrow(
      /manifest is not valid JSON/u,
    );
    expect(fs.readFileSync(config, "utf8")).toBe("changed\n");
    expect(fs.existsSync(transactionDirectory)).toBe(true);
  });

  it("rejects an oversized managed output before creating a receipt", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root);
    const config = path.join(root, "openclaw.json");
    fs.writeFileSync(config, "");
    fs.truncateSync(config, 8 * 1024 * 1024 + 1);

    expect(() =>
      beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options),
    ).toThrow(/unsafe or oversized/u);
    expect(fs.existsSync(transactionDirectory)).toBe(false);
  });
});
