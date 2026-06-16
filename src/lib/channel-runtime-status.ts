// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "./core/shell-quote";

/**
 * Probe the OpenClaw runtime channel registry from inside a sandbox.
 *
 * Issue #4156: a user can have a valid channel block in `openclaw.json` on
 * the host but the dashboard's "Channels — Gateway-wide channel status
 * snapshot" panel still reports "No channels found" because NemoClaw
 * never compared the registered set with the runtime's view. The
 * post-create verification and the doctor diagnostic both reach into this
 * module so the answer is consistent across surfaces.
 *
 * Two probe layers, intentionally separate:
 *
 *   1. **Config layer** (`extractEnabledChannelsFromOpenclawConfig`) reads
 *      `/sandbox/.openclaw/openclaw.json` — the same file OpenClaw parses
 *      at startup. Catches "config never had the channel" failures and
 *      malformed-schema cases where NemoClaw's generator wrote something
 *      the runtime can't load. Cheap and deterministic.
 *
 *   2. **Runtime layer** (`probeChannelRuntimeStatus`) tails the gateway
 *      log at `/tmp/gateway.log` and checks each channel name. The log is
 *      where the OpenClaw process records its own boot events. If a
 *      manifest-declared channel never appears in the log, the runtime
 *      never tried to start it — the exact symptom behind
 *      "No channels found" in the dashboard.
 *
 * The two signals combine: a channel is "runtime-visible" only when both
 * the config exposes it AND the runtime log shows it. A channel present
 * in config but absent from the log is the #4156 failure mode and is
 * reported separately so the diagnostic can give the operator a precise
 * next step (the dashboard view, the gateway log) instead of a generic
 * "messaging may be broken" message.
 *
 * Pure JSON / log parsing is split from the SSH/exec probes so the
 * comparison logic stays unit-testable without touching a sandbox.
 */

import {
  listOpenClawRuntimeChannelMetadata,
  type OpenClawRuntimeChannelMetadata,
} from "./messaging/channels/metadata";

const DEFAULT_RUNTIME_VISIBILITY_METADATA = listOpenClawRuntimeChannelMetadata();

export type RuntimeChannelStatus = {
  /**
   * True when at least the config layer was read and parsed. False on SSH
   * failure, missing file, empty stdout, or invalid JSON — `detail`
   * carries the specific reason so callers can surface an actionable hint.
   */
  ok: boolean;
  /**
   * Channels the runtime exposes — config has them AND the gateway log
   * confirms the runtime acknowledged them. Sorted, deduplicated. Empty
   * when `logProbeOk` is false, since we have no log to corroborate.
   */
  visibleChannels: string[];
  /**
   * Channels that the in-sandbox config (the file at `configFilePath`)
   * has marked as enabled. Always populated when `ok` is true, regardless
   * of the gateway log layer — gives callers a way to detect stale
   * rebuilds (registry expects telegram, but `openclaw.json` dropped it)
   * even when the runtime layer cannot corroborate.
   */
  configuredChannels: string[];
  /**
   * Channels present in `openclaw.json` but never mentioned in the
   * gateway log. This is the #4156 failure signature: configured but the
   * runtime never started the bridge, so the dashboard's "Channels"
   * panel renders "No channels found" even though config looks right.
   * Empty when the log was unreachable or no configured channels were
   * missing from it (use `logProbeOk` to distinguish those cases).
   */
  configuredButNotRunning: string[];
  /**
   * True when the gateway log probe succeeded. False when the log was
   * missing or unreadable — in that case `configuredButNotRunning` will
   * be empty even if the runtime is genuinely broken, so the caller
   * should treat the result as config-only.
   */
  logProbeOk: boolean;
  detail: string;
};

export interface ChannelRuntimeStatusDeps {
  /** Absolute path inside the sandbox, e.g. `/sandbox/.openclaw/openclaw.json`. */
  configFilePath: string;
  /**
   * Path to the in-sandbox gateway log. Defaults to `/tmp/gateway.log`
   * (the path OpenClaw's gateway writes when the agent starts).
   * Override only when running an alternate agent layout that ships logs
   * elsewhere.
   */
  gatewayLogPath?: string;
  /** Sandbox shell exec — returns `null` when the exec itself failed. */
  executeSandboxCommand: (
    script: string,
  ) => { status: number; stdout: string; stderr: string } | null;
}

/**
 * Extract the set of channels with at least one enabled account from a parsed
 * OpenClaw config. Returns a sorted, deduplicated list of canonical channel
 * names. Unknown keys under `channels.*` are ignored — manifest-side
 * channel names are authoritative.
 */
export function extractEnabledChannelsFromOpenclawConfig(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const channels = (json as Record<string, unknown>).channels;
  if (!channels || typeof channels !== "object") return [];
  const channelKeyToName = runtimeConfigKeyToChannelName(DEFAULT_RUNTIME_VISIBILITY_METADATA);
  const visible = new Set<string>();
  for (const [key, value] of Object.entries(channels as Record<string, unknown>)) {
    const canonical = channelKeyToName.get(key);
    if (!canonical) continue;
    if (!value || typeof value !== "object") continue;
    const accounts = (value as Record<string, unknown>).accounts;
    if (!accounts || typeof accounts !== "object") continue;
    for (const account of Object.values(accounts as Record<string, unknown>)) {
      if (
        account &&
        typeof account === "object" &&
        (account as Record<string, unknown>).enabled === true
      ) {
        visible.add(canonical);
        break;
      }
    }
  }
  return [...visible].sort();
}

// Sentinel header the gateway-log scan script always echoes when the log
// file is readable. Distinguishes "log missing entirely" (no stdout) from
// "log present but no channels matched" (header echoed, no FOUND: lines).
const LOG_PROBE_OK_MARKER = "GATEWAY_LOG_PROBED";
const LOG_FOUND_PREFIX = "FOUND:";

// Regex the awk filter uses to detect a new gateway launch. Tracks both
// the initial-launch line and the respawn line written by
// `scripts/nemoclaw-start.sh` (search for "openclaw gateway launched" and
// "respawning" in that file). Whenever the awk pass sees this marker, it
// drops everything accumulated so far — the result is the slice of the
// log file written since the most recent boot. Without this, stale
// channel mentions from a previous gateway run would still satisfy the
// probe even though the *current* OpenClaw process never started that
// channel (#4156 review).
const GATEWAY_BOOT_MARKER_REGEX = "\\[gateway\\].*(launched|respawning)";

/**
 * Build a shell snippet that probes the gateway log file. Returns each
 * channel pattern the *current* OpenClaw launch segment mentions as a
 * `FOUND:<pattern>` line, prefixed by a `GATEWAY_LOG_PROBED` sentinel so
 * "log missing" and "log present, no channel matched" stay distinguishable.
 *
 * Two-pass design (one awk + one grep) so cost stays bounded even on
 * long-lived sandboxes:
 *
 *   1. `awk` walks the log once, discarding lines and resetting its
 *      buffer every time the gateway boot/respawn marker fires. The
 *      buffer at EOF is the slice written since the most recent launch.
 *   2. `grep -iwoE` pulls just channel-name tokens out of that slice;
 *      `sort -fu` collapses duplicates so the output is bounded by the
 *      number of channel patterns (today: 6).
 *
 * Pure builder — no side effects, exported for unit testing the exact
 * script the probe emits.
 */
export function buildGatewayLogScanScript(gatewayLogPath: string): string {
  const quotedPath = shellQuote(gatewayLogPath);
  const patternAlternation = runtimeLogPatterns(DEFAULT_RUNTIME_VISIBILITY_METADATA)
    .map(escapeExtendedRegexLiteral)
    .join("|");
  // The awk program uses single-quoted strings inside the shell single-
  // quote context, so we escape the embedded single quotes the same way
  // `shellQuote` does — '\'' ends the outer quote, injects a literal,
  // re-enters the quoted segment.
  const awkProgram = `/${GATEWAY_BOOT_MARKER_REGEX}/ { buf=""; next } { buf = buf $0 ORS } END { printf "%s", buf }`;
  const escapedAwkProgram = awkProgram.replace(/'/g, "'\\''");
  // `test -r` handles missing and permission-denied uniformly. The
  // awk-then-grep pipeline reads the file once and emits at most one
  // line per channel match.
  return (
    `if test -r ${quotedPath}; then ` +
    `echo ${LOG_PROBE_OK_MARKER}; ` +
    `awk '${escapedAwkProgram}' ${quotedPath} 2>/dev/null | ` +
    `grep -iwoE '${patternAlternation}' 2>/dev/null | sort -fu | ` +
    `sed 's/^/${LOG_FOUND_PREFIX}/'` +
    `; fi`
  );
}

/**
 * Parse the stdout of `buildGatewayLogScanScript` into a Set of canonical
 * channel names that the runtime has acknowledged. Both `openclaw-weixin`
 * and `wechat` patterns collapse onto the `wechat` channel name. Matches
 * are case-insensitive because `grep -iwoE` echoes whatever case the log
 * actually contained.
 */
export function parseGatewayLogScanOutput(stdout: string): Set<string> {
  const found = new Set<string>();
  const patternToChannel = runtimeLogPatternToChannelName(DEFAULT_RUNTIME_VISIBILITY_METADATA);
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(LOG_FOUND_PREFIX)) continue;
    const pattern = trimmed.slice(LOG_FOUND_PREFIX.length).toLowerCase();
    const channel = patternToChannel.get(pattern);
    if (channel) found.add(channel);
  }
  return found;
}

const DEFAULT_GATEWAY_LOG_PATH = "/tmp/gateway.log";

function runtimeConfigKeyToChannelName(
  outputs: readonly OpenClawRuntimeChannelMetadata[],
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const output of outputs) {
    for (const key of output.configKeys) {
      aliases.set(key, output.channelId);
    }
  }
  return aliases;
}

function runtimeLogPatterns(outputs: readonly OpenClawRuntimeChannelMetadata[]): string[] {
  return [
    ...new Set(outputs.flatMap((output) => output.logPatterns).filter((entry) => entry.length > 0)),
  ];
}

function runtimeLogPatternToChannelName(
  outputs: readonly OpenClawRuntimeChannelMetadata[],
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const output of outputs) {
    for (const pattern of output.logPatterns) {
      aliases.set(pattern.toLowerCase(), output.channelId);
    }
  }
  return aliases;
}

function escapeExtendedRegexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Read the in-sandbox agent config AND the gateway log to determine which
 * channels the runtime exposes to the dashboard. Returns:
 *
 *   - `visibleChannels`: configured AND mentioned in the gateway log
 *     (the runtime has acknowledged the channel exists).
 *   - `configuredButNotRunning`: configured but NOT mentioned in the log
 *     (the #4156 symptom — runtime ignored the channel; dashboard will
 *     render "No channels found" for it).
 *   - `logProbeOk`: false if the gateway log was missing or unreadable;
 *     in that case the config probe still ran but the runtime layer
 *     could not corroborate.
 *
 * The probe is intentionally conservative: any failure to read the config
 * (sandbox unreachable, file missing, invalid JSON) is surfaced as
 * `ok: false` so callers can either warn or, when a deeper probe is
 * desired, decide to fail. The detail string is the one the caller
 * should render verbatim in a diagnostic hint.
 */
export function probeChannelRuntimeStatus(deps: ChannelRuntimeStatusDeps): RuntimeChannelStatus {
  const configFilePath = deps.configFilePath;
  const result = deps.executeSandboxCommand(
    `cat ${shellQuote(configFilePath)} 2>/dev/null || true`,
  );
  if (!result) {
    return {
      ok: false,
      visibleChannels: [],
      configuredChannels: [],
      configuredButNotRunning: [],
      logProbeOk: false,
      detail: "sandbox unreachable (could not read runtime channel config)",
    };
  }
  const stdout = (result.stdout || "").trim();
  if (!stdout) {
    return {
      ok: false,
      visibleChannels: [],
      configuredChannels: [],
      configuredButNotRunning: [],
      logProbeOk: false,
      detail: `runtime channel config ${configFilePath} is missing or empty`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      visibleChannels: [],
      configuredChannels: [],
      configuredButNotRunning: [],
      logProbeOk: false,
      detail: `runtime channel config ${configFilePath} is not valid JSON: ${message}`,
    };
  }
  const configuredChannels = extractEnabledChannelsFromOpenclawConfig(parsed);

  // Second layer: gateway log. We do not fail the probe when the log is
  // unreadable — the config check is still valuable on its own — but we
  // flag `logProbeOk: false` so callers know the runtime layer didn't
  // corroborate, and they can downgrade their certainty accordingly.
  //
  // Use `grep -m 1` (early exit on first match) over the whole file rather
  // than a tail window: channel-startup lines fire once per boot, and a
  // long-lived sandbox can scroll them out of the last few hundred lines.
  // The `LOG_FOUND_PREFIX` sentinel pattern lets us tell "log missing"
  // (empty stdout) apart from "log present but no channels matched"
  // (stdout has the sentinel header but no FOUND: lines). Each `grep` is
  // O(file size) but exits at the first match, so worst case is a single
  // O(file) scan per missing pattern — bounded and predictable.
  const gatewayLogPath = deps.gatewayLogPath || DEFAULT_GATEWAY_LOG_PATH;
  const logScript = buildGatewayLogScanScript(gatewayLogPath);
  const logResult = deps.executeSandboxCommand(logScript);
  const logStdout = logResult && typeof logResult.stdout === "string" ? logResult.stdout : "";
  const logProbeOk = logStdout.includes(LOG_PROBE_OK_MARKER);
  if (!logProbeOk) {
    // Keep `visibleChannels` strictly log-corroborated — returning the
    // configured set there would let any caller diffing against it
    // treat an inconclusive probe as healthy (CodeRabbit catch on PR
    // #4182). `configuredChannels` still carries the config-derived
    // set so the caller can detect stale rebuilds (registry expects
    // a channel that `openclaw.json` no longer contains) even when the
    // log layer is unavailable.
    return {
      ok: true,
      visibleChannels: [],
      configuredChannels,
      configuredButNotRunning: [],
      logProbeOk: false,
      detail: `config ${configFilePath} parsed; gateway log ${gatewayLogPath} unreadable, runtime confirmation skipped`,
    };
  }
  const mentioned = parseGatewayLogScanOutput(logStdout);
  const visibleChannels: string[] = [];
  const configuredButNotRunning: string[] = [];
  for (const channel of configuredChannels) {
    if (mentioned.has(channel)) {
      visibleChannels.push(channel);
    } else {
      configuredButNotRunning.push(channel);
    }
  }
  visibleChannels.sort();
  configuredButNotRunning.sort();
  return {
    ok: true,
    visibleChannels,
    configuredChannels,
    configuredButNotRunning,
    logProbeOk: true,
    detail: `config ${configFilePath} parsed and gateway log ${gatewayLogPath} corroborated`,
  };
}

/**
 * Compare configured channels (the registry view) with channels the runtime
 * would expose. Returns missing (configured but not visible at runtime) and
 * unexpected (visible at runtime but not configured locally) sets, sorted
 * for stable rendering. Both inputs are deduplicated on the way in so a
 * caller does not need to normalize first.
 */
export function compareChannelSets(
  configured: readonly string[],
  visible: readonly string[],
): { missing: string[]; unexpected: string[] } {
  const visibleSet = new Set(visible);
  const configuredSet = new Set(configured);
  const missing = [...configuredSet].filter((name) => !visibleSet.has(name)).sort();
  const unexpected = [...visibleSet].filter((name) => !configuredSet.has(name)).sort();
  return { missing, unexpected };
}
