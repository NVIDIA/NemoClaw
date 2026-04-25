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

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { promises: dnsPromises } = require("node:dns");
const { isIPv4, isIPv6 } = require("node:net");
const { validateName } = require("./runner");
const credentialFilter: typeof import("./credential-filter") = require("./credential-filter");
const { stripCredentials, isConfigObject, isConfigValue } = credentialFilter;
const { appendAuditEntry } = require("./shields-audit");

type ConfigObject = import("./credential-filter").ConfigObject;
type ConfigValue = import("./credential-filter").ConfigValue;
const { runOpenshellCommand, captureOpenshellCommand } = require("./openshell");

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
}

interface CidrRange {
  network: Uint8Array;
  prefixLen: number;
}

interface LookupAddress {
  address: string;
  family: number;
}

type LookupFn = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

const DEFAULT_AGENT_CONFIG: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
};

function resolveAgentConfig(sandboxName: string): AgentConfigTarget {
  try {
    const registry = require("./registry");
    const entry = registry.getSandbox(sandboxName);
    if (!entry || !entry.agent) return DEFAULT_AGENT_CONFIG;

    const agentDefs = require("./agent-defs");
    const agent = agentDefs.loadAgent(entry.agent);
    const cfg = agent.configPaths;

    return {
      agentName: entry.agent,
      configPath: `${cfg.immutableDir}/${cfg.configFile}`,
      configDir: cfg.immutableDir,
      format: cfg.format || "json",
      configFile: cfg.configFile,
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
 * Return true when every segment in a dotpath is an own property on the
 * current config object, which keeps config set constrained to recognized keys.
 */
function isRecognizedConfigPath(obj: ConfigValue, dotpath: string): boolean {
  if (!dotpath || typeof dotpath !== "string") return false;
  const keys = dotpath.split(".");
  if (keys.some((key) => !key)) return false;

  let current: ConfigValue = obj;
  for (const key of keys) {
    if (!isConfigObject(current)) return false;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return false;
    current = current[key];
  }
  return true;
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

const PRIVATE_NETWORKS: CidrRange[] = [
  cidr("0.0.0.0", 8), // RFC 1122 "This network"
  cidr("127.0.0.0", 8),
  cidr("10.0.0.0", 8),
  cidr("172.16.0.0", 12),
  cidr("192.168.0.0", 16),
  cidr("169.254.0.0", 16),
  cidr("100.64.0.0", 10), // RFC 6598 CGNAT
  cidr("198.18.0.0", 15), // RFC 2544 benchmark range
  cidr6("::1", 128),
  cidr6("::", 128),
  cidr6("fc00::", 7),
  cidr6("fe80::", 10),
  cidr6("ff00::", 8),
];

function parseIPv4(addr: string): Uint8Array {
  const parts = addr.split(".");
  return new Uint8Array(parts.map(Number));
}

function parseIPv6(addr: string): Uint8Array {
  // Handle IPv4-mapped notation (e.g., ::ffff:127.0.0.1)
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    const ipv4Parts = tail.split(".").map(Number);
    const hi = ((ipv4Parts[0] << 8) | ipv4Parts[1]).toString(16);
    const lo = ((ipv4Parts[2] << 8) | ipv4Parts[3]).toString(16);
    return parseIPv6(addr.slice(0, lastColon + 1) + hi + ":" + lo);
  }

  let groups: string[];
  if (addr.includes("::")) {
    const [left, right] = addr.split("::");
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    groups = [...leftGroups, ...Array<string>(missing).fill("0"), ...rightGroups];
  } else {
    groups = addr.split(":");
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const val = parseInt(groups[i], 16);
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }
  return bytes;
}

function cidr(addr: string, prefixLen: number): CidrRange {
  return { network: parseIPv4(addr), prefixLen };
}

function cidr6(addr: string, prefixLen: number): CidrRange {
  return { network: parseIPv6(addr), prefixLen };
}

function ipInCidr(ipBytes: Uint8Array, range: CidrRange): boolean {
  if (ipBytes.length !== range.network.length) return false;

  const fullBytes = Math.floor(range.prefixLen / 8);
  const remainingBits = range.prefixLen % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== range.network[i]) return false;
  }

  if (remainingBits > 0) {
    const mask = 0xff << (8 - remainingBits);
    if ((ipBytes[fullBytes] & mask) !== (range.network[fullBytes] & mask)) return false;
  }

  return true;
}

function isIPv4Mapped(bytes: Uint8Array): boolean {
  return (
    bytes.length === 16 &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff &&
    bytes.slice(0, 10).every((b) => b === 0)
  );
}

function normalizeHostname(hostname: string): string {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isPrivateIpAddress(addr: string): boolean {
  const normalized = normalizeHostname(addr);

  if (isIPv4(normalized)) {
    const ipBytes = parseIPv4(normalized);
    return PRIVATE_NETWORKS.some((range) => ipInCidr(ipBytes, range));
  }

  if (isIPv6(normalized)) {
    const ipBytes = parseIPv6(normalized);
    if (isIPv4Mapped(ipBytes)) {
      const ipv4Bytes = ipBytes.slice(12);
      return PRIVATE_NETWORKS.some((range) => ipInCidr(ipv4Bytes, range));
    }
    return PRIVATE_NETWORKS.some((range) => ipInCidr(ipBytes, range));
  }

  return false;
}

function parseHttpUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null; // Not a URL — skip validation
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL scheme "${parsed.protocol}" is not allowed. Use http: or https:.`);
  }

  if (!parsed.hostname) {
    throw new Error(`No hostname found in URL "${value}".`);
  }

  return parsed;
}

function assertPublicHost(hostname: string): void {
  if (isLoopbackHostname(hostname) || isPrivateIpAddress(hostname)) {
    throw new Error(
      `URL points to private/internal address "${hostname}". ` +
        `This could expose internal services to the sandbox.`,
    );
  }
}

function validateUrlValue(value: string): void {
  const parsed = parseHttpUrl(value);
  if (!parsed) return;
  assertPublicHost(normalizeHostname(parsed.hostname));
}

async function validateUrlValueWithDns(
  value: string,
  lookup: LookupFn = dnsPromises.lookup as LookupFn,
): Promise<void> {
  const parsed = parseHttpUrl(value);
  if (!parsed) return;

  const hostname = normalizeHostname(parsed.hostname);
  assertPublicHost(hostname);

  // Direct IP literal already validated above.
  if (isIPv4(hostname) || isIPv6(hostname)) {
    return;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot resolve hostname "${hostname}": ${message}`);
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`Cannot resolve hostname "${hostname}": no addresses returned.`);
  }

  for (const { address } of addresses) {
    if (isPrivateIpAddress(address)) {
      throw new Error(
        `URL hostname "${hostname}" resolves to private/internal address "${address}". ` +
          `This could expose internal services to the sandbox.`,
      );
    }
  }
}

function collectHttpUrls(value: ConfigValue): string[] {
  const urls: string[] = [];
  const stack: ConfigValue[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null) continue;

    if (typeof current === "string") {
      const trimmed = current.trim();
      const lower = trimmed.toLowerCase();
      if (lower.startsWith("http://") || lower.startsWith("https://")) {
        urls.push(trimmed);
      }
      continue;
    }

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    if (isConfigObject(current)) {
      stack.push(...Object.values(current));
    }
  }

  return urls;
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

// ---------------------------------------------------------------------------
// config get
// ---------------------------------------------------------------------------

interface ConfigGetOpts {
  key?: string | null;
  format?: string;
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

  const target = resolveAgentConfig(sandboxName);

  // 1. Read current config
  console.log(`  Reading ${target.agentName} config...`);
  const config = readSandboxConfig(sandboxName, target);

  // 2. Parse and validate value
  const parsedValue = parseCliConfigValue(opts.value);

  // 3. Validate URLs for SSRF (supports nested object/array values)
  const urlsToValidate = collectHttpUrls(parsedValue);
  for (const urlValue of urlsToValidate) {
    try {
      await validateUrlValueWithDns(urlValue);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  URL validation failed for ${redactUrlForLogs(urlValue)}: ${message}`);
      process.exit(1);
    }
  }

  // 4. Check that we're not modifying the gateway section (contains auth tokens)
  if (opts.key.startsWith("gateway.") || opts.key === "gateway") {
    console.error("  Cannot modify the gateway section directly.");
    console.error("  Use `nemoclaw config rotate-token` for credential changes.");
    process.exit(1);
  }

  if (!isRecognizedConfigPath(config, opts.key)) {
    console.error(
      `  Key validation failed: "${opts.key}" is not a recognized ${target.agentName} config path.`,
    );
    process.exit(1);
  }

  // 5. Show what will change
  const oldValue = extractDotpath(config, opts.key);
  console.log(`  Agent:     ${target.agentName}`);
  console.log(`  Key:       ${opts.key}`);
  console.log(`  Old value: ${oldValue !== undefined ? JSON.stringify(oldValue) : "(not set)"}`);
  console.log(`  New value: ${JSON.stringify(parsedValue)}`);

  // 6. Apply change
  setDotpath(config, opts.key, parsedValue);

  // 7. Write to temp file in the agent's native format
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-"));
  const tmpFile = path.join(tmpDir, target.configFile);
  fs.writeFileSync(tmpFile, serializeConfig(config, target.format), { mode: 0o600 });

  // 8. Write config to sandbox via kubectl exec (bypasses Landlock)
  console.log(`  Writing config to sandbox (${target.configPath})...`);
  const content = fs.readFileSync(tmpFile, "utf-8");
  execFileSync(
    "docker",
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

  // 9. Fix ownership via kubectl exec (bypasses Landlock)
  try {
    execFileSync(
      "docker",
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

  // 10. Cleanup temp
  try {
    fs.unlinkSync(tmpFile);
    fs.rmdirSync(tmpDir);
  } catch {
    // Best effort
  }

  // 11. Audit log
  appendAuditEntry({
    action: "shields_down",
    sandbox: sandboxName,
    timestamp: new Date().toISOString(),
    reason: `config set ${target.agentName}:${opts.key}`,
  });

  console.log(`  ${target.agentName} config updated.`);

  // 12. Restart if requested
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

  // 4. Save credential locally
  const { saveCredential } = require("./credentials");
  saveCredential(credentialEnv, newToken);
  console.log("  Credential saved to ~/.nemoclaw/credentials.json");

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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  configGet,
  configSet,
  configRotateToken,
  resolveAgentConfig,
  extractDotpath,
  setDotpath,
  isRecognizedConfigPath,
  validateUrlValue,
  validateUrlValueWithDns,
  readStdin,
};
