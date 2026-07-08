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

const readline = require("readline");
const { createHash } = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promises: dnsPromises } = require("node:dns");
const { isIP } = require("node:net");
const { validateName } = require("../runner");
const { shellQuote } = require("../core/shell-quote");
const { dockerExecFileSync, dockerSpawnSync } = require("../adapters/docker/exec");
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
}: typeof import("../shields/openclaw-config-lock") = require("../shields/openclaw-config-lock");
const { isPrivateHostname, isPrivateIp } = require("../private-networks");
const {
  privilegedSandboxExecArgv,
}: typeof import("./privileged-exec") = require("./privileged-exec");
const {
  buildHermesUpstreamHeader,
}: typeof import("./hermes-upstream-header") = require("./hermes-upstream-header");

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

export interface AgentConfigTarget {
  /** Agent name (e.g. "openclaw", "hermes") */
  agentName: string;
  /** Absolute path inside sandbox to the config file */
  configPath: string;
  /** Directory containing the config (for chown after cp) */
  configDir: string;
  /** Config file format: "json" or "yaml" */
  format: string;
  /** Config file basename */
  configFile: string;
  /** Additional files to lock/unlock alongside the main config (e.g. .env, .config-hash) */
  sensitiveFiles?: string[];
}

type LookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family?: number }>>;

interface DnsValidatedUrl {
  protocol: "http:" | "https:";
  originalUrl: string;
  pinnedUrl: string;
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
  restartImpl?: ManagedGatewayRestart,
): void {
  const restart =
    restartImpl ??
    (require("../actions/sandbox/process-recovery").restartSandboxGateway as ManagedGatewayRestart);
  const result = restart(sandboxName);
  if (!result.ok) {
    configFail(
      `  Config was updated, but the managed gateway restart failed for '${sandboxName}'.`,
    );
  }
}

function buildConfigSetRestartGuidance(sandboxName: string, agentName: string): string[] {
  if (agentName === "openclaw" || agentName === "hermes") {
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

class ConfigUrlValidationError extends Error {
  constructor(
    readonly urlValue: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigUrlValidationError";
  }
}

const DEFAULT_AGENT_CONFIG: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
};

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
  return dockerExecFileSync(privilegedSandboxExecArgv(sandboxName, cmd, hasInput, true), {
    input: opts.input,
    stdio: hasInput ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    timeout: opts.timeout ?? 30000,
  });
}

function openClawConfigGuardExec(sandboxName: string) {
  return {
    run: (cmd: string[], input?: string) => {
      const result = dockerSpawnSync(
        privilegedSandboxExecArgv(sandboxName, cmd, input !== undefined, true),
        {
          encoding: "utf-8",
          input,
          timeout: OPENCLAW_CONFIG_GUARD_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      return {
        status: result.status,
        signal: result.signal,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        ...(result.error ? { error: result.error.message } : {}),
      };
    },
  };
}

function resolveAgentConfig(sandboxName: string): AgentConfigTarget {
  try {
    const registry = require("../state/registry");
    const entry = registry.getSandbox(sandboxName);
    if (!entry || !entry.agent) return DEFAULT_AGENT_CONFIG;

    const agentDefs = require("../agent/defs");
    const agent = agentDefs.loadAgent(entry.agent);
    const cfg = agent.configPaths;

    const dir = cfg.dir;
    const sensitiveFiles = [`${dir}/.config-hash`];
    // Hermes stores credentials in .env alongside the config
    if (entry.agent === "hermes") sensitiveFiles.push(`${dir}/.env`);

    return {
      agentName: entry.agent,
      configPath: `${dir}/${cfg.configFile}`,
      configDir: dir,
      format: cfg.format || "json",
      configFile: cfg.configFile,
      sensitiveFiles,
    };
  } catch {
    // Registry or agent-defs unavailable (e.g., during tests) — fall back
    return DEFAULT_AGENT_CONFIG;
  }
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
 * Parse a config file's raw text according to its format.
 */
function parseConfig(raw: string, format: string): ConfigObject {
  const parsed = format === "yaml" ? require("yaml").parse(raw) : JSON.parse(raw);
  if (!isConfigObject(parsed)) {
    throw new Error("Config is not an object.");
  }
  return parsed;
}

/**
 * Serialize a config object according to its format.
 */
function serializeConfig(config: ConfigObject, format: string): string {
  if (format === "yaml") {
    const YAML = require("yaml");
    return YAML.stringify(config);
  }
  return JSON.stringify(config, null, 2);
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
      const detail = result.error?.message || result.stderr?.trim() || result.output;
      configFail(
        `  Cannot read ${target.agentName} config (${target.configPath})${detail ? `: ${detail}` : "."}`,
      );
    }
    // `output` is display-normalized with trim(); the transaction digest must
    // bind the exact bytes returned by `cat`, including its final newline.
    raw = result.stdout ?? result.output ?? "";
  } catch {
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

function writeSandboxConfig(
  sandboxName: string,
  target: AgentConfigTarget,
  config: ConfigObject,
): void {
  const content = composeSandboxConfigBody(config, target);
  if (target.agentName === "hermes") {
    const expectedConfigSha256 = (config as ConfigObject & { [CONFIG_SOURCE_SHA256]?: string })[
      CONFIG_SOURCE_SHA256
    ];
    if (!expectedConfigSha256) {
      throw new Error(
        "Refusing Hermes config write without the digest from the matching sandbox read.",
      );
    }
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
    const result = runOpenClawConfigGuard(openClawConfigGuardExec(sandboxName), "write-config", {
      expectedConfigSha256,
      input: content,
    });
    if (result.issues.length > 0) {
      throw new Error(`OpenClaw config write refused: ${result.issues.join(", ")}`);
    }
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

function validateUrlValue(value: string): void {
  const parsed = parseHttpUrl(value);
  if (!parsed) return;
  assertPublicHost(parsed.hostname);
}

async function validateUrlValueWithDnsResult(
  value: string,
  lookup: LookupFn = dnsPromises.lookup as LookupFn,
): Promise<DnsValidatedUrl | null> {
  const originalUrl = value.trim();
  const parsed = parseHttpUrl(originalUrl);
  if (!parsed) return null;

  const hostname = parsed.hostname;
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
): Promise<void> {
  await validateUrlValueWithDnsResult(value, lookup);
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

async function rewriteConfigUrlsWithDnsPinning(
  value: ConfigValue,
  lookup: LookupFn = dnsPromises.lookup as LookupFn,
): Promise<ConfigValue> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const lower = trimmed.toLowerCase();
    if (!lower.startsWith("http://") && !lower.startsWith("https://")) return value;

    try {
      const validated = await validateUrlValueWithDnsResult(trimmed, lookup);
      if (!validated) return value;
      // HTTP has no TLS hostname binding, so persist the DNS-pinned URL to avoid
      // a config-time/public → runtime/private DNS-rebinding window. DNS-backed
      // HTTPS endpoints fail closed for generic persisted config because the
      // downstream consumer would otherwise perform a second DNS lookup while
      // NemoClaw cannot pin the peer IP and preserve TLS SNI/Host across the
      // OpenShell runtime boundary.
      if (validated.protocol === "https:" && validated.pinnedUrl !== validated.originalUrl) {
        throw new Error(
          "DNS-backed HTTPS URLs are not supported for persisted sandbox config yet. " +
            "Use an HTTPS IP-literal endpoint, an HTTP endpoint that can be DNS-pinned, " +
            "or wait for the runtime-aware HTTPS pinning transport.",
        );
      }
      return validated.protocol === "http:" ? validated.pinnedUrl : validated.originalUrl;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfigUrlValidationError(trimmed, message);
    }
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((entry) => rewriteConfigUrlsWithDnsPinning(entry, lookup)));
  }

  if (isConfigObject(value)) {
    const rewritten: ConfigObject = {};
    for (const [key, entry] of Object.entries(value)) {
      rewritten[key] = await rewriteConfigUrlsWithDnsPinning(entry, lookup);
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

  // First-time writes go through a confirmation gate so users get a
  // signal when they are creating a brand-new key (which may be a typo)
  // without coupling the validator to OpenClaw's evolving config schema
  // (see #2400).
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
      const confirmed = await confirmYesNo("  Write this new key? [y/N] ");
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
    safeValue = await rewriteConfigUrlsWithDnsPinning(parsedValue);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const suffix =
      err instanceof ConfigUrlValidationError ? ` for ${redactUrlForLogs(err.urlValue)}` : "";
    configFail(`  URL validation failed${suffix}: ${message}`);
  }

  // Serialize only the authoritative re-read/CAS write under the shared
  // sandbox lock and then the shields transition lock. Interactive approval
  // and DNS validation above must not hold either lock across the auto-restore
  // deadline. If anything changed while the user was deciding, fail closed.
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

      console.log(`  Writing config to sandbox (${target.configPath})...`);
      writeSandboxConfig(sandboxName, target, currentConfig);
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
    restartSandboxAgentAfterConfigSet(sandboxName);
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

interface RotateTokenOpts {
  fromEnv?: string | null;
  fromStdin?: boolean;
}

async function configRotateToken(sandboxName: string, opts: RotateTokenOpts = {}): Promise<void> {
  validateName(sandboxName, "sandbox name");

  // 1. Determine which provider and credentialEnv the sandbox uses.
  //    Load the onboard session and verify it matches this sandbox.
  const { loadSession } = require("../state/onboard-session");
  const session = loadSession();

  if (!session || !session.credentialEnv) {
    configFail([
      `  Cannot determine credential for sandbox '${sandboxName}'.`,
      "  No onboard session found with a credentialEnv.",
      "  Re-run: nemoclaw onboard --recreate-sandbox",
    ]);
  }

  if (session.sandboxName && session.sandboxName !== sandboxName) {
    configFail(`  Onboard session is for sandbox '${session.sandboxName}', not '${sandboxName}'.`);
  }

  const target = resolveAgentConfig(sandboxName);
  const credentialEnv: string = session.credentialEnv;
  const providerName: string = session.provider || "inference";

  console.log(`  Agent:          ${target.agentName}`);
  console.log(`  Provider:       ${providerName}`);
  console.log(`  Credential env: ${credentialEnv}`);

  // 2. Read new token
  let newToken: string | null = null;

  if (opts.fromEnv) {
    newToken = process.env[opts.fromEnv] || null;
    if (!newToken) {
      configFail(`  Environment variable "${opts.fromEnv}" is not set or empty.`);
    }
  } else if (opts.fromStdin) {
    newToken = await readStdin();
  } else {
    const { promptSecret } = require("../credentials/store");
    newToken = await promptSecret(`  New ${credentialEnv} value: `);
  }

  if (!newToken || !newToken.trim()) {
    configFail("  Token cannot be empty.");
  }

  newToken = newToken.trim();

  // 3. Validate — no whitespace in token
  if (/\s/.test(newToken)) {
    configFail("  Token contains whitespace. This is likely a paste error.");
  }

  // 4. Stage the new value in the current process so the openshell update
  //    that follows can read it via --credential <ENV>. The OpenShell
  //    gateway becomes the system of record once the update succeeds.
  const { saveCredential } = require("../credentials/store");
  saveCredential(credentialEnv, newToken);

  // 5. Update the openshell provider
  console.log("  Updating openshell provider...");
  const binary = getOpenshellBinary();
  const result = runOpenshellCommand(
    binary,
    ["provider", "update", providerName, "--credential", credentialEnv],
    {
      env: { [credentialEnv]: newToken },
      ignoreError: true,
      errorLine: console.error,
      exit: (code: number) => process.exit(code),
    },
  );

  if (result.status !== 0) {
    const providerType = session.providerType || "generic";
    const createResult = runOpenshellCommand(
      binary,
      [
        "provider",
        "create",
        "--name",
        providerName,
        "--type",
        providerType,
        "--credential",
        credentialEnv,
      ],
      {
        env: { [credentialEnv]: newToken },
        ignoreError: true,
        errorLine: console.error,
        exit: (code: number) => process.exit(code),
      },
    );

    if (createResult.status !== 0) {
      configFail("  Failed to update provider. You may need to re-onboard.");
    }
  }

  // 6. Audit log
  appendAuditEntry({
    action: "rotate_token",
    sandbox: sandboxName,
    timestamp: new Date().toISOString(),
    reason: `rotate-token ${target.agentName}:${credentialEnv}`,
  });

  // 7. Output (redacted)
  const lastFour = newToken.length > 4 ? newToken.slice(-4) : "****";
  console.log(`  Token rotated: ****${lastFour}`);
  console.log("");
  console.log("  The new credential is active immediately for new sandbox requests.");
}

/**
 * Read all data from stdin until EOF.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8").trim()));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

/**
 * Ask a yes/no question on stderr. Returns true only when the answer matches
 * /^y(es)?$/i — empty, "no", or unparseable input is treated as no.
 */
function confirmYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Re-attach stdin to the event loop — unref() on exit is sticky and
    // would otherwise leave a follow-up prompt waiting on a detached handle.
    if (typeof process.stdin.ref === "function") process.stdin.ref();
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer: string) => {
      rl.close();
      // pause+unref so the process exits naturally after the last prompt.
      // The matching ref() above keeps subsequent prompts working.
      if (typeof process.stdin.pause === "function") process.stdin.pause();
      if (typeof process.stdin.unref === "function") process.stdin.unref();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
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
  DEFAULT_AGENT_CONFIG,
  extractDotpath,
  findClobberingAncestor,
  formatConfigValueForLogs,
  parseConfig,
  parseConfigGetArgs,
  privilegedSandboxExecArgv,
  readSandboxConfig,
  readStdin,
  recomputeSandboxConfigHash,
  resolveAgentConfig,
  restartSandboxAgentAfterConfigSet,
  rewriteConfigUrlsWithDnsPinning,
  setDotpath,
  validateConfigDotpath,
  validateUrlValue,
  validateUrlValueWithDns,
  writeSandboxConfig,
};
