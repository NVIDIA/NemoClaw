#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * NemoClaw compatibility shim for the OpenClaw Slack channel (@openclaw/slack).
 *
 * When a non-allowlisted human explicitly @-mentions the bot in a channel,
 * OpenClaw blocks the command (correct) but drops the event silently, leaving
 * the sender with no indication the bot saw the mention (NemoClaw #4752).
 *
 * This patch keeps the command denied (still returns no prepared command) but
 * adds exactly one bounded, sender-facing feedback message — an ephemeral reply
 * in the mentioned channel, falling back to a DM — without revealing the
 * configured allowlist or processing the command text.
 *
 * The patch classifies the compiled @openclaw/slack dist by content signature.
 * It fails loudly when a @openclaw/slack package is present but the deny path
 * shape is unrecognized, and is a no-op when @openclaw/slack is not installed
 * (e.g. a sandbox image built without the Slack channel enabled).
 *
 * Removal criteria: drop when upstream OpenClaw notifies the sender on a denied
 * explicit Slack @-mention, or when NemoClaw no longer ships @openclaw/slack.
 *
 * Usage: patch-openclaw-slack-deny-feedback.mts <search-root> [<search-root>...]
 *   Each <search-root> is scanned (bounded depth) for installed @openclaw/slack
 *   packages; the OpenClaw runtime dirs (HOME/.openclaw, npm global root) are
 *   the expected roots.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const HELPER_MARKER = "__nemoclawNotifyDeniedSlackMention";
const CALL_MARKER = "nemoclaw: bounded denial feedback for explicit slack @-mentions";
const DENY_LOG_SIGNATURE = "Blocked unauthorized slack sender";
const MAX_SCAN_DEPTH = 12;

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("Usage: patch-openclaw-slack-deny-feedback.mts <search-root> [<search-root>...]");
  process.exit(2);
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function readJsonSafe(file: string): { name?: string } | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { name?: string };
  } catch {
    return null;
  }
}

// Locate installed @openclaw/slack package roots under the given search roots.
function findSlackPackageRoots(searchRoots: string[]): string[] {
  const found = new Set<string>();
  const visited = new Set<string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const parsed = readJsonSafe(manifest);
      if (parsed && parsed.name === "@openclaw/slack") {
        found.add(dir);
        return; // do not descend into a matched package
      }
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      visit(join(dir, entry.name), depth + 1);
    }
  };
  for (const root of searchRoots) {
    if (existsSync(root)) visit(resolve(root), 0);
  }
  return [...found];
}

function listJsFiles(dir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(dir, entry.name));
}

function locatePrepareModule(packageRoot: string): string {
  const distDir = join(packageRoot, "dist");
  const candidates = listJsFiles(distDir).filter((file) => {
    const source = readFileSync(file, "utf8");
    return (
      source.includes("async function prepareSlackMessage") && source.includes(DENY_LOG_SIGNATURE)
    );
  });
  if (candidates.length !== 1) {
    fail(
      `expected exactly one OpenClaw Slack prepare module under ${distDir}, found ${candidates.length}; ` +
        "inspect the @openclaw/slack dist and update this patch for the new layout",
    );
  }
  return candidates[0];
}

// Sender-facing feedback helper injected into the prepare module. Indented with
// tabs to match the compiled OpenClaw dist.
function buildHelperSource(): string {
  return [
    "async function __nemoclawNotifyDeniedSlackMention(params) {",
    "\t// nemoclaw: bounded sender-facing feedback for an explicit @-mention whose",
    "\t// command was denied by the channel allowlist. Keeps the command blocked,",
    "\t// never reveals the allowlist, and emits exactly one sender-facing message",
    "\t// (ephemeral in-channel, DM fallback). (#4752)",
    "\tconst { ctx, message, senderId } = params;",
    "\tif (!params.explicitMention) return;",
    "\tconst client = ctx?.app?.client;",
    "\tconst channel = message?.channel;",
    "\tconst user = senderId ?? message?.user;",
    "\tif (!client?.chat || !channel || !user) return;",
    '\tconst text = "Sorry, you\'re not authorized to use this assistant in this channel, so your request was not processed.";',
    "\tconst threadTs = message?.thread_ts ?? message?.ts;",
    "\ttry {",
    "\t\tawait client.chat.postEphemeral({ channel, user, text, ...threadTs ? { thread_ts: threadTs } : {} });",
    "\t\treturn;",
    "\t} catch (ephemeralError) {",
    "\t\t// Only fall back to a DM when Slack definitively did not deliver the",
    "\t\t// ephemeral. Ambiguous failures (network/HTTP, timeout, service errors)",
    "\t\t// may have been accepted, so a DM there could double-notify the sender.",
    '\t\tconst ephemeralErrorCode = ephemeralError?.data?.error ?? ephemeralError?.code;',
    '\t\tctx?.logger?.warn?.({ err: ephemeralError, channel, code: ephemeralErrorCode }, "nemoclaw: slack denial ephemeral feedback failed (#4752)");',
    '\t\tconst nonDeliveryCodes = ["user_not_in_channel", "not_in_channel", "channel_not_found", "cannot_reply_to_message", "is_archived", "messages_tab_disabled"];',
    "\t\tif (!nonDeliveryCodes.includes(ephemeralErrorCode)) return;",
    "\t\ttry {",
    "\t\t\tconst opened = await client.conversations?.open?.({ users: user });",
    "\t\t\tconst dmChannel = opened?.channel?.id;",
    "\t\t\tif (dmChannel) await client.chat.postMessage({ channel: dmChannel, text });",
    "\t\t} catch (dmError) {",
    '\t\t\tctx?.logger?.warn?.({ err: dmError }, "nemoclaw: slack denial DM feedback failed (#4752)");',
    "\t\t}",
    "\t}",
    "}",
    "",
  ].join("\n");
}

function patchPrepareModule(file: string): boolean {
  let source = readFileSync(file, "utf8");
  const original = source;

  // The denial feedback only fires for explicit bot mentions. Require the
  // mention-state identifiers so the patch fails loudly if the deny path no
  // longer exposes them, rather than emitting code that references undefined
  // variables.
  if (
    !source.includes("explicitlyMentionedBotUser") ||
    !source.includes("explicitlyMentionedBotSubteam")
  ) {
    fail(
      `OpenClaw Slack mention-state shape not recognized in ${file}; ` +
        "expected explicitlyMentionedBotUser/explicitlyMentionedBotSubteam in the prepare deny path",
    );
  }

  if (!source.includes(CALL_MARKER)) {
    const denyGate = new RegExp(
      "(logVerbose\\(`Blocked unauthorized slack sender \\$\\{senderId\\} \\(not in channel users\\)`\\);\\n)(\\s*)return null;",
    );
    const next = source.replace(
      denyGate,
      (_match, logLine: string, indent: string) =>
        `${logLine}${indent}await __nemoclawNotifyDeniedSlackMention({ ctx, message, senderId, ` +
        'explicitMention: opts.source === "app_mention" || explicitlyMentionedBotUser || explicitlyMentionedBotSubteam }); ' +
        `// ${CALL_MARKER} (#4752)\n${indent}return null;`,
    );
    if (next === source) {
      fail(`OpenClaw Slack channel-users deny gate shape not recognized in ${file}`);
    }
    source = next;
  }

  if (!source.includes(`async function ${HELPER_MARKER}(`)) {
    const anchor = "async function prepareSlackMessage(params) {";
    if (!source.includes(anchor)) {
      fail(`OpenClaw Slack prepareSlackMessage definition not found in ${file}`);
    }
    source = source.replace(anchor, `${buildHelperSource()}${anchor}`);
  }

  if (source !== original) {
    writeFileSync(file, source);
    return true;
  }
  return false;
}

const packageRoots = findSlackPackageRoots(roots);
if (packageRoots.length === 0) {
  console.log(
    `INFO: no @openclaw/slack package found under ${roots.join(", ")}; skipping Slack denial-feedback patch`,
  );
  process.exit(0);
}

const patchedFiles: string[] = [];
for (const packageRoot of packageRoots) {
  const prepareFile = locatePrepareModule(packageRoot);
  patchPrepareModule(prepareFile);
  const patched = readFileSync(prepareFile, "utf8");
  if (!patched.includes(`async function ${HELPER_MARKER}(`)) {
    fail(`Slack denial-feedback helper did not apply in ${prepareFile}`);
  }
  if (!patched.includes(CALL_MARKER)) {
    fail(`Slack denial-feedback deny-gate call did not apply in ${prepareFile}`);
  }
  patchedFiles.push(prepareFile);
}

console.log(
  `INFO: patched OpenClaw Slack denial feedback in ${patchedFiles.map((file) => relative(process.cwd(), file)).join(", ")}`,
);
