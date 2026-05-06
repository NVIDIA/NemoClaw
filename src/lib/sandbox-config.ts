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
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promises: dnsPromises } = require("node:dns");
const { isIP } = require("node:net");
const { validateName } = require("./runner");
const { dockerExecFileSync } = require("./docker/exec");
const credentialFilter: typeof import("./credential-filter") = require("./credential-filter");
const { stripCredentials, isConfigObject, isConfigValue, isCredentialField } = credentialFilter;
const { appendAuditEntry } = require("./shields-audit");
const { isPrivateHostname, isPrivateIp } = require("./private-networks");

type ConfigObject = import("./credential-filter").ConfigObject;
type ConfigValue = import("./credential-filter").ConfigValue;
const { runOpenshellCommand, captureOpenshellCommand } = require("./adapters/openshell/client");

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

const K3S_CONTAINER = "openshell-cluster-nemoclaw";

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

interface AgentConfigTarget {
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

function resolveAgentConfig(sandboxName: string): AgentConfigTarget {
  try {
    const registry = require("./registry");
    const entry = registry.getSandbox(sandboxName);
    if (!entry || !entry.agent) return DEFAULT_AGENT_CONFIG;

    const agentDefs = require("./agent-defs");
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
      { ignoreError: true, errorLine: console.error, exit: (code: number) => process.exit(code) },
    );
    raw = result.output || "";
  } catch {
    raw = "";
  }

  if (!raw || !raw.trim()) {
    console.error(`  Cannot read ${target.agentName} config (${target.configPath}).`);
    console.error("  Is the sandbox running?");
    process.exit(1);
  }

  try {
    return parseConfig(raw, target.format);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to parse ${target.agentName} config: ${message}`);
    process.exit(1);
  }
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

  return { protocol: parsed.protocol as "http:" | "https:", originalUrl, pinnedUrl: pinned.toString() };
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
      // a config-time/public → runtime/private DNS-rebinding window. For HTTPS,
      // preserve the original hostname so normal certificate validation still
      // protects the connection.
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
      console.error(`  Key "${opts.key}" not found in ${target.agentName} config.`);
      process.exit(1);
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
    console.error("  --key is required.");
    console.error("  Usage: nemoclaw <name> config set --key <dotpath> --value <value>");
    process.exit(1);
  }

  if (opts.value === undefined || opts.value === null) {
    console.error("  --value is required.");
    console.error("  Usage: nemoclaw <name> config set --key <dotpath> --value <value>");
    process.exit(1);
  }

  const dotpathCheck = validateConfigDotpath(opts.key);
  if (!dotpathCheck.ok) {
    console.error(`  Invalid config key '${opts.key}': ${dotpathCheck.reason}.`);
    process.exit(1);
  }

  const target = resolveAgentConfig(sandboxName);

  // Read current config
  console.log(`  Reading ${target.agentName} config...`);
  const config = readSandboxConfig(sandboxName, target);

  // Parse and validate value
  const parsedValue = parseCliConfigValue(opts.value);

  // Check that we're not modifying the gateway section (contains auth tokens)
  if (opts.key.startsWith("gateway.") || opts.key === "gateway") {
    console.error("  Cannot modify the gateway section directly.");
    console.error("  Use `nemoclaw config rotate-token` for credential changes.");
    process.exit(1);
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
    console.error(
      `  Cannot set '${opts.key}' in ${target.agentName} config: '${refusal.segment}' ${refusal.reason}.`,
    );
    process.exit(1);
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
      console.error(
        `  Key '${opts.key}' does not currently exist in the ${target.agentName} config.`,
      );
      console.error(
        "  Re-run interactively, pass --config-accept-new-path, or set NEMOCLAW_CONFIG_ACCEPT_NEW_PATH=1.",
      );
      process.exit(1);
    }
    if (gate.mode === "prompt") {
      const confirmed = await confirmYesNo("  Write this new key? [y/N] ");
      if (!confirmed) {
        console.error("  Aborted.");
        process.exit(1);
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
    const suffix = err instanceof ConfigUrlValidationError
      ? ` for ${redactUrlForLogs(err.urlValue)}`
      : "";
    console.error(`  URL validation failed${suffix}: ${message}`);
    process.exit(1);
  }

  // Apply change
  setDotpath(config, opts.key, safeValue);

  // Write to temp file in the agent's native format
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-"));
  const tmpFile = path.join(tmpDir, target.configFile);
  fs.writeFileSync(tmpFile, serializeConfig(config, target.format), { mode: 0o600 });

  // Write config to sandbox via kubectl exec (bypasses Landlock)
  console.log(`  Writing config to sandbox (${target.configPath})...`);
  const content = fs.readFileSync(tmpFile, "utf-8");
  dockerExecFileSync(
    [
      "exec",
      "-i",
      K3S_CONTAINER,
      "kubectl",
      "exec",
      "-n",
      "openshell",
      sandboxName,
      "-c",
      "agent",
      "-i",
      "--",
      "sh",
      "-c",
      `cat > ${target.configPath}`,
    ],
    { input: content, stdio: ["pipe", "pipe", "pipe"], timeout: 15000 },
  );

  // Fix ownership via kubectl exec (bypasses Landlock)
  try {
    dockerExecFileSync(
      [
        "exec",
        K3S_CONTAINER,
        "kubectl",
        "exec",
        "-n",
        "openshell",
        sandboxName,
        "-c",
        "agent",
        "--",
        "chown",
        "sandbox:sandbox",
        target.configPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
    );
  } catch {
    // Best effort — chown failure is non-fatal
  }

  // Cleanup temp
  try {
    fs.unlinkSync(tmpFile);
    fs.rmdirSync(tmpDir);
  } catch {
    // Best effort
  }

  // Audit log
  appendAuditEntry({
    action: "shields_down",
    sandbox: sandboxName,
    timestamp: new Date().toISOString(),
    reason: `config set ${target.agentName}:${opts.key}`,
  });

  console.log(`  ${target.agentName} config updated.`);

  // Restart if requested
  if (opts.restart) {
    console.log("  Restarting sandbox agent process...");
    const restartBinary = getOpenshellBinary();
    const result = captureOpenshellCommand(
      restartBinary,
      ["sandbox", "exec", "--name", sandboxName, "--", "kill", "-HUP", "1"],
      { ignoreError: true, errorLine: console.error, exit: (code: number) => process.exit(code) },
    );

    if (result.status !== 0) {
      console.error("  Could not signal the sandbox process to reload.");
      console.error("  You may need to recreate the sandbox for this change to take effect.");
    } else {
      console.log("  Reload signal sent.");
    }
  } else {
    console.log("");
    console.log("  Note: Some config changes require a sandbox restart to take effect.");
    console.log(`  Re-run with --restart or recreate with: nemoclaw onboard --recreate-sandbox`);
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
  const { loadSession } = require("./onboard-session");
  const session = loadSession();

  if (!session || !session.credentialEnv) {
    console.error(`  Cannot determine credential for sandbox '${sandboxName}'.`);
    console.error("  No onboard session found with a credentialEnv.");
    console.error("  Re-run: nemoclaw onboard --recreate-sandbox");
    process.exit(1);
  }

  if (session.sandboxName && session.sandboxName !== sandboxName) {
    console.error(
      `  Onboard session is for sandbox '${session.sandboxName}', not '${sandboxName}'.`,
    );
    process.exit(1);
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
      console.error(`  Environment variable "${opts.fromEnv}" is not set or empty.`);
      process.exit(1);
    }
  } else if (opts.fromStdin) {
    newToken = await readStdin();
  } else {
    const { promptSecret } = require("./credentials");
    newToken = await promptSecret(`  New ${credentialEnv} value: `);
  }

  if (!newToken || !newToken.trim()) {
    console.error("  Token cannot be empty.");
    process.exit(1);
  }

  newToken = newToken.trim();

  // 3. Validate — no whitespace in token
  if (/\s/.test(newToken)) {
    console.error("  Token contains whitespace. This is likely a paste error.");
    process.exit(1);
  }

  // 4. Stage the new value in the current process so the openshell update
  //    that follows can read it via --credential <ENV>. The OpenShell
  //    gateway becomes the system of record once the update succeeds.
  const { saveCredential } = require("./credentials");
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
      console.error("  Failed to update provider. You may need to re-onboard.");
      process.exit(1);
    }
  }

  // 6. Audit log
  appendAuditEntry({
    action: "shields_down",
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
  DEFAULT_AGENT_CONFIG,
  configGet,
  configSet,
  configRotateToken,
  parseConfigGetArgs,
  resolveAgentConfig,
  readSandboxConfig,
  extractDotpath,
  setDotpath,
  validateConfigDotpath,
  findClobberingAncestor,
  classifyNewKeyGate,
  validateUrlValue,
  validateUrlValueWithDns,
  rewriteConfigUrlsWithDnsPinning,
  formatConfigValueForLogs,
  parseConfig,
  readStdin,
};
