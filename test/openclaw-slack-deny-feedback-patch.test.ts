// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SLACK_GUARD = path.join(
  import.meta.dirname,
  "..",
  "src",
  "lib",
  "messaging",
  "channels",
  "slack",
  "runtime",
  "slack-channel-guard.ts",
);

// Minimal stand-in for the compiled @openclaw/slack prepare module: a denying
// channel gate that mirrors the real dist's deny-log line and exposes the same
// in-scope identifiers the patch references.
function prepareModuleSource(
  options: { moduleType?: "commonjs" | "esm"; withMentionState?: boolean; denyLine?: string } = {},
): string {
  const moduleType = options.moduleType ?? "commonjs";
  const withMentionState = options.withMentionState ?? true;
  const denyLine =
    options.denyLine ??
    "logVerbose(`Blocked unauthorized slack sender ${senderId} (not in channel users)`);";
  return [
    "function logVerbose() {}",
    `${moduleType === "esm" ? "export " : ""}async function prepareSlackMessage(params) {`,
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
    moduleType === "commonjs" ? "module.exports = { prepareSlackMessage };" : "",
    "",
  ].join("\n");
}

function writeSlackPackage(
  root: string,
  options: { moduleType?: "commonjs" | "esm"; withMentionState?: boolean; denyLine?: string } = {},
): string {
  const pkgDir = path.join(root, "node_modules", "@openclaw", "slack");
  const distDir = path.join(pkgDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/slack",
      version: "2026.5.27",
      ...(options.moduleType === "esm" ? { type: "module" } : {}),
    }),
  );
  const prepareFile = path.join(distDir, "prepare-fixture.js");
  fs.writeFileSync(prepareFile, prepareModuleSource(options));
  return prepareFile;
}

type FeedbackCall = { method: string; channel?: string; user?: string; text?: string };

function runGuardProbe(
  prepareFile: string,
  options: { loadMode?: "require" | "import"; requireGuardTwice?: boolean } = {},
) {
  const script = `
const guard = ${JSON.stringify(SLACK_GUARD)};
require(guard);
${options.requireGuardTwice ? "require(guard);" : ""}
const { pathToFileURL } = require("node:url");
let prepareSlackMessage;
async function loadPrepareSlackMessage() {
  if (${JSON.stringify(options.loadMode ?? "require")} === "import") {
    const module = await import(pathToFileURL(process.env.PREPARE_FILE).href);
    return module.prepareSlackMessage;
  }
  return require(process.env.PREPARE_FILE).prepareSlackMessage;
}
const calls = [];
const client = {
  chat: {
    postEphemeral: async (payload) => {
      calls.push({ ...payload, method: "chat.postEphemeral" });
      if (globalThis.ephemeralErrorCode) {
        throw Object.assign(new Error("postEphemeral failed"), {
          data: { error: globalThis.ephemeralErrorCode },
        });
      }
      return { ok: true };
    },
    postMessage: async (payload) => {
      calls.push({ ...payload, method: "chat.postMessage" });
      return { ok: true };
    },
  },
  conversations: {
    open: async ({ users }) => ({ ok: true, channel: { id: "D" + users } }),
  },
};
const ctx = { app: { client }, logger: { warn: () => {} } };
const message = { channel: "C1", user: "U999DENIED", ts: "100.1" };
async function run(params) {
  calls.length = 0;
  globalThis.ephemeralErrorCode = params.ephemeralErrorCode;
  const result = await prepareSlackMessage({
    ctx,
    account: {},
    message,
    opts: params.opts,
    explicitlyMentionedBotUser: params.explicitlyMentionedBotUser,
    explicitlyMentionedBotSubteam: params.explicitlyMentionedBotSubteam,
  });
  return { result, calls: calls.slice() };
}
(async () => {
  prepareSlackMessage = await loadPrepareSlackMessage();
  const output = {
    mention: await run({ opts: { source: "app_mention" } }),
    silent: await run({ opts: { source: "message" } }),
    explicitUser: await run({ opts: { source: "message" }, explicitlyMentionedBotUser: true }),
    explicitSubteam: await run({ opts: { source: "message" }, explicitlyMentionedBotSubteam: true }),
    fallback: await run({ opts: { source: "app_mention" }, ephemeralErrorCode: "user_not_in_channel" }),
    ambiguous: await run({ opts: { source: "app_mention" }, ephemeralErrorCode: "service_unavailable" }),
  };
  console.log(JSON.stringify(output));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PREPARE_FILE: prepareFile,
    },
    timeout: 10000,
  });
  return {
    result,
    output:
      result.status === 0 && result.stdout.trim()
        ? (JSON.parse(result.stdout) as Record<string, unknown>)
        : null,
  };
}

function runGuardRequire(prepareFile?: string) {
  const script = [
    `require(${JSON.stringify(SLACK_GUARD)});`,
    prepareFile ? "require(process.env.PREPARE_FILE);" : "",
  ].join("\n");
  return spawnSync(process.execPath, ["-e", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      ...(prepareFile ? { PREPARE_FILE: prepareFile } : {}),
    },
    timeout: 10000,
  });
}

describe("OpenClaw Slack denial-feedback patch", () => {
  it("injects bounded sender feedback at runtime while keeping the command denied", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-deny-"));
    const prepareFile = writeSlackPackage(tmp);
    try {
      const { result, output } = runGuardProbe(prepareFile);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(prepareFile, "utf-8")).not.toContain(
        "__nemoclawNotifyDeniedSlackMention",
      );

      // Denied explicit @-mention: command stays denied, exactly one ephemeral feedback.
      const mention = output?.mention as { result: unknown; calls: FeedbackCall[] };
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
      const silent = output?.silent as { result: unknown; calls: FeedbackCall[] };
      expect(silent.result).toBeNull();
      expect(silent.calls).toHaveLength(0);

      // Explicit bot mention on a non-app_mention event also triggers feedback.
      const explicitUser = output?.explicitUser as { result: unknown; calls: FeedbackCall[] };
      expect(explicitUser.result).toBeNull();
      expect(explicitUser.calls).toHaveLength(1);
      expect(explicitUser.calls[0].method).toBe("chat.postEphemeral");

      const explicitSubteam = output?.explicitSubteam as { result: unknown; calls: FeedbackCall[] };
      expect(explicitSubteam.result).toBeNull();
      expect(explicitSubteam.calls).toHaveLength(1);
      expect(explicitSubteam.calls[0].method).toBe("chat.postEphemeral");

      // Definitive non-delivery (user_not_in_channel) falls back to a DM.
      const fallback = output?.fallback as { result: unknown; calls: FeedbackCall[] };
      expect(fallback.result).toBeNull();
      expect(fallback.calls.map((call) => call.method)).toEqual([
        "chat.postEphemeral",
        "chat.postMessage",
      ]);
      expect(fallback.calls[1]).toMatchObject({ channel: "DU999DENIED" });

      // Ambiguous failure (Slack may have accepted it): log, no DM, no double-notify.
      const ambiguous = output?.ambiguous as { result: unknown; calls: FeedbackCall[] };
      expect(ambiguous.result).toBeNull();
      expect(ambiguous.calls.map((call) => call.method)).toEqual(["chat.postEphemeral"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("injects bounded sender feedback for ESM imports of @openclaw/slack", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-deny-esm-"));
    const prepareFile = writeSlackPackage(tmp, { moduleType: "esm" });
    try {
      const { result, output } = runGuardProbe(prepareFile, { loadMode: "import" });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(prepareFile, "utf-8")).not.toContain(
        "__nemoclawNotifyDeniedSlackMention",
      );

      const mention = output?.mention as { result: unknown; calls: FeedbackCall[] };
      expect(mention.result).toBeNull();
      expect(mention.calls).toHaveLength(1);
      expect(mention.calls[0]).toMatchObject({
        method: "chat.postEphemeral",
        channel: "C1",
        user: "U999DENIED",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent across repeated runs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-deny-idem-"));
    const prepareFile = writeSlackPackage(tmp);
    try {
      const { result, output } = runGuardProbe(prepareFile, { requireGuardTwice: true });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const mention = output?.mention as { result: unknown; calls: FeedbackCall[] };
      expect(mention.result).toBeNull();
      expect(mention.calls).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("loads as a no-op when no @openclaw/slack module is required", () => {
    const result = runGuardRequire();
    expect(result.status, result.stderr).toBe(0);
  });

  it("fails loudly when the deny-gate shape changes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-deny-shape-"));
    const prepareFile = writeSlackPackage(tmp, {
      denyLine: "logVerbose(`Blocked unauthorized slack sender ${senderId} (renamed gate)`);",
    });
    try {
      const result = runGuardRequire(prepareFile);
      expect(
        result.status,
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\nsource:\n${fs.readFileSync(prepareFile, "utf-8")}`,
      ).toBe(1);
      expect(result.stderr).toContain("deny gate shape not recognized");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails loudly when the mention-state shape changes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-deny-mention-"));
    const prepareFile = writeSlackPackage(tmp, { withMentionState: false });
    try {
      const result = runGuardRequire(prepareFile);
      expect(
        result.status,
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\nsource:\n${fs.readFileSync(prepareFile, "utf-8")}`,
      ).toBe(1);
      expect(result.stderr).toContain("mention-state shape not recognized");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
