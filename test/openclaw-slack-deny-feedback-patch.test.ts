// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const PATCH_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "patch-openclaw-slack-deny-feedback.mts",
);

// Minimal stand-in for the compiled @openclaw/slack prepare module: a denying
// channel gate that mirrors the real dist's deny-log line and exposes the same
// in-scope identifiers the patch references.
function prepareModuleSource(
  options: { withMentionState?: boolean; denyLine?: string } = {},
): string {
  const withMentionState = options.withMentionState ?? true;
  const denyLine =
    options.denyLine ??
    "logVerbose(`Blocked unauthorized slack sender ${senderId} (not in channel users)`);";
  return [
    "function logVerbose() {}",
    "async function prepareSlackMessage(params) {",
    "\tconst { ctx, account, message, opts } = params;",
    "\tconst senderId = message.user;",
    withMentionState
      ? "\tconst explicitlyMentionedBotUser = Boolean(params.explicitlyMentionedBotUser);"
      : "\tconst mentionedBotUser = Boolean(params.mentionedBotUser);",
    withMentionState
      ? "\tconst explicitlyMentionedBotSubteam = Boolean(params.explicitlyMentionedBotSubteam);"
      : "\tconst mentionedBotSubteam = Boolean(params.mentionedBotSubteam);",
    "\tconst isRoom = true;",
    "\tconst messageIngress = { senderAccess: { gate: { allowed: false } } };",
    "\tconst senderGate = messageIngress.senderAccess.gate;",
    "\tif (isRoom && senderGate?.allowed === false) {",
    `\t\t${denyLine}`,
    "\t\treturn null;",
    "\t}",
    "\treturn { prepared: true };",
    "}",
    "",
  ].join("\n");
}

function writeSlackPackage(
  root: string,
  options: { withMentionState?: boolean; denyLine?: string } = {},
): string {
  const pkgDir = path.join(root, "node_modules", "@openclaw", "slack");
  const distDir = path.join(pkgDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@openclaw/slack", version: "2026.5.27" }),
  );
  const prepareFile = path.join(distDir, "prepare-fixture.js");
  fs.writeFileSync(prepareFile, prepareModuleSource(options));
  return prepareFile;
}

function runPatch(...roots: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", PATCH_SCRIPT, ...roots], {
    encoding: "utf-8",
    timeout: 10000,
  });
}

type FeedbackCall = { method: string; channel?: string; user?: string; text?: string };

async function runPatchedDenyPath(
  patchedSource: string,
  params: {
    opts: { source?: string };
    explicitlyMentionedBotUser?: boolean;
    explicitlyMentionedBotSubteam?: boolean;
    ephemeralErrorCode?: string;
  },
) {
  const calls: FeedbackCall[] = [];
  const client = {
    chat: {
      postEphemeral: async (payload: Omit<FeedbackCall, "method">) => {
        calls.push({ ...payload, method: "chat.postEphemeral" });
        if (params.ephemeralErrorCode) {
          throw Object.assign(new Error("postEphemeral failed"), {
            data: { error: params.ephemeralErrorCode },
          });
        }
        return { ok: true };
      },
      postMessage: async (payload: Omit<FeedbackCall, "method">) => {
        calls.push({ ...payload, method: "chat.postMessage" });
        return { ok: true };
      },
    },
    conversations: {
      open: async ({ users }: { users: string }) => ({ ok: true, channel: { id: `D${users}` } }),
    },
  };
  const ctx = { app: { client }, logger: { warn: () => {} } };
  const message = { channel: "C1", user: "U999DENIED", ts: "100.1" };
  const sandbox: Record<string, unknown> = { Boolean, Promise, JSON, Object };
  const prepareSlackMessage = vm.runInNewContext(
    `${patchedSource}\nprepareSlackMessage;`,
    sandbox,
  ) as (input: unknown) => Promise<unknown>;
  const result = await prepareSlackMessage({
    ctx,
    account: {},
    message,
    opts: params.opts,
    explicitlyMentionedBotUser: params.explicitlyMentionedBotUser,
    explicitlyMentionedBotSubteam: params.explicitlyMentionedBotSubteam,
  });
  return { result, calls };
}

describe("OpenClaw Slack denial-feedback patch", () => {
  it("injects bounded sender feedback while keeping the command denied", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-deny-"));
    const prepareFile = writeSlackPackage(tmp);
    try {
      const patch = runPatch(tmp);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("patched OpenClaw Slack denial feedback");

      const patched = fs.readFileSync(prepareFile, "utf-8");
      expect(patched).toContain("async function __nemoclawNotifyDeniedSlackMention(");
      expect(patched).toContain(
        "nemoclaw: bounded denial feedback for explicit slack @-mentions (#4752)",
      );

      // Denied explicit @-mention: command stays denied, exactly one ephemeral feedback.
      const mention = await runPatchedDenyPath(patched, { opts: { source: "app_mention" } });
      expect(mention.result).toBeNull();
      expect(mention.calls).toHaveLength(1);
      expect(mention.calls[0]).toMatchObject({
        method: "chat.postEphemeral",
        channel: "C1",
        user: "U999DENIED",
      });
      expect(mention.calls[0].text).toBeTruthy();
      expect(mention.calls[0].text).not.toContain("U0AR85ATALW");
      expect(mention.calls[0].text?.toLowerCase()).not.toContain("allowlist");

      // Denied non-mention: no sender feedback (stays silent, as before).
      const silent = await runPatchedDenyPath(patched, { opts: { source: "message" } });
      expect(silent.result).toBeNull();
      expect(silent.calls).toHaveLength(0);

      // Explicit bot mention on a non-app_mention event also triggers feedback.
      const explicitUser = await runPatchedDenyPath(patched, {
        opts: { source: "message" },
        explicitlyMentionedBotUser: true,
      });
      expect(explicitUser.result).toBeNull();
      expect(explicitUser.calls).toHaveLength(1);
      expect(explicitUser.calls[0].method).toBe("chat.postEphemeral");

      const explicitSubteam = await runPatchedDenyPath(patched, {
        opts: { source: "message" },
        explicitlyMentionedBotSubteam: true,
      });
      expect(explicitSubteam.result).toBeNull();
      expect(explicitSubteam.calls).toHaveLength(1);
      expect(explicitSubteam.calls[0].method).toBe("chat.postEphemeral");

      // Definitive non-delivery (user_not_in_channel) falls back to a DM.
      const fallback = await runPatchedDenyPath(patched, {
        opts: { source: "app_mention" },
        ephemeralErrorCode: "user_not_in_channel",
      });
      expect(fallback.result).toBeNull();
      expect(fallback.calls.map((call) => call.method)).toEqual([
        "chat.postEphemeral",
        "chat.postMessage",
      ]);
      expect(fallback.calls[1]).toMatchObject({ channel: "DU999DENIED" });

      // Ambiguous failure (Slack may have accepted it): log, no DM, no double-notify.
      const ambiguous = await runPatchedDenyPath(patched, {
        opts: { source: "app_mention" },
        ephemeralErrorCode: "service_unavailable",
      });
      expect(ambiguous.result).toBeNull();
      expect(ambiguous.calls.map((call) => call.method)).toEqual(["chat.postEphemeral"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent across repeated runs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-deny-idem-"));
    const prepareFile = writeSlackPackage(tmp);
    try {
      expect(runPatch(tmp).status).toBe(0);
      const rerun = runPatch(tmp);
      expect(rerun.status, `${rerun.stdout}${rerun.stderr}`).toBe(0);
      const patched = fs.readFileSync(prepareFile, "utf-8");
      expect(patched.match(/async function __nemoclawNotifyDeniedSlackMention\(/g)).toHaveLength(1);
      expect(
        patched.match(/nemoclaw: bounded denial feedback for explicit slack @-mentions/g),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is a no-op when no @openclaw/slack package is present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-deny-none-"));
    fs.mkdirSync(path.join(tmp, "node_modules", "openclaw"), { recursive: true });
    try {
      const patch = runPatch(tmp);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("no @openclaw/slack package found");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails loudly when the deny-gate shape changes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-deny-shape-"));
    writeSlackPackage(tmp, {
      denyLine: "logVerbose(`Blocked unauthorized slack sender ${senderId} (renamed gate)`);",
    });
    try {
      const patch = runPatch(tmp);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("deny gate shape not recognized");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails loudly when the mention-state shape changes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-deny-mention-"));
    writeSlackPackage(tmp, { withMentionState: false });
    try {
      const patch = runPatch(tmp);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("mention-state shape not recognized");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
