// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Scope boundary for `nemoclaw <name> sessions export`:
//
//   - Invalid state addressed: extracting OpenClaw's per-agent session JSONL
//     out of a running sandbox to the host today requires a two-hop
//     `docker exec kubectl cp` + `docker cp` workaround that bakes in-sandbox
//     paths and TLS quirks into every consumer. This module wraps that flow.
//   - Source boundary:
//       * NemoClaw side (this file): validate the requested agent/keys,
//         resolve canonical keys to session ids via the in-sandbox
//         `openclaw sessions list --json`, build the in-sandbox tar command,
//         download the resulting tarball via `openshell sandbox download`,
//         and best-effort clean up the staging artefact afterwards.
//       * OpenClaw side (upstream `openclaw` npm package): owns the on-disk
//         session store under `/sandbox/.openclaw/agents/<id>/sessions/` and
//         the `sessions.list` index contract. NemoClaw never edits that
//         store and only reads it through the upstream CLI; renaming a key,
//         changing the per-session filename layout, or normalising the
//         `sessions list --json` shape are upstream concerns.
//   - Source-fix constraint: NemoClaw cannot bypass the two-hop transport
//     without reaching into the cluster container's file system, which
//     would violate the sandbox isolation. The wrapper therefore stays a
//     pure orchestrator over `openshell sandbox exec/download` and
//     `openclaw sessions list`.
//   - Regression-test coverage:
//       * Host-side: `src/lib/actions/sandbox/sessions/export.test.ts`
//         covers tar argv construction, index parser shape tolerance, key
//         canonicalisation, agent-scope refusal, leading-dash session id
//         rejection, download-failure cleanup, and JSON manifest shape.
//       * E2E (stub openshell): `test/sandbox-sessions-export-cli.test.ts`
//         exercises the full CLI through dispatch with a fake openshell
//         binary, proving the `exec tar`, `download`, and `exec rm` wire
//         calls happen in the expected order.
//   - Removal condition: the source-boundary comment can be removed when
//     OpenClaw exposes a stable `sessions.export` RPC that returns a
//     ready-to-download bundle path, removing NemoClaw's need to compose
//     the tar command and re-resolve key -> session-id host-side.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { captureOpenshell, runOpenshell } from "../../../adapters/openshell/runtime";
import { CLI_NAME } from "../../../cli/branding";
import * as registry from "../../../state/registry";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { resolveHostPathFromCwd } from "../host-path";
import { isWarmupSessionId } from "../warmup-session";
import { type SessionIndexEntry, parseSessionIndex } from "./session-index";
import {
  DEFAULT_AGENT_ID,
  parseAgentIdFromSessionKey,
  validateAgentId,
  validateSessionKey,
} from "./paths";

export type SessionsExportFormat = "dir" | "tar" | "jsonl";

export interface SessionsExportOptions {
  sandboxName: string;
  agent?: string;
  keys?: readonly string[];
  out?: string;
  format?: SessionsExportFormat;
  includeTrajectory?: boolean;
  json?: boolean;
}

export interface SessionExportEntry {
  key: string;
  sessionId: string;
  // Host path to the session's `<sessionId>.jsonl` in `dir` format; null in
  // `tar` format (the file lives inside the bundle).
  path: string | null;
  sizeBytes: number | null;
}

export interface SessionsExportResult {
  sandboxName: string;
  agent: string;
  format: SessionsExportFormat;
  selectedKeys: string[] | "all";
  resolvedSessionIds: string[];
  resolvedFiles: string[];
  hostDest: string;
  // Tarball size in `tar` format; null in `dir` format.
  bundleBytes: number | null;
  sessions: SessionExportEntry[];
}

// Session ids must start with an alphanumeric character so they can never be
// interpreted as a tar option (`--checkpoint-action=...`, etc.) when appended
// to the argv. Hyphens and underscores remain permitted as inner characters.
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// In-sandbox staging directory for the transient tar bundle. Must live inside
// the `/sandbox` workspace because `openshell sandbox download` refuses any
// source path outside it; using the sandbox's `/tmp` (the previous choice)
// trips that check and aborts the export with a misleading "outside the
// sandbox workspace" error. The hidden `.nemoclaw-staging` prefix keeps the
// directory clearly NemoClaw-owned and separate from OpenClaw's own store.
const STAGING_DIR_IN_SANDBOX = "/sandbox/.nemoclaw-staging";

export async function exportSandboxSessions(
  opts: SessionsExportOptions,
): Promise<SessionsExportResult> {
  if (registry.getSandbox(opts.sandboxName)?.agent === "hermes") {
    return exportHermesSessions(opts);
  }
  const agent = resolveAgentId(opts);
  const trimmedKeys = (opts.keys ?? []).map((value) => validateSessionKey(value));
  enforceAgentScope(agent, trimmedKeys);

  await ensureLiveSandboxOrExit(opts.sandboxName, { allowNonReadyPhase: true });

  const format: SessionsExportFormat = opts.format === "tar" ? "tar" : "dir";
  const sourceDir = `/sandbox/.openclaw/agents/${agent}/sessions`;

  // Always enumerate sessions through the in-sandbox `openclaw sessions list`
  // index, even with no key filter, so the export contains exactly the
  // matching `<sessionId>.jsonl` (+ optional trajectory) files and never
  // picks up `sessions.json`, stale `.jsonl.lock` files, or other store
  // bookkeeping.
  const {
    sessionIds: resolvedSessionIds,
    files: resolvedFiles,
    sessions,
  } = resolveSelectedFiles(opts.sandboxName, agent, trimmedKeys, opts.includeTrajectory ?? false);

  if (resolvedFiles.length === 0) {
    throw new Error(`Refusing to export: agent '${agent}' has no sessions to bundle.`);
  }

  const hostDest = resolveHostDestination(opts.out, opts.sandboxName, agent, format);

  let bundleBytes: number | null = null;
  let exported: SessionExportEntry[];

  if (format === "tar") {
    const tarballRemote = stagingTarballPath(agent);
    const tarArgv = buildSandboxTarArgv({ sourceDir, tarballRemote, resolvedFiles });
    try {
      // Use ignoreError so the underlying spawn helper does not call
      // process.exit on a non-zero tar/download status. Without that, the
      // finally cleanup below would never run and the staged session JSONL
      // would survive in the in-sandbox staging directory.
      const tarResult = runOpenshell(
        [
          "sandbox",
          "exec",
          "--name",
          opts.sandboxName,
          "--",
          "sh",
          "-c",
          buildShellInvocation(tarArgv, tarballRemote),
        ],
        { ignoreError: true, stdio: "inherit" },
      );
      if (tarResult.status !== 0) {
        throw new Error(
          `Failed to tar sessions for agent '${agent}' in sandbox '${opts.sandboxName}' (exit ${tarResult.status}).`,
        );
      }

      const downloadResult = runOpenshell(
        ["sandbox", "download", opts.sandboxName, tarballRemote, hostDest],
        { ignoreError: true, stdio: "inherit" },
      );
      if (downloadResult.status !== 0) {
        throw new Error(
          `Failed to download '${tarballRemote}' from sandbox '${opts.sandboxName}' (exit ${downloadResult.status}).`,
        );
      }
    } finally {
      // Best-effort cleanup of the in-sandbox staging tarball. Runs even when
      // tar/download fail so a partial export cannot leave a bundle of session
      // JSONL behind in the in-sandbox staging directory.
      runOpenshell(
        ["sandbox", "exec", "--name", opts.sandboxName, "--", "rm", "-f", tarballRemote],
        { ignoreError: true, stdio: "ignore" },
      );
    }

    // Session JSONL captures user prompts and tool I/O, which routinely contain
    // pasted secrets. The host tarball lands with the caller's umask, so
    // restrict it to owner-only (the in-sandbox staging copy is already 0600).
    hardenPermissions(hostDest);
    try {
      bundleBytes = fs.statSync(hostDest).size;
    } catch {
      bundleBytes = null;
    }
    // Per-session files live inside the tarball, so the manifest carries ids only.
    exported = sessions.map((entry) => ({
      key: entry.key,
      sessionId: entry.sessionId,
      path: null,
      sizeBytes: null,
    }));
  } else {
    // dir format default: copy each resolved session file straight onto the
    // host into a browsable directory. No in-sandbox staging tarball, so
    // there is no staging window to clean up.
    try {
      fs.mkdirSync(hostDest, { recursive: true });
    } catch (err) {
      throw new Error(`Failed to create export directory '${hostDest}': ${(err as Error).message}`);
    }
    for (const file of resolvedFiles) {
      const localPath = path.join(hostDest, file);
      const downloadResult = runOpenshell(
        ["sandbox", "download", opts.sandboxName, `${sourceDir}/${file}`, localPath],
        { ignoreError: true, stdio: "inherit" },
      );
      if (downloadResult.status !== 0) {
        throw new Error(
          `Failed to download '${file}' from sandbox '${opts.sandboxName}' (exit ${downloadResult.status}).`,
        );
      }
      // Session JSONL can contain pasted secrets — restrict each file to owner-only.
      hardenPermissions(localPath);
    }
    exported = sessions.map((entry) => {
      const localPath = path.join(hostDest, `${entry.sessionId}.jsonl`);
      let sizeBytes: number | null = null;
      try {
        sizeBytes = fs.statSync(localPath).size;
      } catch {
        sizeBytes = null;
      }
      return { key: entry.key, sessionId: entry.sessionId, path: localPath, sizeBytes };
    });
  }

  const result: SessionsExportResult = {
    sandboxName: opts.sandboxName,
    agent,
    format,
    selectedKeys: trimmedKeys.length > 0 ? trimmedKeys : "all",
    resolvedSessionIds,
    resolvedFiles,
    hostDest,
    bundleBytes,
    sessions: exported,
  };

  if (opts.json) {
    console.log(JSON.stringify(result));
  } else {
    const sizeNote = bundleBytes !== null ? ` (${bundleBytes} byte(s))` : "";
    const scope =
      trimmedKeys.length > 0
        ? `${trimmedKeys.length} key(s) on agent '${agent}'`
        : `all sessions for agent '${agent}' (${resolvedSessionIds.length} session(s))`;
    console.error(`  Exported ${scope} to ${hostDest}${sizeNote}`);
  }

  return result;
}

// Scope boundary for `nemoclaw <name> sessions export` on a Hermes sandbox:
//
//   - Invalid state addressed: Hermes owns its session store as an in-sandbox
//     SQLite database that is not directly reachable from the host. Exporting
//     it therefore requires a two-hop orchestration (in-sandbox export, then
//     host-side download), the same shape as the OpenClaw path above but with
//     a different upstream CLI and on-disk contract.
//   - Source boundary:
//       * NemoClaw side (this helper): pick a unique in-sandbox staging path
//         under `/sandbox/.nemoclaw-staging`, run `hermes sessions export`
//         under a `umask 077` + `chmod 600` envelope, download the staged
//         JSONL via `openshell sandbox download`, finalise it onto the host
//         destination via atomic chmod-then-rename, and best-effort clean up
//         the in-sandbox staging file. The cleanup result is captured and
//         surfaced as a warning when non-zero so a sensitive session JSONL
//         is never left behind in the sandbox without telling the user.
//       * Hermes side (upstream `hermes` CLI staged under `agents/hermes/`):
//         owns the SQLite session store and the `hermes sessions export
//         <path>` contract that emits a single JSONL stream. NemoClaw never
//         reads or rewrites that store and only invokes the upstream CLI;
//         changing the store layout or the export shape are upstream
//         concerns.
//   - Source-fix constraint: `openshell sandbox download` refuses any source
//     path outside `/sandbox`, so the staging file must live under
//     `/sandbox/.nemoclaw-staging` (the same hidden, NemoClaw-owned prefix
//     the OpenClaw path uses). NemoClaw cannot read the Hermes SQLite
//     database directly from the host, so the two-hop orchestration is the
//     only safe option until Hermes exposes a host-reachable export RPC.
//   - Regression-test coverage:
//       * Host-side: `export.test.ts > exportSandboxSessions (hermes sandbox)`
//         covers the `hermes sessions export` route, the
//         `/sandbox/.nemoclaw-staging/sessions-export-hermes-<rand>.jsonl`
//         path shape, atomic chmod-then-rename finalisation, the
//         `--agent hermes` no-op alias, refusal of OpenClaw-only options,
//         and the remote cleanup warning on a non-zero `rm -f` exit.
//       * E2E (stub openshell): `test/sandbox-sessions-export-cli.test.ts`
//         exercises the dispatch through the public CLI with a fake
//         openshell binary, proving the `exec hermes sessions export`,
//         `download`, and `exec rm` wire calls happen in the expected order.
//   - Removal condition: this Hermes branch can be removed when Hermes
//     exposes a host-reachable export RPC (or NemoClaw is granted a stable
//     contract for the SQLite store layout), making the two-hop in-sandbox
//     staging + download orchestration unnecessary.
async function exportHermesSessions(opts: SessionsExportOptions): Promise<SessionsExportResult> {
  rejectOpenClawOnlyOptions(opts);
  await ensureLiveSandboxOrExit(opts.sandboxName, { allowNonReadyPhase: true });

  const hostDest = resolveHermesHostDestination(opts.out, opts.sandboxName);
  const stagingRemote = hermesStagingPath();
  const shellCommand = buildHermesShellInvocation(stagingRemote);

  const absoluteHostDest = path.resolve(hostDest);
  const hostStagingDir = fs.mkdtempSync(
    path.join(path.dirname(absoluteHostDest), ".sessions-export-hermes-"),
  );
  const hostStagingPath = path.join(hostStagingDir, path.basename(absoluteHostDest));

  try {
    const exportResult = runOpenshell(
      ["sandbox", "exec", "--name", opts.sandboxName, "--", "sh", "-c", shellCommand],
      { ignoreError: true, stdio: "inherit" },
    );
    if (exportResult.status !== 0) {
      throw new Error(
        `Failed to export hermes sessions in sandbox '${opts.sandboxName}' (exit ${exportResult.status}). Verify the sandbox is live with \`${CLI_NAME} ${opts.sandboxName} status\`.`,
      );
    }

    const downloadResult = runOpenshell(
      ["sandbox", "download", opts.sandboxName, stagingRemote, hostStagingPath],
      { ignoreError: true, stdio: "inherit" },
    );
    if (downloadResult.status !== 0) {
      throw new Error(
        `Failed to download '${stagingRemote}' from sandbox '${opts.sandboxName}' (exit ${downloadResult.status}).`,
      );
    }

    fs.chmodSync(hostStagingPath, 0o600);
    fs.renameSync(hostStagingPath, hostDest);
  } finally {
    // Best-effort cleanup of the in-sandbox staging JSONL. The host throw (if
    // any) is already in flight, so a console.warn here cannot mask it — the
    // primary error still propagates once the `finally` block returns.
    const remoteCleanup = runOpenshell(
      ["sandbox", "exec", "--name", opts.sandboxName, "--", "rm", "-f", stagingRemote],
      { ignoreError: true, stdio: "ignore" },
    );
    if (remoteCleanup.status !== 0) {
      console.warn(
        `  Warning: failed to remove in-sandbox staging file '${stagingRemote}' from sandbox '${opts.sandboxName}' (exit ${remoteCleanup.status}). The file may still contain a session JSONL with pasted secrets; remove it manually with \`${CLI_NAME} sandbox exec --name ${opts.sandboxName} -- rm -f ${stagingRemote}\`.`,
      );
    }
    try {
      fs.rmSync(hostStagingDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(
        `  Warning: failed to remove local staging directory '${hostStagingDir}': ${(cleanupErr as Error).message}. The directory may still contain a session JSONL with pasted secrets; remove it manually.`,
      );
    }
  }

  let bundleBytes: number | null = null;
  try {
    bundleBytes = fs.statSync(hostDest).size;
  } catch {
    bundleBytes = null;
  }

  const result: SessionsExportResult = {
    sandboxName: opts.sandboxName,
    agent: "hermes",
    format: "jsonl",
    selectedKeys: "all",
    resolvedSessionIds: [],
    resolvedFiles: [path.basename(hostDest)],
    hostDest,
    bundleBytes,
    sessions: [],
  };

  if (opts.json) {
    console.log(JSON.stringify(result));
  } else {
    const sizeNote = bundleBytes !== null ? ` (${bundleBytes} byte(s))` : "";
    console.error(`  Exported hermes sessions to ${hostDest}${sizeNote}`);
  }

  return result;
}

function rejectOpenClawOnlyOptions(opts: SessionsExportOptions): void {
  if (opts.agent && opts.agent !== "hermes") {
    throw new Error(
      `Refusing to export: --agent ${opts.agent} is OpenClaw-specific and is not supported on a Hermes sandbox. Pass --agent hermes or omit the flag.`,
    );
  }
  if (opts.keys && opts.keys.length > 0) {
    throw new Error(
      "Refusing to export: positional session keys are OpenClaw-specific. A Hermes sandbox exports the full session store as a single JSONL.",
    );
  }
  if (opts.includeTrajectory) {
    throw new Error(
      "Refusing to export: --include-trajectory is OpenClaw-specific. Hermes has no separate trajectory files.",
    );
  }
  if (opts.format === "tar") {
    throw new Error(
      "Refusing to export: --format tar is OpenClaw-specific. Hermes export is a single JSONL stream.",
    );
  }
}

function hermesStagingPath(): string {
  const suffix = randomBytes(6).toString("hex");
  return `${STAGING_DIR_IN_SANDBOX}/sessions-export-hermes-${suffix}.jsonl`;
}

function buildHermesShellInvocation(stagingRemote: string): string {
  const quotedStaging = shellQuote(stagingRemote);
  const quotedStagingDir = shellQuote(STAGING_DIR_IN_SANDBOX);
  return `umask 077 && mkdir -p ${quotedStagingDir} && chmod 700 ${quotedStagingDir} && hermes sessions export ${quotedStaging} && chmod 600 ${quotedStaging}`;
}

function resolveHermesHostDestination(out: string | undefined, sandboxName: string): string {
  if (out && out.trim()) return out.trim();
  return `./sessions-${sandboxName}.jsonl`;
}

// Restrict a freshly written host artefact to owner-only (0600). Best-effort:
// session JSONL can contain pasted secrets, but a chmod failure (e.g. an exotic
// host filesystem) should warn rather than abort an otherwise-successful export.
function hardenPermissions(target: string): void {
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    console.error(
      `  Warning: could not restrict permissions on ${target}; treat it as sensitive — it may contain session secrets.`,
    );
  }
}

export function buildSandboxTarArgv(input: {
  sourceDir: string;
  tarballRemote: string;
  resolvedFiles: readonly string[];
}): string[] {
  // `--` separates tar options from operands so any file name that happens
  // to start with `-` (even though SAFE_TOKEN_RE forbids that today) cannot
  // be reinterpreted as a tar option.
  const argv: string[] = ["tar", "-czf", input.tarballRemote, "-C", input.sourceDir, "--"];
  for (const file of input.resolvedFiles) argv.push(`./${file}`);
  return argv;
}

function buildShellInvocation(tarArgv: readonly string[], tarballRemote: string): string {
  // umask 077 restricts the staging tarball (mode 600) so a concurrent
  // sandbox user cannot read another agent's session JSONL between the tar
  // step and the download step. The mkdir + chmod 700 pair guarantees the
  // staging directory itself is owner-only even if a previous run (or an
  // unrelated tool) created it with a broader mode.
  const quoted = tarArgv.map(shellQuote).join(" ");
  const quotedTarball = shellQuote(tarballRemote);
  const quotedStagingDir = shellQuote(STAGING_DIR_IN_SANDBOX);
  return `umask 077 && mkdir -p ${quotedStagingDir} && chmod 700 ${quotedStagingDir} && ${quoted} && chmod 600 ${quotedTarball}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._\/=:@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveAgentId(opts: SessionsExportOptions): string {
  if (opts.agent) return validateAgentId(opts.agent);
  for (const key of opts.keys ?? []) {
    const trimmed = key.trim();
    const parsed = parseAgentIdFromSessionKey(trimmed);
    if (parsed) return validateAgentId(parsed);
  }
  return DEFAULT_AGENT_ID;
}

function enforceAgentScope(agent: string, keys: readonly string[]): void {
  for (const key of keys) {
    const parsed = parseAgentIdFromSessionKey(key);
    if (parsed && parsed !== agent) {
      throw new Error(
        `Refusing to export: session key '${key}' is scoped to agent '${parsed}', not '${agent}'.`,
      );
    }
  }
}

function resolveSelectedFiles(
  sandboxName: string,
  agent: string,
  keys: readonly string[],
  includeTrajectory: boolean,
): { sessionIds: string[]; files: string[]; sessions: SessionIndexEntry[] } {
  const index = readSessionIndex(sandboxName, agent);
  const byKey = new Map<string, string>();
  for (const entry of index) byKey.set(entry.key, entry.sessionId);

  const entries: { key: string; sessionId: string }[] = [];
  if (keys.length === 0) {
    // Export-all hides internal warm-up sessions; explicit keys are honored below.
    for (const entry of index) {
      if (isWarmupSessionId(entry.sessionId)) continue;
      entries.push(entry);
    }
  } else {
    const missing: string[] = [];
    for (const key of keys) {
      const sessionId = byKey.get(key) ?? byKey.get(normaliseToCanonical(agent, key)) ?? null;
      if (!sessionId) {
        missing.push(key);
        continue;
      }
      entries.push({ key, sessionId });
    }
    if (missing.length > 0) {
      throw new Error(
        `Refusing to export: no entries found in agent '${agent}' for key(s): ${missing.join(", ")}.`,
      );
    }
  }

  const seen = new Set<string>();
  const sessionIds: string[] = [];
  const files: string[] = [];
  const sessions: SessionIndexEntry[] = [];
  for (const { key, sessionId } of entries) {
    if (!SAFE_TOKEN_RE.test(sessionId)) {
      throw new Error(
        `Refusing to tar: session id '${sessionId}' resolved for key '${key}' contains unsafe characters or starts with '-'.`,
      );
    }
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    sessionIds.push(sessionId);
    sessions.push({ key, sessionId });
    files.push(`${sessionId}.jsonl`);
    if (includeTrajectory) files.push(`${sessionId}.trajectory.jsonl`);
  }
  return { sessionIds, files, sessions };
}

function normaliseToCanonical(agent: string, key: string): string {
  if (key.startsWith("agent:")) return key;
  return `agent:${agent}:${key}`;
}

function readSessionIndex(sandboxName: string, agent: string): SessionIndexEntry[] {
  const result = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "openclaw",
      "sessions",
      "list",
      "--agent",
      agent,
      "--json",
    ],
    { ignoreError: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to list sessions in sandbox '${sandboxName}' for agent '${agent}' (exit ${result.status}). Verify the sandbox is live with \`${CLI_NAME} ${sandboxName} status\`.`,
    );
  }
  const parsed = parseSessionIndex(result.output);
  if (parsed === null) {
    throw new Error(
      `Could not parse \`openclaw sessions list --agent ${agent} --json\` output as a session index. Check the OpenClaw version pinned in agents/openclaw/manifest.yaml.`,
    );
  }
  return parsed;
}

function stagingTarballPath(agent: string): string {
  const suffix = randomBytes(6).toString("hex");
  return `${STAGING_DIR_IN_SANDBOX}/sessions-export-${agent}-${suffix}.tgz`;
}

function resolveHostDestination(
  out: string | undefined,
  sandboxName: string,
  agent: string,
  format: SessionsExportFormat,
): string {
  if (out && out.trim()) return resolveHostPathFromCwd(out.trim());
  // dir is the default: a browsable `sessions-<sandbox>/` tree. tar keeps the
  // single-bundle name for share/upload cases. Both defaults are resolved
  // against the caller's process.cwd() so the host artefact lands where the
  // user invoked the CLI from, not inside the install directory that
  // `runOpenshell` pins as the child's cwd.
  const fallback =
    format === "tar" ? `sessions-${sandboxName}-${agent}.tgz` : `sessions-${sandboxName}/`;
  return resolveHostPathFromCwd(fallback);
}
