// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { CLI_NAME } from "../../../cli/branding";
import * as registry from "../../../state/registry";
import { buildOpenshellExecArgs, computeExitCode, execSandbox } from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { isWarmupSessionId, WARMUP_SESSION_ID_PREFIX } from "../warmup-session";
import { balancedJsonCandidates, parseSessionIndex } from "./session-index";

const SESSIONS_LIST_CAPTURE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type SessionsPassthroughVerb = "list";

export interface SessionsPassthroughOptions {
  verb?: SessionsPassthroughVerb;
  extraArgs?: readonly string[];
}

export function hasSessionsPassthroughHelpToken(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

export function printSessionsPassthroughHelp(verb?: SessionsPassthroughVerb): void {
  const usageSuffix = verb ? ` ${verb}` : "";
  const hermesUsageSuffix = verb ? ` ${verb}` : " list";
  const flagsToken = verb ? `sessions-${verb}-flags` : "sessions-flags";
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <name> sessions${usageSuffix} [${flagsToken}...]`);
  console.log("");
  console.log(
    `  Pass-through to the sandbox agent's \`sessions${usageSuffix} ...\` command inside the sandbox`,
  );
  console.log("  via `openshell sandbox exec` — `openclaw sessions ...` for OpenClaw sandboxes,");
  console.log(
    `  \`hermes sessions${hermesUsageSuffix} ...\` for Hermes sandboxes; the in-sandbox binary is picked`,
  );
  console.log("  from the sandbox's agent.");
  console.log(
    "  On OpenClaw sandboxes, internal NemoClaw onboard warm-up sessions are hidden from default",
  );
  console.log(
    "  list output and OpenClaw-specific flags are forwarded verbatim. Hermes sandboxes pass",
  );
  console.log("  through their native output unchanged.");
  console.log("");
}

function isFilterableListPassthrough(verb: SessionsPassthroughVerb | undefined) {
  return verb === undefined || verb === "list";
}

function isJsonOutput(args: readonly string[]) {
  return args.includes("--json");
}

function sessionEntryIsWarmup(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const obj = entry as Record<string, unknown>;
  for (const field of ["sessionId", "id"]) {
    const value = obj[field];
    if (typeof value === "string" && isWarmupSessionId(value)) return true;
  }
  return false;
}

function filterWarmupArray(entries: unknown[]): { entries: unknown[]; removed: number } {
  const filtered = entries.filter((entry) => !sessionEntryIsWarmup(entry));
  return { entries: filtered, removed: entries.length - filtered.length };
}

function jsonCandidates(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return ["[]"];
  const lines = trimmed.split(/\r?\n/);
  const candidates = balancedJsonCandidates(trimmed);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trim();
    if (candidate && (candidate.startsWith("[") || candidate.startsWith("{"))) {
      candidates.push(candidate);
    }
  }
  candidates.push(trimmed);
  return candidates;
}

function parseJsonPayload(output: string): unknown | null {
  for (const candidate of jsonCandidates(output)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next tolerant candidate; OpenClaw may prefix Node warnings.
    }
  }
  return null;
}

function filterWarmupSessionsListPayload(parsed: unknown): unknown | null {
  if (Array.isArray(parsed)) {
    return filterWarmupArray(parsed).entries;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;
  let sawSessionArray = false;
  let removedTotal = 0;
  const next = { ...obj };
  for (const key of ["sessions", "entries", "items"]) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    sawSessionArray = true;
    const { entries, removed } = filterWarmupArray(value);
    next[key] = entries;
    removedTotal += removed;
  }
  if (!sawSessionArray) return null;
  if (removedTotal === 0) return parsed;
  if (typeof next.count === "number") next.count = Math.max(0, next.count - removedTotal);
  if (typeof next.totalCount === "number") {
    next.totalCount = Math.max(0, next.totalCount - removedTotal);
  }
  return next;
}

function writeWithTrailingNewline(stream: NodeJS.WriteStream, value: string | undefined): void {
  if (!value) return;
  stream.write(value.endsWith("\n") ? value : `${value}\n`);
}

function capturedStdout(result: { output: string; stdout?: string }): string {
  return typeof result.stdout === "string" ? result.stdout.trim() : result.output;
}

function capturedStderr(result: { stderr?: string }): string {
  return typeof result.stderr === "string" ? result.stderr.trim() : "";
}

function printJsonParseFailure(): void {
  console.error(
    "  Could not parse `openclaw sessions list --json` output as a session index. Check the OpenClaw version pinned in agents/openclaw/manifest.yaml.",
  );
}

function printSessionsListCaptureBufferFailure(): void {
  console.error(
    `  OpenClaw sessions list output exceeded NemoClaw's ${Math.round(
      SESSIONS_LIST_CAPTURE_MAX_BUFFER_BYTES / 1024 / 1024,
    )} MiB filtering buffer. Retry with narrower OpenClaw filters such as --agent, --limit, or --json.`,
  );
}

function isCaptureBufferFailure(result: { error?: Error }): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
}

export function filterWarmupSessionsListJson(output: string): string | null {
  const parsedIndex = parseSessionIndex(output);
  if (parsedIndex === null) {
    return null;
  }

  const parsedPayload = parseJsonPayload(output);
  const filteredPayload =
    parsedPayload === null ? null : filterWarmupSessionsListPayload(parsedPayload);
  if (filteredPayload !== null) {
    return JSON.stringify(filteredPayload, null, 2);
  }

  const sessions = parsedIndex.filter((entry) => !isWarmupSessionId(entry.sessionId));
  return JSON.stringify({ count: sessions.length, totalCount: sessions.length, sessions }, null, 2);
}

function warmupIdInTextRow(line: string): boolean {
  const escapedPrefix = WARMUP_SESSION_ID_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labeledSessionId = new RegExp(`\\b(?:id|sessionId|sid):${escapedPrefix}`);
  const bareSessionIdColumn = new RegExp(`(?:^|\\s)${escapedPrefix}[^\\s]*(?:\\s|$)`);
  return labeledSessionId.test(line) || bareSessionIdColumn.test(line);
}

// Text output is a compatibility wrapper around OpenClaw's non-TTY table.
// OpenClaw owns the table format and currently stores NemoClaw's onboarding
// scope-upgrade warm-up as a normal session, so we hide rows whose session-id
// field uses the internal warm-up prefix. The accepted source boundary is only
// session-id shaped cells (`id:`, `sessionId:`, `sid:`, or a bare id column), not
// arbitrary notes that merely mention the prefix. Prefer the JSON path for
// stable structure; remove this text filter when OpenClaw can mark/prevent the
// internal warm-up session or NemoClaw renders list output from stable JSON.
export function filterWarmupSessionsListText(output: string): string {
  const lines = output.split(/\r?\n/);
  let removed = 0;
  const filtered = lines.filter((line) => {
    if (!warmupIdInTextRow(line)) return true;
    removed += 1;
    return false;
  });
  if (removed === 0) return output;
  return filtered
    .map((line) =>
      line.replace(/^(Sessions listed:\s*)(\d+)(.*)$/, (_match, prefix, count, suffix) => {
        const nextCount = Math.max(0, Number.parseInt(count, 10) - removed);
        return `${prefix}${nextCount}${suffix}`;
      }),
    )
    .join("\n");
}

export async function runSessionsPassthrough(
  sandboxName: string,
  { verb, extraArgs = [] }: SessionsPassthroughOptions = {},
): Promise<void> {
  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });
  // Hermes sandboxes ship the `hermes` binary in place of OpenClaw's
  // `openclaw` binary, and `openclaw` does not exist inside them (#6247).
  // Route the passthrough at the in-sandbox agent's own binary name and
  // bypass the OpenClaw-specific warm-up filter for non-OpenClaw agents.
  //
  // Trust boundary: `registry.getSandbox()` reads the host-side, user-owned
  // `~/.nemoclaw/sandboxes.json` registry (`REGISTRY_FILE`). Sandbox processes
  // cannot access the host filesystem to change this agent selection; unknown
  // or missing values deliberately default to `openclaw` below.
  const sandboxAgent = registry.getSandbox(sandboxName)?.agent;
  const inSandboxBinary = sandboxAgent === "hermes" ? "hermes" : "openclaw";
  const command = [inSandboxBinary, "sessions"];
  if (verb) command.push(verb);
  else if (inSandboxBinary === "hermes") command.push("list");
  for (const arg of extraArgs) command.push(arg);
  if (isFilterableListPassthrough(verb) && inSandboxBinary === "openclaw") {
    const result = captureOpenshell(buildOpenshellExecArgs(sandboxName, command), {
      ignoreError: true,
      includeStreams: true,
      maxBuffer: SESSIONS_LIST_CAPTURE_MAX_BUFFER_BYTES,
    });
    const { code, errorMessage } = computeExitCode(result);
    const capturedOutput = capturedStdout(result);
    const capturedError = capturedStderr(result);
    if (code !== 0) {
      writeWithTrailingNewline(process.stdout, capturedOutput);
      writeWithTrailingNewline(process.stderr, capturedError);
      if (isCaptureBufferFailure(result)) {
        printSessionsListCaptureBufferFailure();
      } else if (errorMessage) {
        console.error(`  Failed to invoke openshell: ${errorMessage}`);
      }
      process.exit(code);
    }

    if (isJsonOutput(extraArgs)) {
      const filtered = filterWarmupSessionsListJson(capturedOutput);
      if (filtered === null) {
        // Preserve pass-through compatibility unless the raw payload could leak
        // an internal warm-up session.
        if (capturedOutput.includes(WARMUP_SESSION_ID_PREFIX)) {
          printJsonParseFailure();
          process.exit(1);
        }
        writeWithTrailingNewline(process.stdout, capturedOutput);
        writeWithTrailingNewline(process.stderr, capturedError);
        return;
      }
      writeWithTrailingNewline(process.stdout, filtered);
      writeWithTrailingNewline(process.stderr, capturedError);
      return;
    }

    const filtered = filterWarmupSessionsListText(capturedOutput);
    writeWithTrailingNewline(process.stdout, filtered);
    writeWithTrailingNewline(process.stderr, capturedError);
    return;
  }
  await execSandbox(sandboxName, command);
}
