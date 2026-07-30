// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
//
// Thin lifecycle glue for the Hermes managed-tool host broker.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { ROOT, run, runCapture, validateName } = require("./runner");
const { buildSubprocessEnv } = require("./subprocess-env");
const { getCredsDir } = require("./credentials/store");
const oauth = require("./oauth-device-code");
const onboardProviders = require("./onboard/providers");

const HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV = "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN";
const HERMES_TOOL_GATEWAY_PORT = 11436;
const HERMES_TOOL_GATEWAY_STATE_DIR = path.join(getCredsDir(), "hermes-tool-gateway");
const HERMES_TOOL_GATEWAY_PID_PATH = path.join(getCredsDir(), "hermes-tool-gateway-broker.pid");
const HERMES_TOOL_GATEWAY_HASH_PATH = path.join(getCredsDir(), "hermes-tool-gateway-broker.hash");
const HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH = path.join(
  getCredsDir(),
  "hermes-tool-gateway-broker.sock",
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
const HERMES_TOOL_GATEWAY_RUNTIME_CREDENTIALS_PATH = path.join(
  ROOT,
  "agents",
  "hermes",
  "host",
  "runtime-refresh-credentials.ts",
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
  return crypto
    .createHash("sha256")
    .update(String(refreshToken || ""))
    .digest("hex");
}

function generateHermesToolGatewayBrokerToken() {
  return `nc_broker_${crypto.randomBytes(32).toString("base64url")}`;
}

function getHermesToolGatewayProviderName(sandboxName) {
  return `${validateName(sandboxName, "sandbox name")}-hermes-tool-gateway`;
}

function getHermesInferenceProviderName(sandboxName) {
  return `${validateName(sandboxName, "sandbox name")}-hermes-inference`;
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

function persistHermesToolGatewayProviderState(
  sandboxName,
  refreshToken,
  brokerToken = null,
  inferenceProviderName = "hermes-provider",
) {
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
    inference_provider_name: validateName(inferenceProviderName, "Hermes inference provider name"),
    inference_credential_env: "OPENAI_API_KEY",
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

function brokerControlJsonRequest(route, payload) {
  if (!fs.existsSync(HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH)) return null;
  const result = spawnSync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--fail",
      "--unix-socket",
      HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH,
      "--request",
      "POST",
      "--header",
      "Content-Type: application/json",
      "--data-binary",
      "@-",
      `http://localhost/${route}`,
    ],
    {
      encoding: "utf8",
      input: JSON.stringify(payload),
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 30_000,
    },
  );
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function brokerControlRequest(route, payload) {
  return brokerControlJsonRequest(route, payload) !== null;
}

function registerHermesToolGatewayRuntimeCredential(refreshToken, exactSandboxName = null) {
  const digest = hashRefreshToken(refreshToken);
  let matched = false;
  const stateNames =
    exactSandboxName === null
      ? fs.readdirSync(HERMES_TOOL_GATEWAY_STATE_DIR)
      : [`${validateName(exactSandboxName, "sandbox name")}.json`];
  for (const name of stateNames) {
    if (!name.endsWith(".json")) continue;
    const sandboxName = name.slice(0, -".json".length);
    const state = readHermesToolGatewayProviderState(sandboxName);
    if (!state || state.refresh_token_sha256 !== digest) continue;
    matched = true;
    if (
      !brokerControlRequest("credentials/register", {
        sandbox: sandboxName,
        refresh_token: refreshToken,
      })
    ) {
      return false;
    }
  }
  return matched;
}

function removeHermesToolGatewayProviderState(sandboxName) {
  const file = getHermesToolGatewayStatePath(sandboxName);
  const unregistered =
    !fs.existsSync(HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH) ||
    brokerControlRequest("credentials/unregister", {
      sandbox: validateName(sandboxName, "sandbox name"),
    });
  let unlinked = false;
  try {
    fs.unlinkSync(file);
    unlinked = true;
  } catch (error) {
    unlinked = Boolean(error && error.code === "ENOENT");
  }
  return unregistered && unlinked;
}

function brokerRuntimeFileHash(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "missing";
  }
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
    { [HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV]: state.brokerToken },
    runOpenshell,
  );
  if (!result.ok) {
    throw new Error(result.message || `failed to upsert provider '${providerName}'`);
  }
  return { providerName, brokerToken: state.brokerToken };
}

/**
 * Bind a newly created snapshot destination to its own host-broker identity.
 * The refresh credential remains process-local; OpenShell stores only a fresh
 * opaque broker token. The durable state file records the refresh digest and
 * destination identity without persisting the upstream OAuth secret.
 */
function bindHermesToolGatewayCloneProviderState(sandboxName, refreshToken) {
  const normalized = String(refreshToken || "").trim();
  if (!normalized) {
    throw new Error("Hermes tool gateway refresh credential is empty");
  }
  const state = persistHermesToolGatewayProviderState(
    sandboxName,
    normalized,
    generateHermesToolGatewayBrokerToken(),
    getHermesInferenceProviderName(sandboxName),
  );
  if (
    ensureHermesToolGatewayBroker({
      refreshToken: normalized,
      sandboxName: validateName(sandboxName, "sandbox name"),
    })
  ) {
    return state;
  }
  removeHermesToolGatewayProviderState(sandboxName);
  throw new Error("Hermes managed-tool gateway broker did not become ready");
}

function stageHermesToolGatewayCloneBinding(sandboxName, refreshToken) {
  const sandbox = validateName(sandboxName, "sandbox name");
  const normalized = String(refreshToken || "").trim();
  if (!normalized) {
    throw new Error("Hermes tool gateway refresh credential is empty");
  }
  if (!ensureHermesToolGatewayBroker({ startWithoutCredential: true })) {
    throw new Error("Hermes managed-tool gateway broker could not start before destination change");
  }
  const response = brokerControlJsonRequest("credentials/stage", {
    sandbox,
    refresh_token: normalized,
    inference_provider_name: getHermesInferenceProviderName(sandbox),
  });
  const activationToken =
    response && typeof response.activation_token === "string"
      ? response.activation_token.trim()
      : "";
  const brokerToken =
    response && typeof response.broker_token === "string" ? response.broker_token.trim() : "";
  if (!activationToken.startsWith("nc_activate_") || !brokerToken.startsWith("nc_broker_")) {
    throw new Error("Hermes managed-tool gateway broker could not stage destination credentials");
  }
  return Object.freeze({ activationToken, brokerToken });
}

function activateHermesToolGatewayCloneBinding(sandboxName, refreshToken, stagedBinding) {
  const sandbox = validateName(sandboxName, "sandbox name");
  const normalized = String(refreshToken || "").trim();
  const activationToken = String(stagedBinding?.activationToken || "").trim();
  const brokerToken = String(stagedBinding?.brokerToken || "").trim();
  if (!normalized || !activationToken || !brokerToken) {
    throw new Error("Hermes staged destination credential binding is incomplete");
  }
  const state = persistHermesToolGatewayProviderState(
    sandbox,
    normalized,
    brokerToken,
    getHermesInferenceProviderName(sandbox),
  );
  if (
    brokerControlRequest("credentials/activate", {
      sandbox,
      activation_token: activationToken,
    })
  ) {
    return state;
  }
  removeHermesToolGatewayProviderState(sandbox);
  throw new Error("Hermes managed-tool gateway broker could not activate destination credentials");
}

function discardHermesToolGatewayCloneBinding(sandboxName, stagedBinding) {
  const activationToken = String(stagedBinding?.activationToken || "").trim();
  if (!activationToken) return true;
  return brokerControlRequest("credentials/discard", {
    sandbox: validateName(sandboxName, "sandbox name"),
    activation_token: activationToken,
  });
}

function probeHermesToolGatewayBrokerStart(options = {}) {
  const spawnProbe = options.spawnSyncImpl || spawnSync;
  const probePort = Number.isInteger(options.port) ? options.port : HERMES_TOOL_GATEWAY_PORT;
  // AF_UNIX paths are short on macOS; TMPDIR can already consume most of the
  // limit before the private control-socket name is appended.
  const probeTempRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const probeRoot = fs.mkdtempSync(path.join(probeTempRoot, "nc-hermes-probe-"));
  fs.chmodSync(probeRoot, 0o700);
  const stateDir = path.join(probeRoot, "state");
  const controlSocket = path.join(probeRoot, "control.sock");
  ensurePrivateDir(stateDir);
  try {
    const result = spawnProbe(
      process.execPath,
      ["--experimental-strip-types", HERMES_TOOL_GATEWAY_SCRIPT],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        cwd: ROOT,
        env: buildSubprocessEnv({
          HERMES_TOOL_GATEWAY_PORT: String(probePort),
          HERMES_TOOL_GATEWAY_STATE_DIR: stateDir,
          HERMES_TOOL_GATEWAY_MATRIX_PATH,
          HERMES_TOOL_GATEWAY_CONTROL_SOCKET: controlSocket,
          HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV,
          HERMES_TOOL_GATEWAY_PREFLIGHT_PROBE: "1",
          NOUS_PORTAL_BASE_URL: process.env.NOUS_PORTAL_BASE_URL || oauth.DEFAULT_PORTAL_BASE_URL,
          NEMOCLAW_OPENSHELL_BIN: process.env.NEMOCLAW_OPENSHELL_BIN || "openshell",
        }),
        timeout: 10_000,
      },
    );
    if (result.error) {
      throw new Error(
        `Hermes managed-tool broker preflight could not start: ${result.error.message}`,
      );
    }
    if (result.status === 2) {
      throw new Error("Hermes managed-tool broker preflight could not bind its runtime endpoints");
    }
    if (result.status === 3) {
      throw new Error("Hermes managed-tool broker preflight control registration path failed");
    }
    if (result.status !== 0) {
      throw new Error(
        `Hermes managed-tool broker preflight did not become ready (exit ${String(result.status)})`,
      );
    }
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

/**
 * Prove that a clone can use the current broker runtime before any destination
 * is deleted or any OAuth flow begins. The isolated probe creates only
 * disposable private runtime files and performs no durable provider,
 * credential, or broker-process mutation.
 */
function preflightHermesToolGatewayCloneBinding(sandboxName) {
  validateName(sandboxName, "sandbox name");
  const requiredRuntimeFiles = [
    HERMES_TOOL_GATEWAY_SCRIPT,
    HERMES_TOOL_GATEWAY_MATRIX_PATH,
    HERMES_TOOL_GATEWAY_RUNTIME_CREDENTIALS_PATH,
  ];
  const missing = requiredRuntimeFiles.filter((file) => brokerRuntimeFileHash(file) === "missing");
  if (missing.length > 0) {
    throw new Error(
      `Hermes managed-tool broker runtime is incomplete (${missing
        .map((file) => path.basename(file))
        .join(", ")})`,
    );
  }

  const pid = readPid();
  const currentBrokerOwned = isHermesToolGatewayBrokerProcess(pid) || brokerStartedThisRun;
  const currentBrokerHealthy = isHermesToolGatewayBrokerHealthy();
  if (currentBrokerHealthy && !currentBrokerOwned) {
    throw new Error("Hermes managed-tool broker health endpoint is not owned by NemoClaw");
  }
  if (!currentBrokerOwned || !currentBrokerHealthy) {
    probeHermesToolGatewayBrokerStart();
    return;
  }
  if (readBrokerHash() !== brokerRuntimeHash()) {
    throw new Error(
      "Hermes managed-tool broker runtime changed while an existing broker is active; " +
        "reauthorize every managed-tool Hermes sandbox before retrying",
    );
  }
  if (!fs.existsSync(HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH)) {
    throw new Error("Hermes managed-tool broker control socket is unavailable");
  }
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
        scriptSha256: brokerRuntimeFileHash(HERMES_TOOL_GATEWAY_SCRIPT),
        runtimeCredentials: HERMES_TOOL_GATEWAY_RUNTIME_CREDENTIALS_PATH,
        runtimeCredentialsSha256: brokerRuntimeFileHash(
          HERMES_TOOL_GATEWAY_RUNTIME_CREDENTIALS_PATH,
        ),
        matrix: HERMES_TOOL_GATEWAY_MATRIX_PATH,
        matrixSha256: brokerRuntimeFileHash(HERMES_TOOL_GATEWAY_MATRIX_PATH),
        stateDir: HERMES_TOOL_GATEWAY_STATE_DIR,
        controlSocket: HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH,
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
  try {
    fs.unlinkSync(HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH);
  } catch {
    /* ignore */
  }
}

function spawnHermesToolGatewayBroker(refreshToken, initialSandboxName = null) {
  ensurePrivateDir(HERMES_TOOL_GATEWAY_STATE_DIR);
  const credentialEnv = {};
  if (typeof refreshToken === "string" && refreshToken.trim()) {
    credentialEnv[HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV] = refreshToken.trim();
  }
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", HERMES_TOOL_GATEWAY_SCRIPT],
    {
      detached: true,
      stdio: "ignore",
      cwd: ROOT,
      env: buildSubprocessEnv({
        HERMES_TOOL_GATEWAY_PORT: String(HERMES_TOOL_GATEWAY_PORT),
        HERMES_TOOL_GATEWAY_STATE_DIR,
        HERMES_TOOL_GATEWAY_MATRIX_PATH,
        HERMES_TOOL_GATEWAY_CONTROL_SOCKET: HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH,
        HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV,
        ...(initialSandboxName === null
          ? {}
          : {
              HERMES_TOOL_GATEWAY_INITIAL_SANDBOX: validateName(initialSandboxName, "sandbox name"),
            }),
        NOUS_PORTAL_BASE_URL: process.env.NOUS_PORTAL_BASE_URL || oauth.DEFAULT_PORTAL_BASE_URL,
        NEMOCLAW_OPENSHELL_BIN: process.env.NEMOCLAW_OPENSHELL_BIN || "openshell",
        ...credentialEnv,
      }),
    },
  );
  child.unref();
  writePid(child.pid);
  writeBrokerHash(brokerRuntimeHash());
  return child.pid || null;
}

function planHermesToolGatewayBrokerRefresh({
  currentBrokerHealthy,
  forceRestart = false,
  hashMatches,
}) {
  if (!forceRestart && currentBrokerHealthy && !hashMatches) {
    return "preserve-runtime-mismatch";
  }
  if (!forceRestart && currentBrokerHealthy) {
    return "register-with-current";
  }
  return "start-or-restart";
}

function ensureHermesToolGatewayBroker(options = {}) {
  const refreshToken =
    typeof options.refreshToken === "string" && options.refreshToken.trim()
      ? options.refreshToken.trim()
      : "";
  const desiredHash = brokerRuntimeHash();
  const hashMatches = readBrokerHash() === desiredHash;
  const pid = readPid();
  const currentBrokerOwned = isHermesToolGatewayBrokerProcess(pid) || brokerStartedThisRun;
  const currentBrokerHealthy = currentBrokerOwned && isHermesToolGatewayBrokerHealthy();
  if (options.startWithoutCredential) {
    if (currentBrokerHealthy) {
      return hashMatches && fs.existsSync(HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH);
    }
    killStaleHermesToolGatewayBroker();
    const nextPid = spawnHermesToolGatewayBroker("");
    for (let attempt = 0; attempt < 20; attempt++) {
      if (
        isHermesToolGatewayBrokerProcess(nextPid) &&
        isHermesToolGatewayBrokerHealthy() &&
        fs.existsSync(HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH)
      ) {
        brokerStartedThisRun = true;
        return true;
      }
      sleep(250);
    }
    return false;
  }
  const refreshPlan = refreshToken
    ? planHermesToolGatewayBrokerRefresh({
        currentBrokerHealthy,
        forceRestart: options.forceRestart,
        hashMatches,
      })
    : null;
  if (refreshPlan === "preserve-runtime-mismatch") {
    console.error(
      "Hermes managed-tool broker runtime changed while an existing broker is active; " +
        "refusing to restart it and discard other in-memory sandbox credentials. " +
        "Reauthorize every managed-tool Hermes sandbox using the documented broker recovery flow.",
    );
    return false;
  }
  if (refreshPlan === "register-with-current") {
    const registered = registerHermesToolGatewayRuntimeCredential(
      refreshToken,
      options.sandboxName ?? null,
    );
    if (registered) brokerStartedThisRun = true;
    return registered;
  }
  if (refreshPlan === "start-or-restart") {
    killStaleHermesToolGatewayBroker();
    const nextPid = spawnHermesToolGatewayBroker(refreshToken, options.sandboxName ?? null);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (
        isHermesToolGatewayBrokerProcess(nextPid) &&
        isHermesToolGatewayBrokerHealthy() &&
        registerHermesToolGatewayRuntimeCredential(refreshToken, options.sandboxName ?? null)
      ) {
        brokerStartedThisRun = true;
        return true;
      }
      sleep(250);
    }
    return false;
  }

  if (
    !options.forceRestart &&
    hashMatches &&
    brokerStartedThisRun &&
    isHermesToolGatewayBrokerHealthy()
  ) {
    return true;
  }
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

function matchesHermesToolGatewayProviderState(entry, state) {
  if (!isHermesManagedToolGatewayEntry(entry) || !state || typeof state !== "object") {
    return false;
  }
  const sandbox = validateName(entry.name, "sandbox name");
  if (
    state.sandbox !== sandbox ||
    state.provider_name !== getHermesToolGatewayProviderName(sandbox)
  ) {
    return false;
  }
  const isolatedProvider =
    typeof entry.hermesInferenceProvider === "string" ? entry.hermesInferenceProvider.trim() : "";
  if (!isolatedProvider) {
    return (
      state.inference_provider_name === undefined ||
      state.inference_provider_name === "hermes-provider"
    );
  }
  return (
    isolatedProvider === getHermesInferenceProviderName(sandbox) &&
    state.inference_provider_name === isolatedProvider
  );
}

function ensureHermesToolGatewayBrokerForSandboxEntry(entry, options = {}) {
  const enabled = isHermesManagedToolGatewayEntry(entry);
  if (!enabled) return false;
  if (
    !matchesHermesToolGatewayProviderState(entry, readHermesToolGatewayProviderState(entry.name))
  ) {
    return false;
  }
  return ensureHermesToolGatewayBroker(options);
}

module.exports = {
  HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV,
  HERMES_TOOL_GATEWAY_STATE_DIR,
  HERMES_TOOL_GATEWAY_PORT,
  HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH,
  hashRefreshToken,
  generateHermesToolGatewayBrokerToken,
  getHermesToolGatewayProviderName,
  getHermesInferenceProviderName,
  getHermesToolGatewayStatePath,
  getHermesToolGatewayBrokerToken,
  persistHermesToolGatewayProviderState,
  removeHermesToolGatewayProviderState,
  registerHermesToolGatewayRefreshProvider,
  probeHermesToolGatewayBrokerStart,
  preflightHermesToolGatewayCloneBinding,
  stageHermesToolGatewayCloneBinding,
  activateHermesToolGatewayCloneBinding,
  discardHermesToolGatewayCloneBinding,
  bindHermesToolGatewayCloneProviderState,
  planHermesToolGatewayBrokerRefresh,
  isHermesToolGatewayBrokerHealthy,
  killStaleHermesToolGatewayBroker,
  ensureHermesToolGatewayBroker,
  isHermesManagedToolGatewayEntry,
  matchesHermesToolGatewayProviderState,
  ensureHermesToolGatewayBrokerForSandboxEntry,
};
