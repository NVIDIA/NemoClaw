// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import type { ManagedStartupAgent, ManagedStartupProfile } from "./managed-startup/profile";
import {
  beginManagedStartupSharedStateTransaction,
  commitManagedStartupSharedStateTransaction,
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
      agent === "openclaw" ? ".openclaw" : agent === "hermes" ? ".hermes" : ".deepagents",
    );
  }

  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("restores exact %s bytes, ownership, modes, and absence receipts", (agent) => {
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
          : [["config.toml", "dcode-original\n", 0o660] as const];
    for (const [name, contents, fileMode] of originalFiles) {
      const target = path.join(root, name);
      fs.writeFileSync(target, contents);
      fs.chmodSync(target, fileMode);
    }

    beginManagedStartupSharedStateTransaction(managedStartupE2eProfile(agent), options);
    for (const [name] of originalFiles) {
      const target = path.join(root, name);
      fs.writeFileSync(target, "changed\n");
      fs.chmodSync(target, 0o600);
    }
    const createManagedDrift: Record<ManagedStartupAgent, () => void> = {
      openclaw: () => fs.writeFileSync(path.join(root, ".config-hash"), "new\n"),
      hermes: () => fs.writeFileSync(path.join(root, ".config-hash"), "new\n"),
      "langchain-deepagents-code": () => {
        fs.mkdirSync(path.join(root, ".state"));
        fs.mkdirSync(path.join(root, "skills"));
      },
    };
    createManagedDrift[agent]();

    expect(rollbackManagedStartupSharedStateTransaction(agent, options)).toBe(true);
    for (const [name, contents, fileMode] of originalFiles) {
      const target = path.join(root, name);
      expect(fs.readFileSync(target, "utf8")).toBe(contents);
      expect(mode(target)).toBe(fileMode);
      expect(fs.lstatSync(target).uid).toBe(effectiveUid());
      expect(fs.lstatSync(target).gid).toBe(effectiveGid());
    }
    expect(mode(root)).toBe(0o750);
    const absentManagedPaths: Record<ManagedStartupAgent, readonly string[]> = {
      openclaw: [".config-hash"],
      hermes: [".config-hash"],
      "langchain-deepagents-code": [".state", "skills"],
    };
    for (const relativePath of absentManagedPaths[agent]) {
      expect(fs.existsSync(path.join(root, relativePath))).toBe(false);
    }
    expect(fs.existsSync(transactionDirectory)).toBe(false);
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
    ).toThrow(/belongs to a different profile/u);
    expect(rollbackManagedStartupSharedStateTransaction("openclaw", options)).toBe(true);
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

  it("does not rewrite unchanged shield-like files or directory metadata", () => {
    const root = agentRoot("openclaw");
    fs.mkdirSync(root, { mode: 0o755 });
    const config = path.join(root, "openclaw.json");
    fs.writeFileSync(config, "shielded\n");
    fs.chmodSync(config, 0o444);
    beginManagedStartupSharedStateTransaction(managedStartupE2eProfile("openclaw"), options);
    const rename = vi.spyOn(fs, "renameSync");
    const chown = vi.spyOn(fs, "chownSync");

    expect(rollbackManagedStartupSharedStateTransaction("openclaw", options)).toBe(true);
    expect(rename).not.toHaveBeenCalled();
    expect(chown).not.toHaveBeenCalled();
    expect(fs.readFileSync(config, "utf8")).toBe("shielded\n");
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
