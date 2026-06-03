// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
//
// Thin lifecycle glue for the Hermes managed-tool host broker.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { ROOT, run, runCapture, validateName } = require("./runner");
const { buildSubprocessEnv } = require("./subprocess-env");
const { getCredsDir } = require("./credentials/store");
const oauth = require("./oauth-device-code");
const onboardProviders = require("./onboard/providers");

const HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV =
  "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN";
const HERMES_TOOL_GATEWAY_PORT = 11436;
const HERMES_TOOL_GATEWAY_STATE_DIR = path.join(getCredsDir(), "hermes-tool-gateway");
const HERMES_TOOL_GATEWAY_PID_PATH = path.join(
  getCredsDir(),
  "hermes-tool-gateway-broker.pid",
);
const HERMES_TOOL_GATEWAY_HASH_PATH = path.join(
  getCredsDir(),
  "hermes-tool-gateway-broker.hash",
);
const HERMES_TOOL_GATEWAY_SCRIPT = path.join(
  ROOT,
  "agents",
  "hermes",
  "host",
  "tool-gateway-broker.ts",
);
const HERMES_TOOL_GATEWAY_MATRIX_PATH = path.join(
  ROOT,
  "agents",
  "hermes",
  "host",
  "managed-tool-gateway-matrix.json",
);

let brokerStartedThisRun = false;

function sleep(ms) {
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, ms);
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function hashRefreshToken(refreshToken) {
  return crypto.createHash("sha256").update(String(refreshToken || "")).digest("hex");
}

function generateHermesToolGatewayBrokerToken() {
  return `nc_broker_${crypto.randomBytes(32).toString("base64url")}`;
}

function getHermesToolGatewayProviderName(sandboxName) {
  return `${validateName(sandboxName, "sandbox name")}-hermes-tool-gateway`;
}

function getHermesToolGatewayStatePath(sandboxName) {
  ensurePrivateDir(HERMES_TOOL_GATEWAY_STATE_DIR);
  return path.join(
    HERMES_TOOL_GATEWAY_STATE_DIR,
    `${validateName(sandboxName, "sandbox name")}.json`,
  );
}

function atomicWriteJson(file, value) {
  ensurePrivateDir(path.dirname(file));
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function readHermesToolGatewayProviderState(sandboxName) {
  const file = getHermesToolGatewayStatePath(sandboxName);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getHermesToolGatewayBrokerToken(sandboxName) {
  const state = readHermesToolGatewayProviderState(sandboxName);
  const token = state && typeof state.broker_token === "string" ? state.broker_token.trim() : "";
  return token || null;
}

function persistHermesToolGatewayProviderState(sandboxName, refreshToken, brokerToken = null) {
  const file = getHermesToolGatewayStatePath(sandboxName);
  const previous = readHermesToolGatewayProviderState(sandboxName);
  const normalizedBrokerToken =
    typeof brokerToken === "string" && brokerToken.trim()
      ? brokerToken.trim()
      : typeof previous?.broker_token === "string" && previous.broker_token.trim()
        ? previous.broker_token.trim()
        : generateHermesToolGatewayBrokerToken();
  atomicWriteJson(file, {
    version: 1,
    sandbox: validateName(sandboxName, "sandbox name"),
    provider_name: getHermesToolGatewayProviderName(sandboxName),
    credential_env: HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV,
    broker_token: normalizedBrokerToken,
    broker_token_sha256: hashRefreshToken(normalizedBrokerToken),
    refresh_token_sha256: hashRefreshToken(refreshToken),
    client_id: oauth.DEFAULT_CLIENT_ID,
    portal_base_url: oauth.DEFAULT_PORTAL_BASE_URL,
    updated_at: new Date().toISOString(),
  });
  return { file, brokerToken: normalizedBrokerToken };
}

function registerHermesToolGatewayRefreshProvider(sandboxName, refreshToken, runOpenshell) {
  const normalized = String(refreshToken || "").trim();
  if (!normalized) {
    throw new Error("Hermes tool gateway refresh credential is empty");
  }
  const state = persistHermesToolGatewayProviderState(sandboxName, normalized);
  const providerName = getHermesToolGatewayProviderName(sandboxName);
  const result = onboardProviders.upsertProvider(
    providerName,
    "generic",
    HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV,
    null,
    { [HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV]: normalized },
    runOpenshell,
  );
  if (!result.ok) {
    throw new Error(result.message || `failed to upsert provider '${providerName}'`);
  }
  return { providerName, brokerToken: state.brokerToken };
}

function readPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(HERMES_TOOL_GATEWAY_PID_PATH, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  ensurePrivateDir(getCredsDir());
  fs.writeFileSync(HERMES_TOOL_GATEWAY_PID_PATH, `${pid}\n`, { mode: 0o600 });
  fs.chmodSync(HERMES_TOOL_GATEWAY_PID_PATH, 0o600);
}

function clearPid() {
  try {
    fs.unlinkSync(HERMES_TOOL_GATEWAY_PID_PATH);
  } catch {
    /* ignore */
  }
}

function brokerRuntimeHash() {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        port: HERMES_TOOL_GATEWAY_PORT,
        script: HERMES_TOOL_GATEWAY_SCRIPT,
        matrix: HERMES_TOOL_GATEWAY_MATRIX_PATH,
        stateDir: HERMES_TOOL_GATEWAY_STATE_DIR,
      }),
    )
    .digest("hex");
}

function readBrokerHash() {
  try {
    return fs.readFileSync(HERMES_TOOL_GATEWAY_HASH_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeBrokerHash(hash) {
  ensurePrivateDir(getCredsDir());
  fs.writeFileSync(HERMES_TOOL_GATEWAY_HASH_PATH, `${hash}\n`, { mode: 0o600 });
  fs.chmodSync(HERMES_TOOL_GATEWAY_HASH_PATH, 0o600);
}

function clearBrokerHash() {
  try {
    fs.unlinkSync(HERMES_TOOL_GATEWAY_HASH_PATH);
  } catch {
    /* ignore */
  }
}

function isHermesToolGatewayBrokerProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const cmdline = runCapture(["ps", "-p", String(pid), "-o", "args="], { ignoreError: true });
  return Boolean(cmdline && cmdline.includes("tool-gateway-broker.ts"));
}

function isHermesToolGatewayBrokerHealthy() {
  const result = run(
    [
      "curl",
      "-sf",
      "--connect-timeout",
      "3",
      "--max-time",
      "5",
      `http://127.0.0.1:${HERMES_TOOL_GATEWAY_PORT}/health`,
    ],
    { ignoreError: true, suppressOutput: true },
  );
  return result.status === 0;
}

function killStaleHermesToolGatewayBroker() {
  const pid = readPid();
  if (isHermesToolGatewayBrokerProcess(pid)) {
    run(["kill", String(pid)], { ignoreError: true, suppressOutput: true });
  }
  clearPid();
  clearBrokerHash();
}

function spawnHermesToolGatewayBroker(refreshToken) {
  ensurePrivateDir(HERMES_TOOL_GATEWAY_STATE_DIR);
  const credentialEnv = {};
  if (typeof refreshToken === "string" && refreshToken.trim()) {
    credentialEnv[HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV] = refreshToken.trim();
  }
  const child = spawn(process.execPath, ["--experimental-strip-types", HERMES_TOOL_GATEWAY_SCRIPT], {
    detached: true,
    stdio: "ignore",
    cwd: ROOT,
    env: buildSubprocessEnv({
      HERMES_TOOL_GATEWAY_PORT: String(HERMES_TOOL_GATEWAY_PORT),
      HERMES_TOOL_GATEWAY_STATE_DIR,
      HERMES_TOOL_GATEWAY_MATRIX_PATH,
      HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV,
      NOUS_PORTAL_BASE_URL: process.env.NOUS_PORTAL_BASE_URL || oauth.DEFAULT_PORTAL_BASE_URL,
      NEMOCLAW_OPENSHELL_BIN: process.env.NEMOCLAW_OPENSHELL_BIN || "openshell",
      ...credentialEnv,
    }),
  });
  child.unref();
  writePid(child.pid);
  writeBrokerHash(brokerRuntimeHash());
  return child.pid || null;
}

function ensureHermesToolGatewayBroker(options = {}) {
  const refreshToken =
    typeof options.refreshToken === "string" && options.refreshToken.trim()
      ? options.refreshToken.trim()
      : "";
  if (refreshToken) {
    killStaleHermesToolGatewayBroker();
    const nextPid = spawnHermesToolGatewayBroker(refreshToken);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (isHermesToolGatewayBrokerProcess(nextPid) && isHermesToolGatewayBrokerHealthy()) {
        brokerStartedThisRun = true;
        return true;
      }
      sleep(250);
    }
    return false;
  }

  const desiredHash = brokerRuntimeHash();
  const hashMatches = readBrokerHash() === desiredHash;
  if (
    !options.forceRestart &&
    hashMatches &&
    brokerStartedThisRun &&
    isHermesToolGatewayBrokerHealthy()
  ) {
    return true;
  }
  const pid = readPid();
  if (
    !options.forceRestart &&
    hashMatches &&
    isHermesToolGatewayBrokerProcess(pid) &&
    isHermesToolGatewayBrokerHealthy()
  ) {
    brokerStartedThisRun = true;
    return true;
  }
  if (!options.forceRestart && hashMatches && isHermesToolGatewayBrokerHealthy()) {
    brokerStartedThisRun = true;
    return true;
  }
  // Raw Nous OAuth stays out of durable ~/.nemoclaw state. If the broker is
  // not already healthy, a fresh OAuth run must provide the refresh token.
  return false;
}

function isHermesManagedToolGatewayEntry(entry) {
  const enabled =
    entry &&
    entry.agent === "hermes" &&
    Array.isArray(entry.hermesToolGateways) &&
    entry.hermesToolGateways.length > 0;
  return Boolean(enabled);
}

function ensureHermesToolGatewayBrokerForSandboxEntry(entry, options = {}) {
  const enabled = isHermesManagedToolGatewayEntry(entry);
  if (!enabled) return false;
  return ensureHermesToolGatewayBroker(options);
}

module.exports = {
  HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV,
  HERMES_TOOL_GATEWAY_STATE_DIR,
  HERMES_TOOL_GATEWAY_PORT,
  hashRefreshToken,
  generateHermesToolGatewayBrokerToken,
  getHermesToolGatewayProviderName,
  getHermesToolGatewayStatePath,
  getHermesToolGatewayBrokerToken,
  persistHermesToolGatewayProviderState,
  registerHermesToolGatewayRefreshProvider,
  isHermesToolGatewayBrokerHealthy,
  killStaleHermesToolGatewayBroker,
  ensureHermesToolGatewayBroker,
  isHermesManagedToolGatewayEntry,
  ensureHermesToolGatewayBrokerForSandboxEntry,
};
