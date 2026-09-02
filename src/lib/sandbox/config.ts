// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side sandbox configuration management.
//
// All config commands are agent-aware: the sandbox registry records which
// agent runs in each sandbox (openclaw, hermes, etc.), and agent-defs.ts
// provides the per-agent config paths and formats. This module resolves
// those at runtime so the same CLI surface works for any agent.
//
// config get:          Read-only inspection with credential redaction.
// config set:          Host-initiated config mutation with validation.
// config rotate-token: Credential rotation via stdin or env var.

import type { AgentConfigTarget } from "./agent-config";

export type { AgentConfigTarget } from "./agent-config";

const {
  DEFAULT_AGENT_CONFIG,
  resolveAgentConfig: resolveAgentConfigTarget,
}: typeof import("./agent-config") = require("./agent-config");
const {
  stripAnsi,
}: typeof import("../adapters/openshell/client") = require("../adapters/openshell/client");
const { createHash } = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promises: dnsPromises } = require("node:dns");
const { isIP } = require("node:net");
const { isErrnoException }: typeof import("../core/errno") = require("../core/errno");
const { validateName } = require("../runner");
const { shellQuote } = require("../core/shell-quote");
const credentialFilter: typeof import("../security/credential-filter") = require("../security/credential-filter");
const { stripCredentials, isConfigObject, isConfigValue, isCredentialField } = credentialFilter;
const { appendAuditEntry } = require("../shields/audit");
const {
  withTimerBoundShieldsMutationLock,
}: typeof import("../shields/timer-bound-lock") = require("../shields/timer-bound-lock");
const {
  withSandboxMutationLock,
}: typeof import("../state/mcp-lifecycle-lock") = require("../state/mcp-lifecycle-lock");
const {
  runOpenClawConfigGuard,
  validateOpenClawConfigCandidate,
}: typeof import("../shields/openclaw-config-lock") = require("../shields/openclaw-config-lock");
const {
  isAllowedOpenShellSandboxBridgeUrl,
  isPrivateHostname,
  isPrivateIp,
}: typeof import("../private-networks") = require("../private-networks");
const {
  capturePrivilegedSandboxCommand,
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
  withPrivilegedSandboxExecutionLease,
}: typeof import("./privileged-exec") = require("./privileged-exec");
const {
  buildHermesUpstreamHeader,
}: typeof import("./hermes-upstream-header") = require("./hermes-upstream-header");
const {
  parseConfig,
  serializeConfig,
}: typeof import("./config-format") = require("./config-format");
const {
  OPENSHELL_OPERATION_TIMEOUT_MS,
}: typeof import("../adapters/openshell/timeouts") = require("../adapters/openshell/timeouts");
const { redactFull }: typeof import("../security/redact") = require("../security/redact");
const {
  loadRotateTokenSession,
  readStdin,
  rotateSandboxToken,
}: typeof import("./config-rotate-token") = require("./config-rotate-token");

type ConfigObject = import("../security/credential-filter").ConfigObject;
type ConfigValue = import("../security/credential-filter").ConfigValue;
const { runOpenshellCommand, captureOpenshellCommand } = require("../adapters/openshell/client");

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Agent-aware config resolution
//
// Each agent defines its own config layout in agents/*/manifest.yaml:
//   - openclaw: /sandbox/.openclaw/openclaw.json  (JSON)
//   - hermes:   /sandbox/.hermes/config.yaml      (YAML)
//
// resolveAgentConfig() looks up the sandbox's agent from the registry,
// loads the agent definition, and returns the paths and format needed
// to read/write that agent's config from the host.
// ---------------------------------------------------------------------------

type LookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family?: number }>>;

interface DnsValidatedUrl {
  protocol: "http:" | "https:";
  originalUrl: string;
  pinnedUrl: string;
}

interface ConfigUrlValidationOptions {
  allowOpenShellBridge?: boolean;
  allowOpenShellBridgePath?: (path: readonly string[]) => boolean;
  allowPrivateUrls?: boolean;
}

type ManagedGatewayRestart = (sandboxName: string) => { ok: boolean };

export class SandboxConfigError extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number;

  constructor(lines: string | readonly string[], exitCode = 1) {
    const normalized = Array.isArray(lines) ? lines : [lines];
    super(normalized.join("\n"));
    this.name = "SandboxConfigError";
    this.lines = normalized;
    this.exitCode = exitCode;
  }
}

function configFail(lines: string | readonly string[], exitCode = 1): never {
  throw new SandboxConfigError(lines, exitCode);
}

function restartSandboxAgentAfterConfigSet(
  sandboxName: string,
  agentName: string,
  restartImpl?: ManagedGatewayRestart,
): void {
  const restart =
    restartImpl ??
    (require("../actions/sandbox/process-recovery").restartSandboxGateway as ManagedGatewayRestart);
  const result = restart(sandboxName);
  if (!result.ok) {
    // The config was already written to disk (the CAS write above succeeded),
    // but the running agent was not reloaded. Say so plainly and point at the
    // idempotent retry rather than leaving disk and the live gateway silently
    // diverged. The restart layer has already printed its own failure detail.
    configFail([
      `  Config was written to disk but NOT applied to the running agent.`,
      `  The ${agentName} gateway restart did not complete for '${sandboxName}' (see the failure above).`,
      `  Retry the restart with: nemoclaw ${shellQuote(sandboxName)} gateway restart`,
    ]);
  }
}

function buildConfigSetRestartGuidance(sandboxName: string, agentName: string): string[] {
  if (agentName === "hermes") {
    return [
      "  Note: Hermes may restart its gateway when it applies this configuration.",
      `  Use --restart to request and verify a restart, or run: nemoclaw ${shellQuote(sandboxName)} gateway restart`,
    ];
  }
  if (agentName === "openclaw") {
    return [
      "  Note: Some config changes require a sandbox restart to take effect.",
      `  Re-run with --restart or run: nemoclaw ${shellQuote(sandboxName)} gateway restart`,
    ];
  }

  return [
    "  Note: Some config changes require restarting the agent runtime to take effect.",
    `  Follow the restart procedure for '${agentName}'; NemoClaw does not manage restarts for this agent.`,
  ];
}

export class ConfigUrlValidationError extends Error {
  constructor(
    readonly urlValue: string,
    message: string,
    readonly reason: "dns_backed_https_unsupported" | "invalid" = "invalid",
  ) {
    super(message);
    this.name = "ConfigUrlValidationError";
  }
}

const HERMES_STRICT_HASH_FILE = "/etc/nemoclaw/hermes.config-hash";
const HERMES_RUNTIME_CONFIG_GUARD = "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py";
const HERMES_PYTHON = "/opt/hermes/.venv/bin/python";
const HERMES_RESTART_SEAL_STATE = "/run/nemoclaw/hermes-restart-seal.json";
const MAX_OPENCLAW_CONFIG_BYTES = 16 * 1024 * 1024;
const CONFIG_CAPTURE_MAX_BUFFER = MAX_OPENCLAW_CONFIG_BYTES + 1024 * 1024;
const OPENCLAW_CONFIG_GUARD_TIMEOUT_MS = 6 * 60 * 1000;
const HERMES_CONFIG_GUARD_TIMEOUT_MS = 150_000;
const CONFIG_SOURCE_SHA256: unique symbol = Symbol("nemoclaw.configSourceSha256");

function privilegedSandboxExec(
  sandboxName: string,
  cmd: string[],
  opts: { input?: string | Buffer; timeout?: number } = {},
): string {
  const hasInput = opts.input !== undefined;
  return withPrivilegedSandboxExecutionLease(
    sandboxName,
    "sandbox config privileged execution",
    () =>
      capturePrivilegedSandboxCommand(sandboxName, cmd, {
        ...(hasInput ? { input: opts.input } : {}),
        sanitizeEnvironment: true,
        timeout: opts.timeout ?? 30000,
      }).toString("utf8"),
  );
}

function openClawConfigGuardExec(sandboxName: string, expectedContainerId?: string) {
  return {
    run: (cmd: string[], input?: string) => {
      try {
        return withPrivilegedSandboxExecutionLease(sandboxName, "OpenClaw config guard", () => {
          const result = executePrivilegedSandboxCommand(sandboxName, cmd, {
            ...(input === undefined ? {} : { input }),
            sanitizeEnvironment: true,
            ...(expectedContainerId === undefined
              ? {}
              : { expectedResourceHandle: expectedContainerId }),
            timeout: OPENCLAW_CONFIG_GUARD_TIMEOUT_MS,
            maxOutputBytes: 2 * 1024 * 1024,
          });
          return {
            status: result.status,
            signal: result.signal,
            stdout: result.stdout.toString("utf8"),
            stderr: result.stderr.toString("utf8"),
            ...(result.error ? { error: result.error.message } : {}),
          };
        });
      } catch (error) {
        return {
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function resolveAgentConfig(sandboxName: string): AgentConfigTarget {
  return resolveAgentConfigTarget(sandboxName);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOpenshellBinary(): string {
  return process.env.NEMOCLAW_OPENSHELL_BIN || "openshell";
}

function extractDotpath(obj: ConfigValue, dotpath: string): ConfigValue | undefined {
  const keys = dotpath.split(".");
  let current: ConfigValue = obj;
  for (const key of keys) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
      continue;
    }
    if (!isConfigObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function ensureConfigObjectKey(record: ConfigObject, key: string): ConfigObject {
  const existing = record[key];
  if (isConfigObject(existing)) {
    return existing;
  }

  const created: ConfigObject = {};
  record[key] = created;
  return created;
}

function setDotpath(obj: ConfigObject, dotpath: string, value: ConfigValue): void {
  const keys = dotpath.split(".");
  const leafKey = keys.pop();
  if (!leafKey) return;

  let current = obj;
  for (const key of keys) {
    current = ensureConfigObjectKey(current, key);
  }
  current[leafKey] = value;
}

/**
 * Key segments that must never appear in a dotpath - blocking these prevents
 * prototype-pollution and accidental traversal into inherited members.
 */
const UNSAFE_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
]);

type DotpathValidation = { ok: true } | { ok: false; reason: string };

/**
 * Validate the syntax of a config dotpath: non-empty, no empty segments, no
 * prototype-pollution / inherited-member segments. Schema validity is not
 * checked here - `configSet` handles unknown paths via an interactive
 * confirm or a `--config-accept-new-path` opt-in so first-time writes
 * under unset namespaces stay possible (see #2400).
 */
function validateConfigDotpath(dotpath: string): DotpathValidation {
  if (!dotpath || typeof dotpath !== "string") {
    return { ok: false, reason: "key is empty" };
  }
  const keys = dotpath.split(".");
  for (const key of keys) {
    if (!key) return { ok: false, reason: "key contains an empty segment" };
    if (UNSAFE_KEY_SEGMENTS.has(key)) {
      return { ok: false, reason: `segment '${key}' is reserved` };
    }
  }
  return { ok: true };
}

/**
 * Walk a dotpath and report the first reason `configSet` should refuse it:
 *
 *   - Numeric segment: would target an array index, but `setDotpath` always
 *     materialises plain objects, so allowing this would either clobber an
 *     existing array or create a confusingly object-shaped "array".
 *   - Non-object ancestor: an existing intermediate value (string, number,
 *     null, array, ...) would be silently overwritten by `setDotpath` on its
 *     way to the leaf.
 *
 * Missing ancestors are fine - they get materialised on write. Returns
 * `null` when no refusal reason applies.
 */
function findClobberingAncestor(
  obj: ConfigValue,
  dotpath: string,
): { segment: string; reason: string } | null {
  const keys = dotpath.split(".");

  for (let i = 0; i < keys.length; i++) {
    if (/^\d+$/.test(keys[i])) {
      return {
        segment: keys.slice(0, i + 1).join("."),
        reason: "is a numeric segment, but 'config set' does not support array editing",
      };
    }
  }

  if (keys.length <= 1) return null;

  let current: ConfigValue = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isConfigObject(current)) {
      return {
        segment: keys.slice(0, i).join(".") || "(root)",
        reason: `is ${describeNonConfigValue(current)}, not a config object`,
      };
    }
    const key = keys[i];
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      return null;
    }
    const next = current[key];
    if (!isConfigObject(next)) {
      return {
        segment: keys.slice(0, i + 1).join("."),
        reason: `is ${describeNonConfigValue(next)}, not a config object`,
      };
    }
    current = next;
  }
  return null;
}

function describeNonConfigValue(value: ConfigValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * Decide what to do when `config set` targets a key that does not yet exist.
 * Returns `accept` if an explicit override (CLI flag or env) is in effect,
 * `prompt` if the caller should ask the user interactively, and `refuse`
 * otherwise. Inputs are passed in so the gate can be tested without
 * touching `process.env` or `process.stdin`.
 */
type NewKeyGate = { mode: "accept" } | { mode: "prompt" } | { mode: "refuse" };

interface NewKeyGateInputs {
  acceptNewPath?: boolean;
  acceptEnv?: string;
  isTTY?: boolean;
  nonInteractiveEnv?: string;
}

function classifyNewKeyGate(inputs: NewKeyGateInputs): NewKeyGate {
  if (inputs.acceptNewPath === true || inputs.acceptEnv === "1") {
    return { mode: "accept" };
  }
  const interactive = !!inputs.isTTY && inputs.nonInteractiveEnv !== "1";
  if (!interactive) {
    return { mode: "refuse" };
  }
  return { mode: "prompt" };
}

/**
 * Pure body composition for {@link writeSandboxConfig}: serialize the config
 * and prepend agent-specific headers. Extracted so unit tests can assert the
 * exact byte sequence that lands in the sandbox without driving the
 * privileged docker exec path.
 */
function composeSandboxConfigBody(config: ConfigObject, target: AgentConfigTarget): string {
  const body = serializeConfig(config, target.format);
  if (target.agentName === "hermes" && target.format === "yaml") {
    return `${buildHermesUpstreamHeader(config as Record<string, unknown>)}${body}`;
  }
  return body;
}

/**
 * Parse a CLI-provided config value as JSON when possible, otherwise keep it
 * as a string literal.
 */
function parseCliConfigValue(rawValue: string): ConfigValue {
  try {
    const parsed = parseJson<ConfigValue>(rawValue);
    return isConfigValue(parsed) ? parsed : rawValue;
  } catch {
    return rawValue;
  }
}

/**
 * True when an OpenShell `sandbox exec` failure detail reports the sandbox
 * itself is not ready (for example, stopped), rather than an unrelated exec
 * failure. Normalizes ANSI codes, the CLI's box-drawing error marker, and
 * line-wrapping whitespace so a wrapped multi-line rendering of the same
 * message still matches (#10251).
 */
function isSandboxNotReadyExecDetail(detail: string): boolean {
  const normalized = stripAnsi(detail)
    .replace(/[×│]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (
    /sandbox '[^']*' is not ready \(phase: \w+\)/i.test(normalized) ||
    /^Error: code: 'The system is not in a state required for the operation's execution', message: "sandbox is not ready"$/i.test(
      normalized,
    )
  );
}

/**
 * Read the agent's config from a running sandbox.
 * Resolves the correct config path based on the agent type.
 */
function readSandboxConfig(sandboxName: string, target: AgentConfigTarget): ConfigObject {
  const binary = getOpenshellBinary();
  let raw: string;
  try {
    const result = captureOpenshellCommand(
      binary,
      ["sandbox", "exec", "--name", sandboxName, "--", "cat", target.configPath],
      {
        ignoreError: true,
        includeStreams: true,
        maxBuffer: CONFIG_CAPTURE_MAX_BUFFER,
        errorLine: console.error,
        exit: (code: number) => process.exit(code),
      },
    );
    if (result.error || result.signal || result.status !== 0) {
      // Diagnostic channels only. `result.output` is stdout-first, and stdout
      // here is the agent config `cat` printed, so echoing it would put config
      // contents — credentials included — into a CLI error.
      const detail = result.error?.message || result.stderr?.trim();
      // Preserve a failed exec's detail. `configFail` throws, so it must not be
      // caught and replaced with the generic stopped-sandbox message below.
      // Exception: a "sandbox is not ready" detail IS the stopped-sandbox case
      // (#10251, a regression of #6997) — fall through to the generic message
      // below instead, so the actionable "Is the sandbox running?" / "Start
      // the sandbox and retry." guidance survives instead of a raw OpenShell
      // error.
      if (detail && !isSandboxNotReadyExecDetail(detail)) {
        configFail(`  Cannot read ${target.agentName} config (${target.configPath}): ${detail}`);
      }
      raw = "";
    } else {
      // `output` is display-normalized with trim(); the transaction digest must
      // bind the exact bytes returned by `cat`, including its final newline.
      raw = result.stdout ?? result.output ?? "";
    }
  } catch (error) {
    // Only unexpected capture failures become empty reads. A diagnostic raised
    // above already names the reason and must reach the caller (#9104).
    if (error instanceof SandboxConfigError) throw error;
    raw = "";
  }

  if (!raw || !raw.trim()) {
    configFail([
      `  Cannot read ${target.agentName} config (${target.configPath}).`,
      "  Is the sandbox running?",
    ]);
  }

  try {
    const config = parseConfig(raw, target.format);
    Object.defineProperty(config, CONFIG_SOURCE_SHA256, {
      configurable: false,
      enumerable: false,
      value: createHash("sha256").update(raw).digest("hex"),
      writable: false,
    });
    return config;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    configFail(`  Failed to parse ${target.agentName} config: ${message}`);
  }
}

type ValidatedOpenClawCandidate = {
  content: string;
  privileged: import("../shields/state-dir-lock").PrivilegedExec;
};

function isHermesCompatHashRecoveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /compat hash (does not match frozen Hermes inputs|verification failed)/iu.test(message);
}

function hermesCompatHashRecoveryError(sandboxName: string): SandboxConfigError {
  return new SandboxConfigError([
    "  Hermes integrity metadata is not ready for a configuration write.",
    `  Run: nemoclaw ${shellQuote(sandboxName)} recover`,
    "  The configuration write was not applied.",
  ]);
}

function writeSandboxConfig(
  sandboxName: string,
  target: AgentConfigTarget,
  config: ConfigObject,
  // Interactive config set supplies this after validating outside the mutation locks.
  // Other callers retain the existing digest-bound write behavior.
  validatedOpenClawCandidate?: ValidatedOpenClawCandidate,
): void {
  const content = validatedOpenClawCandidate?.content ?? composeSandboxConfigBody(config, target);
  if (target.agentName === "hermes") {
    const expectedConfigSha256 = (config as ConfigObject & { [CONFIG_SOURCE_SHA256]?: string })[
      CONFIG_SOURCE_SHA256
    ];
    if (!expectedConfigSha256) {
      throw new Error(
        "Refusing Hermes config write without the digest from the matching sandbox read.",
      );
    }
    try {
      privilegedSandboxExec(
        sandboxName,
        [
          "timeout",
          "--signal=TERM",
          "--kill-after=5s",
          "2m",
          HERMES_PYTHON,
          "-I",
          HERMES_RUNTIME_CONFIG_GUARD,
          "write-config",
          "--hermes-dir",
          target.configDir,
          "--hash-file",
          HERMES_STRICT_HASH_FILE,
          "--state-file",
          HERMES_RESTART_SEAL_STATE,
          "--expected-config-sha256",
          expectedConfigSha256,
        ],
        { input: content, timeout: HERMES_CONFIG_GUARD_TIMEOUT_MS },
      );
    } catch (error) {
      if (isHermesCompatHashRecoveryError(error)) {
        throw hermesCompatHashRecoveryError(sandboxName);
      }
      throw error;
    }
    return;
  }
  if (target.agentName === "openclaw") {
    const expectedConfigSha256 = (config as ConfigObject & { [CONFIG_SOURCE_SHA256]?: string })[
      CONFIG_SOURCE_SHA256
    ];
    if (!expectedConfigSha256) {
      throw new Error(
        "Refusing OpenClaw config write without the digest from the matching sandbox read.",
      );
    }
    const result = runOpenClawConfigGuard(
      validatedOpenClawCandidate?.privileged ?? openClawConfigGuardExec(sandboxName),
      "write-config",
      {
        expectedConfigSha256,
        input: content,
      },
    );
    if (result.issues.length > 0) {
      configFail(result.issues.map((issue) => `  ${issue}`));
    }
    // Integrity-only digest for guard output; this is not a password verifier.
    const expectedNewDigest = createHash("sha256").update(content).digest("hex");
    if (result.configSha256 !== expectedNewDigest) {
      throw new Error(
        `OpenClaw config guard committed digest ${String(result.configSha256)} (expected ${expectedNewDigest})`,
      );
    }
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-"));
  const tmpFile = path.join(tmpDir, target.configFile);
  try {
    fs.writeFileSync(tmpFile, content, { mode: 0o600 });

    const stagedContent = fs.readFileSync(tmpFile, "utf-8");
    privilegedSandboxExec(sandboxName, ["sh", "-c", `cat > ${shellQuote(target.configPath)}`], {
      input: stagedContent,
    });

    try {
      privilegedSandboxExec(sandboxName, ["chown", "sandbox:sandbox", target.configPath]);
    } catch {
      // Best effort — chown failure is non-fatal.
    }
  } finally {
    try {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    } catch {
      // Best effort.
    }
  }
}

function buildRecomputeSandboxConfigHashScript(target: AgentConfigTarget): string | null {
  // OpenClaw and Hermes write and refresh both hashes inside one fd-pinned sealed
  // transaction. A second pathname-based hash pass would reopen the race that
  // transaction is designed to close.
  if (target.agentName === "openclaw" || target.agentName === "hermes") return null;
  if (!target.sensitiveFiles?.includes(`${target.configDir}/.config-hash`)) return null;
  return [
    `cd ${shellQuote(target.configDir)}`,
    `sha256sum ${shellQuote(target.configFile)} > .config-hash`,
    "(chown sandbox:sandbox .config-hash 2>/dev/null || true)",
    "(chmod 660 .config-hash 2>/dev/null || true)",
  ].join(" && ");
}

function recomputeSandboxConfigHash(sandboxName: string, target: AgentConfigTarget): void {
  const script = buildRecomputeSandboxConfigHashScript(target);
  if (!script) return;
  privilegedSandboxExec(sandboxName, ["sh", "-c", script]);
}

// Absolute path to the Hermes dashboard config seeder inside the sandbox image
// (installed by the agents/hermes image build). The python resolution order
// mirrors start.sh's trusted `_HERMES_PYTHON` list.
const HERMES_DASHBOARD_SEEDER_PATH = "/usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py";
const HERMES_MANAGED_POLICY_PATH = "/usr/local/share/nemoclaw/hermes-managed-policy.json";
const HERMES_TRUSTED_PYTHON3 = [
  "/opt/hermes/.venv/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
] as const;
const HERMES_DASHBOARD_PATH_ABSENT_STATUS = 3;
// OpenShell rejects CR/LF in argv, so encode the multiline program inside a
// single-line Python expression.
const HERMES_DASHBOARD_PATH_INSPECTION = `exec(${JSON.stringify(
  [
    "import os",
    "import stat",
    "import sys",
    "try:",
    "    mode = os.lstat(sys.argv[1]).st_mode",
    "except FileNotFoundError:",
    `    raise SystemExit(${HERMES_DASHBOARD_PATH_ABSENT_STATUS})`,
    "except OSError as exc:",
    '    print(f"unable to inspect Hermes dashboard path: {exc}", file=sys.stderr)',
    "    raise SystemExit(2)",
    "raise SystemExit(0 if stat.S_ISDIR(mode) else 2)",
  ].join("\n"),
)})`;

export type HermesDashboardReseedResult = "converged" | "absent" | "failed";

export interface HermesDashboardReseedDeps {
  getOpenshellBinary: () => string;
  captureOpenshellCommand: (
    binary: string,
    args: string[],
    options: import("../adapters/openshell/client").CaptureOpenshellOptions,
  ) => import("../adapters/openshell/client").CaptureOpenshellResult;
  reportFailure?: (stage: "python" | "inspection" | "seed", detail: string) => void;
}

const HERMES_DASHBOARD_RESEED_DIAGNOSTIC_MAX_CHARS = 800;

function hermesDashboardReseedFailureDetail(
  result: import("../adapters/openshell/client").CaptureOpenshellResult,
): string {
  const raw =
    result.error?.message || result.stderr?.trim() || result.output.trim() || result.stdout?.trim();
  const detail = redactFull(raw || "no command output")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = detail.slice(0, HERMES_DASHBOARD_RESEED_DIAGNOSTIC_MAX_CHARS);
  return [
    `status=${result.status === null ? "null" : result.status}`,
    result.signal ? `signal=${result.signal}` : "",
    bounded ? `detail=${bounded}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Re-run the Hermes dashboard config seeder inside the sandbox so the isolated
 * dashboard profile config (`<configDir>/profiles/dashboard-home/config.yaml`)
 * re-mirrors the gateway config's model routing after an in-place
 * `inference set`. Sandbox startup runs the same seeder; without re-running it,
 * Dashboard Chat and its `/api/model/info` endpoint stay on the previous model
 * even though the gateway config, registry, and CLI status all report the new
 * one (#6893).
 *
 * Runs as the sandbox user (non-privileged `sandbox exec`, matching start.sh's
 * step-down before touching sandbox-owned dashboard-home state); the seeder does
 * no-follow atomic writes and refuses symlinked paths. Best-effort: returns
 * `failed` on failure so the caller can warn without aborting the route switch.
 */
function runHermesDashboardConfigSeed(
  sandboxName: string,
  target: AgentConfigTarget,
  mergeLegacy: boolean,
  deps: HermesDashboardReseedDeps,
): HermesDashboardReseedResult {
  const dashboardHome = `${target.configDir}/profiles/dashboard-home`;
  const legacyDashboardHome = `${target.configDir}/dashboard-home`;
  const binary = deps.getOpenshellBinary();
  const capture = (command: string[]) =>
    deps.captureOpenshellCommand(
      binary,
      ["sandbox", "exec", "--name", sandboxName, "--", ...command],
      {
        ignoreError: true,
        includeStreams: true,
        maxBuffer: CONFIG_CAPTURE_MAX_BUFFER,
        timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
      },
    );
  const failed = (result: import("../adapters/openshell/client").CaptureOpenshellResult) =>
    Boolean(result.error || result.signal || result.status !== 0);
  const reportFailure = (
    stage: "python" | "inspection" | "seed",
    result: import("../adapters/openshell/client").CaptureOpenshellResult,
  ) => {
    const detail = hermesDashboardReseedFailureDetail(result);
    if (deps.reportFailure) {
      deps.reportFailure(stage, detail);
      return;
    }
    console.error(`  Hermes dashboard reseed ${stage} failed: ${detail}`);
  };

  let python: (typeof HERMES_TRUSTED_PYTHON3)[number] | null = null;
  let lastPythonFailure: import("../adapters/openshell/client").CaptureOpenshellResult | undefined;
  for (const candidate of HERMES_TRUSTED_PYTHON3) {
    const probe = capture([candidate, "-c", ""]);
    if (!failed(probe)) {
      python = candidate;
      break;
    }
    lastPythonFailure = probe;
  }
  if (!python) {
    if (lastPythonFailure) reportFailure("python", lastPythonFailure);
    return "failed";
  }

  // lstat distinguishes a genuinely absent profile from a file, a symlink
  // (including a broken one), or an inspection error. Only the first case is a
  // clean no-op; everything else fails closed so callers cannot report sync.
  let inspection = capture([python, "-c", HERMES_DASHBOARD_PATH_INSPECTION, dashboardHome]);
  if (
    !inspection.error &&
    !inspection.signal &&
    inspection.status === HERMES_DASHBOARD_PATH_ABSENT_STATUS
  ) {
    inspection = capture([python, "-c", HERMES_DASHBOARD_PATH_INSPECTION, legacyDashboardHome]);
    if (
      !inspection.error &&
      !inspection.signal &&
      inspection.status === HERMES_DASHBOARD_PATH_ABSENT_STATUS
    ) {
      return "absent";
    }
  }
  if (failed(inspection)) {
    reportFailure("inspection", inspection);
    return "failed";
  }

  const dashboardConfigPath = `${dashboardHome}/config.yaml`;
  const seed = capture([
    python,
    HERMES_DASHBOARD_SEEDER_PATH,
    ...(mergeLegacy ? ["--merge-legacy"] : []),
    HERMES_MANAGED_POLICY_PATH,
    target.configPath,
    dashboardConfigPath,
    `${target.configDir}/.env`,
    `${dashboardHome}/.env`,
  ]);
  if (failed(seed)) {
    reportFailure("seed", seed);
    return "failed";
  }
  const seededMarker = `[dashboard] seeded model routing and reviewed policy into ${dashboardConfigPath}`;
  if (
    !String(seed.stderr ?? "")
      .split(/\r?\n/u)
      .includes(seededMarker)
  ) {
    reportFailure("seed", seed);
    return "failed";
  }
  return "converged";
}

function seedHermesDashboardConfig(
  sandboxName: string,
  target: AgentConfigTarget,
  deps: HermesDashboardReseedDeps = { getOpenshellBinary, captureOpenshellCommand },
): HermesDashboardReseedResult {
  return runHermesDashboardConfigSeed(sandboxName, target, false, deps);
}

function restoreHermesDashboardConfig(
  sandboxName: string,
  target: AgentConfigTarget,
  deps: HermesDashboardReseedDeps = { getOpenshellBinary, captureOpenshellCommand },
): HermesDashboardReseedResult {
  return runHermesDashboardConfigSeed(sandboxName, target, true, deps);
}

// ---------------------------------------------------------------------------
// URL validation (strict SSRF checks for config set)
// ---------------------------------------------------------------------------

function parseHttpUrl(value: string): URL | null {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    if (lower.startsWith("http://") || lower.startsWith("https://")) {
      throw new Error("Invalid URL.");
    }
    return null; // Not a URL — skip validation
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL scheme "${parsed.protocol}" is not allowed. Use http: or https:.`);
  }

  if (!parsed.hostname) {
    throw new Error("No hostname found in URL.");
  }

  return parsed;
}

function assertPublicHost(hostname: string): void {
  if (isPrivateHostname(hostname)) {
    throw new Error(
      `URL points to private/internal address "${hostname}". ` +
        `This could expose internal services to the sandbox.`,
    );
  }
}

function hostnameForDnsLookup(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function validateUrlValue(
  value: string,
  options: ConfigUrlValidationOptions = {},
  pathSegments: readonly string[] = [],
): void {
  const parsed = parseHttpUrl(value);
  if (!parsed) return;
  if (options.allowPrivateUrls && isPrivateHostname(parsed.hostname)) return;
  if (
    (options.allowOpenShellBridge || options.allowOpenShellBridgePath?.(pathSegments)) &&
    isAllowedOpenShellSandboxBridgeUrl(parsed)
  ) {
    return;
  }
  assertPublicHost(parsed.hostname);
}

async function validateUrlValueWithDnsResult(
  value: string,
  lookup: LookupFn = dnsPromises.lookup as LookupFn,
  options: ConfigUrlValidationOptions = {},
  pathSegments: readonly string[] = [],
): Promise<DnsValidatedUrl | null> {
  const originalUrl = value.trim();
  const parsed = parseHttpUrl(originalUrl);
  if (!parsed) return null;

  const hostname = parsed.hostname;
  if (options.allowPrivateUrls && isPrivateHostname(hostname)) {
    return {
      protocol: parsed.protocol as "http:" | "https:",
      originalUrl,
      pinnedUrl: originalUrl,
    };
  }
  if (
    (options.allowOpenShellBridge || options.allowOpenShellBridgePath?.(pathSegments)) &&
    isAllowedOpenShellSandboxBridgeUrl(parsed)
  ) {
    return {
      protocol: parsed.protocol as "http:" | "https:",
      originalUrl,
      pinnedUrl: originalUrl,
    };
  }
  assertPublicHost(hostname);
  const lookupHostname = hostnameForDnsLookup(hostname);
  if (isIP(lookupHostname)) {
    return { protocol: parsed.protocol as "http:" | "https:", originalUrl, pinnedUrl: originalUrl };
  }

  let addresses: Array<{ address: string; family?: number }>;
  try {
    addresses = await lookup(lookupHostname, { all: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot resolve hostname "${hostname}": ${message}`);
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`Cannot resolve hostname "${hostname}": no addresses returned.`);
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(
        `URL hostname "${hostname}" resolves to private/internal address "${address}". ` +
          `This could expose internal services to the sandbox.`,
      );
    }
  }

  const pinned = new URL(originalUrl);
  const first = addresses[0];
  const family = first.family ?? isIP(first.address);
  pinned.hostname = family === 6 ? `[${first.address}]` : first.address;

  return {
    protocol: parsed.protocol as "http:" | "https:",
    originalUrl,
    pinnedUrl: pinned.toString(),
  };
}

async function validateUrlValueWithDns(
  value: string,
  lookup: LookupFn = dnsPromises.lookup as LookupFn,
  options: ConfigUrlValidationOptions = {},
): Promise<void> {
  await validateUrlValueWithDnsResult(value, lookup, options);
}

function redactUrlForLogs(urlValue: string): string {
  try {
    const parsed = new URL(urlValue);
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function redactStringForConfigPreview(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return "[REDACTED_URL]";
  }
  return "[REDACTED_STRING]";
}

function redactConfigValueForPreview(value: ConfigValue): ConfigValue {
  if (typeof value === "string") return redactStringForConfigPreview(value);
  if (Array.isArray(value)) return value.map((entry) => redactConfigValueForPreview(entry));
  if (isConfigObject(value)) {
    const redacted: ConfigObject = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = isCredentialField(key) ? "[REDACTED]" : redactConfigValueForPreview(entry);
    }
    return redacted;
  }
  return value;
}

function formatConfigValueForLogs(value: ConfigValue | undefined): string {
  if (value === undefined) return "(not set)";
  return JSON.stringify(redactConfigValueForPreview(value));
}

function hermesConfigAllowsPrivateUrls(config: ConfigObject): boolean {
  const security = config.security;
  return isConfigObject(security) && security.allow_private_urls === true;
}

function configSetAllowsOpenShellBridge(
  agentName: string,
  key: string,
  relativePath: readonly string[] = [],
): boolean {
  const segments = [...key.split("."), ...relativePath];
  if (segments.some((segment) => UNSAFE_KEY_SEGMENTS.has(segment))) return false;

  if (agentName === "hermes") {
    return segments.length === 2 && segments[0] === "model" && segments[1] === "base_url";
  }

  if (agentName === "openclaw") {
    return (
      segments.length === 4 &&
      segments[0] === "models" &&
      segments[1] === "providers" &&
      segments[2].length > 0 &&
      !/^\d+$/.test(segments[2]) &&
      segments[3] === "baseUrl"
    );
  }

  return false;
}

async function rewriteConfigUrlsWithDnsPinning(
  value: ConfigValue,
  lookup: LookupFn = dnsPromises.lookup as LookupFn,
  options: ConfigUrlValidationOptions = {},
  pathSegments: readonly string[] = [],
): Promise<ConfigValue> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const lower = trimmed.toLowerCase();
    if (!lower.startsWith("http://") && !lower.startsWith("https://")) return value;

    try {
      const validated = await validateUrlValueWithDnsResult(trimmed, lookup, options, pathSegments);
      if (!validated) return value;
      // HTTP has no TLS hostname binding, so persist the DNS-pinned URL to avoid
      // a config-time/public → runtime/private DNS-rebinding window. DNS-backed
      // HTTPS endpoints fail closed for generic persisted config because the
      // downstream consumer would otherwise perform a second DNS lookup while
      // NemoClaw cannot pin the peer IP and preserve TLS SNI/Host across the
      // OpenShell runtime boundary. This validator handles arbitrary persisted
      // config values, not just inference endpoints, so the message stays
      // generic; callers that know the field is an inference endpoint add
      // their own guidance by checking `reason` on the thrown error.
      if (validated.protocol === "https:" && validated.pinnedUrl !== validated.originalUrl) {
        throw new ConfigUrlValidationError(
          trimmed,
          "DNS-backed HTTPS URLs are not supported for arbitrary persisted sandbox config " +
            "values. Use an HTTPS IP-literal endpoint or an HTTP endpoint that can be " +
            "DNS-pinned.",
          "dns_backed_https_unsupported",
        );
      }
      return validated.protocol === "http:" ? validated.pinnedUrl : validated.originalUrl;
    } catch (err: unknown) {
      if (err instanceof ConfigUrlValidationError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfigUrlValidationError(trimmed, message);
    }
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((entry, index) =>
        rewriteConfigUrlsWithDnsPinning(entry, lookup, options, [...pathSegments, String(index)]),
      ),
    );
  }

  if (isConfigObject(value)) {
    const rewritten: ConfigObject = {};
    for (const [key, entry] of Object.entries(value)) {
      rewritten[key] = await rewriteConfigUrlsWithDnsPinning(entry, lookup, options, [
        ...pathSegments,
        key,
      ]);
    }
    return rewritten;
  }

  return value;
}

// ---------------------------------------------------------------------------
// config get
// ---------------------------------------------------------------------------

interface ConfigGetOpts {
  key?: string | null;
  format?: string;
}

type ConfigGetParseResult =
  | { ok: true; opts: { key: string | null; format: string } }
  | { ok: false; errors: string[] };

function configGetUsage(cliName: string): string {
  return `  Usage: ${cliName} <name> config get [--key dotpath] [--format json|yaml]`;
}

function parseConfigGetArgs(args: string[], cliName = "nemoclaw"): ConfigGetParseResult {
  const opts = { key: null as string | null, format: "json" };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--key") {
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        return { ok: false, errors: ["  --key requires a value.", configGetUsage(cliName)] };
      }
      opts.key = args[++i];
    } else if (flag === "--format") {
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        return {
          ok: false,
          errors: ["  --format requires a value (json|yaml).", configGetUsage(cliName)],
        };
      }
      const format = args[++i];
      if (format !== "json" && format !== "yaml") {
        return { ok: false, errors: [`  Unknown format: ${format}. Use json or yaml.`] };
      }
      opts.format = format;
    } else {
      return { ok: false, errors: [`  Unknown flag: ${flag}`, configGetUsage(cliName)] };
    }
  }
  return { ok: true, opts };
}

function configGet(sandboxName: string, opts: ConfigGetOpts = {}): void {
  validateName(sandboxName, "sandbox name");

  const target = resolveAgentConfig(sandboxName);
  let config: ConfigValue = stripCredentials(readSandboxConfig(sandboxName, target));

  // Remove gateway section for openclaw (contains auth tokens)
  if (isConfigObject(config)) {
    delete config.gateway;
  }

  // Extract dotpath if specified
  if (opts.key) {
    const value = extractDotpath(config, opts.key);
    if (value === undefined) {
      configFail(`  Key "${opts.key}" not found in ${target.agentName} config.`);
    }
    config = value;
  }

  // Format output — default to the agent's native format
  const outputFormat = opts.format || target.format;
  if (outputFormat === "yaml") {
    const YAML = require("yaml");
    console.log(YAML.stringify(config));
  } else {
    console.log(JSON.stringify(config, null, 2));
  }
}

// ---------------------------------------------------------------------------
// config set
// ---------------------------------------------------------------------------

interface ConfigSetOpts {
  key?: string | null;
  value?: string | null;
  restart?: boolean;
  acceptNewPath?: boolean;
}

async function configSet(sandboxName: string, opts: ConfigSetOpts = {}): Promise<void> {
  validateName(sandboxName, "sandbox name");

  if (!opts.key) {
    configFail([
      "  --key is required.",
      "  Usage: nemoclaw <name> config set --key <dotpath> --value <value>",
    ]);
  }
  const configKey = opts.key;

  if (opts.value === undefined || opts.value === null) {
    configFail([
      "  --value is required.",
      "  Usage: nemoclaw <name> config set --key <dotpath> --value <value>",
    ]);
  }

  const dotpathCheck = validateConfigDotpath(opts.key);
  if (!dotpathCheck.ok) {
    configFail(`  Invalid config key '${opts.key}': ${dotpathCheck.reason}.`);
  }

  const target = resolveAgentConfig(sandboxName);
  if (opts.restart && target.agentName !== "openclaw" && target.agentName !== "hermes") {
    configFail(
      `  --restart is supported only for OpenClaw and Hermes; '${target.agentName}' config was not changed.`,
    );
  }
  // dcode bakes its config into the sandbox image at build time, so — unlike
  // OpenClaw/Hermes — it has no host-side config-mutation path (the same reason
  // inference set refuses it, #6321). config get now reads TOML, but refuse
  // config set cleanly and point at the only way to change it: re-onboard. #6548
  if (target.format === "toml") {
    const { CLI_NAME } = require("../cli/branding");
    configFail(
      `  config set is not available for '${target.agentName}': its config is baked into the sandbox image at build time. To change it, re-onboard with the new selection (e.g. ${CLI_NAME} onboard --agent dcode --name ${shellQuote(sandboxName)} --fresh).`,
    );
  }
  if (target.agentName === "openclaw" || target.agentName === "hermes") {
    const { isShieldsDown }: typeof import("../shields") = require("../shields");
    if (!isShieldsDown(sandboxName, false)) {
      configFail(
        `  ${target.agentName} config changes are unavailable while shields are up for '${sandboxName}'. Run 'nemoclaw ${sandboxName} shields down' first.`,
      );
    }
  }

  // Read current config
  console.log(`  Reading ${target.agentName} config...`);
  const config = readSandboxConfig(sandboxName, target);
  const initialConfigSha256 = (config as ConfigObject & { [CONFIG_SOURCE_SHA256]?: string })[
    CONFIG_SOURCE_SHA256
  ];
  if (!initialConfigSha256) {
    configFail(`  Cannot bind the ${target.agentName} config read to a safe write transaction.`);
  }

  // Parse and validate value
  const parsedValue = parseCliConfigValue(opts.value);

  // Check that we're not modifying the gateway section (contains auth tokens)
  if (opts.key.startsWith("gateway.") || opts.key === "gateway") {
    configFail([
      "  Cannot modify the gateway section directly.",
      "  Use `nemoclaw <name> config rotate-token` for credential changes.",
    ]);
  }

  // Show what will change
  const oldValue = extractDotpath(config, opts.key);
  console.log(`  Agent:     ${target.agentName}`);
  console.log(`  Key:       ${opts.key}`);
  console.log(`  Old value: ${formatConfigValueForLogs(oldValue)}`);
  console.log(`  New value: ${formatConfigValueForLogs(parsedValue)}`);

  // Refuse outright if writing this path would silently overwrite an
  // existing scalar ancestor or target an array index — setDotpath would
  // either replace the scalar with a fresh empty object or clobber the
  // array on its way to the leaf.
  const refusal = findClobberingAncestor(config, opts.key);
  if (refusal) {
    configFail(
      `  Cannot set '${opts.key}' in ${target.agentName} config: '${refusal.segment}' ${refusal.reason}.`,
    );
  }

  // First-time writes require explicit consent before agent-specific validation.
  // Keep this cross-agent typo guard independent of any one agent's schema (#2400).
  if (oldValue === undefined) {
    const gate = classifyNewKeyGate({
      acceptNewPath: opts.acceptNewPath,
      acceptEnv: process.env.NEMOCLAW_CONFIG_ACCEPT_NEW_PATH,
      isTTY: process.stdin.isTTY,
      nonInteractiveEnv: process.env.NEMOCLAW_NON_INTERACTIVE,
    });
    if (gate.mode === "refuse") {
      configFail([
        `  Key '${opts.key}' does not currently exist in the ${target.agentName} config.`,
        "  Re-run interactively, pass --config-accept-new-path, or set NEMOCLAW_CONFIG_ACCEPT_NEW_PATH=1.",
      ]);
    }
    if (gate.mode === "prompt") {
      let confirmed: boolean;
      try {
        confirmed = await confirmYesNo("  Write this new key? [y/N] ");
      } catch (error) {
        // The shared prompt re-raises SIGINT; only EOF needs config-specific remediation here.
        if (isErrnoException(error) && error.code === "EOF") {
          configFail([
            "  No input available on stdin, so config set cannot confirm the new key.",
            "  Re-run with --config-accept-new-path or set NEMOCLAW_CONFIG_ACCEPT_NEW_PATH=1.",
          ]);
        }
        throw error;
      }
      if (!confirmed) {
        configFail("  Aborted.");
      }
    }
  }

  // Validate URLs for SSRF (supports nested object/array values). HTTP URLs
  // are persisted with DNS-pinned hosts so later use cannot re-resolve the same
  // hostname to private/internal space after config-time validation succeeds.
  let safeValue: ConfigValue;
  try {
    safeValue = await rewriteConfigUrlsWithDnsPinning(parsedValue, dnsPromises.lookup as LookupFn, {
      allowPrivateUrls: target.agentName === "hermes" && hermesConfigAllowsPrivateUrls(config),
      allowOpenShellBridgePath: (relativePath) =>
        configSetAllowsOpenShellBridge(target.agentName, configKey, relativePath),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const suffix =
      err instanceof ConfigUrlValidationError ? ` for ${redactUrlForLogs(err.urlValue)}` : "";
    configFail(`  URL validation failed${suffix}: ${message}`);
  }

  // Validation can take up to 30 seconds, so keep it outside both mutation locks.
  let validatedOpenClawCandidate: ValidatedOpenClawCandidate | undefined;
  if (target.agentName === "openclaw") {
    setDotpath(config, opts.key, safeValue);
    const content = composeSandboxConfigBody(config, target);
    try {
      const containerId = resolvePrivilegedSandboxTarget(sandboxName).resourceHandle;
      const privileged = openClawConfigGuardExec(sandboxName, containerId);
      const issues = validateOpenClawConfigCandidate(privileged, content);
      if (issues.length > 0) configFail(issues.map((issue) => `  ${issue}`));
      validatedOpenClawCandidate = { content, privileged };
    } catch (error) {
      if (error instanceof SandboxConfigError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      configFail(`  OpenClaw schema validation could not start: ${message}`);
    }
  }

  // Re-read under both mutation locks and enforce the source digest. For
  // OpenClaw, also require the exact serialized bytes validated above.
  await withSandboxMutationLock(sandboxName, () =>
    withTimerBoundShieldsMutationLock(sandboxName, "config set write", () => {
      const { isShieldsDown }: typeof import("../shields") = require("../shields");
      if (
        (target.agentName === "openclaw" || target.agentName === "hermes") &&
        !isShieldsDown(sandboxName, true)
      ) {
        configFail(
          `  ${target.agentName} config changes are unavailable while shields are up for '${sandboxName}'. Run 'nemoclaw ${sandboxName} shields down' first.`,
        );
      }
      const currentConfig = readSandboxConfig(sandboxName, target);
      const currentConfigSha256 = (
        currentConfig as ConfigObject & { [CONFIG_SOURCE_SHA256]?: string }
      )[CONFIG_SOURCE_SHA256];
      if (currentConfigSha256 !== initialConfigSha256) {
        configFail(
          `  ${target.agentName} config changed while this update was being validated. Re-run config set against the current value.`,
        );
      }
      setDotpath(currentConfig, opts.key!, safeValue);

      if (target.agentName === "openclaw") {
        const currentCandidateContent = composeSandboxConfigBody(currentConfig, target);
        if (
          !validatedOpenClawCandidate ||
          currentCandidateContent !== validatedOpenClawCandidate.content
        ) {
          configFail(
            "  OpenClaw config candidate changed after schema validation. Re-run config set against the current value.",
          );
        }
      }

      console.log(`  Writing config to sandbox (${target.configPath})...`);
      writeSandboxConfig(sandboxName, target, currentConfig, validatedOpenClawCandidate);
      recomputeSandboxConfigHash(sandboxName, target);

      appendAuditEntry({
        action: "config_set",
        sandbox: sandboxName,
        timestamp: new Date().toISOString(),
        reason: `config set ${target.agentName}:${opts.key}`,
      });
    }),
  );

  console.log(`  ${target.agentName} config updated.`);

  // Restart if requested
  if (opts.restart) {
    restartSandboxAgentAfterConfigSet(sandboxName, target.agentName);
  } else {
    console.log("");
    for (const line of buildConfigSetRestartGuidance(sandboxName, target.agentName)) {
      console.log(line);
    }
  }
}

// ---------------------------------------------------------------------------
// config rotate-token
// ---------------------------------------------------------------------------

type RotateTokenOpts = import("./config-rotate-token").RotateTokenOpts;

async function configRotateToken(sandboxName: string, opts: RotateTokenOpts = {}): Promise<void> {
  const { promptSecret, saveCredential } =
    require("../credentials/store") as typeof import("../credentials/store");
  return rotateSandboxToken(sandboxName, opts, {
    appendAuditEntry,
    captureOpenshellCommand,
    fail: configFail,
    loadSession: loadRotateTokenSession,
    promptSecret,
    resolveAgentConfig,
    runOpenshellCommand,
    saveCredential,
    validateName,
  });
}

/**
 * Ask a yes/no question on stderr. Returns true only when the answer matches
 * /^y(es)?$/i — empty, "no", or unparseable input is treated as no.
 */
function confirmYesNo(question: string): Promise<boolean> {
  const { prompt: askPrompt } =
    require("../credentials/store") as typeof import("../credentials/store");
  return askPrompt(question).then((answer) => /^y(es)?$/i.test(answer));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  buildConfigSetRestartGuidance,
  buildRecomputeSandboxConfigHashScript,
  classifyNewKeyGate,
  composeSandboxConfigBody,
  configGet,
  configRotateToken,
  configSet,
  configSetAllowsOpenShellBridge,
  hermesConfigAllowsPrivateUrls,
  hermesCompatHashRecoveryError,
  isHermesCompatHashRecoveryError,
  DEFAULT_AGENT_CONFIG,
  extractDotpath,
  findClobberingAncestor,
  formatConfigValueForLogs,
  parseConfig,
  parseConfigGetArgs,
  readSandboxConfig,
  readStdin,
  recomputeSandboxConfigHash,
  resolveAgentConfig,
  restartSandboxAgentAfterConfigSet,
  restoreHermesDashboardConfig,
  rewriteConfigUrlsWithDnsPinning,
  seedHermesDashboardConfig,
  setDotpath,
  validateConfigDotpath,
  validateUrlValue,
  validateUrlValueWithDns,
  writeSandboxConfig,
};
