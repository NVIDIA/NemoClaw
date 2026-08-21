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

const { ROOT, run, runCapture, runCaptureEx, validateName } = require("./runner");
const { buildSubprocessEnv } = require("./subprocess-env");
const { getCredsDir } = require("./credentials/store");
const oauth = require("./oauth-device-code");
const onboardProviders = require("./onboard/providers");
const {
  HERMES_CLONE_CONTROL_CLIENT_TIMEOUT_MS,
  HERMES_CLONE_CONTROL_STATUS_TIMEOUT_MS,
  isValidActivationToken,
  isValidControlRequestId,
  isValidProviderName,
  newControlDeadline,
} = require(path.join(ROOT, "agents", "hermes", "host", "tool-gateway-control-contract.ts"));

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
const HERMES_TOOL_GATEWAY_CONTROL_CONTRACT_PATH = path.join(
  ROOT,
  "agents",
  "hermes",
  "host",
  "tool-gateway-control-contract.ts",
);
const HERMES_TOOL_GATEWAY_RUNTIME_MISMATCH_RECOVERY =
  "Reauthorize every managed-tool Hermes sandbox, then retry.";
const HERMES_TOOL_GATEWAY_UNOWNED_LISTENER_RECOVERY =
  "Stop the process holding that port, then retry.";
let reportedMissingListenerInspector = false;
const HERMES_TOOL_GATEWAY_CONTROL_CLIENT_SOURCE = [
  'const http = require("node:http");',
  "const [socketPath, route, timeoutValue] = process.argv.slice(1);",
  "const timeoutMs = Number(timeoutValue);",
  'let requestBody = "";',
  "let failed = false;",
  "const fail = () => { failed = true; process.exitCode = 1; };",
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  "  requestBody += chunk;",
  "  if (Buffer.byteLength(requestBody) > 1024 * 1024) {",
  "    fail();",
  "    process.stdin.destroy();",
  "  }",
  "});",
  'process.stdin.once("error", fail);',
  'process.stdin.once("end", () => {',
  "  if (failed) return;",
  "  const request = http.request(",
  "    {",
  "      socketPath,",
  "      path: `/${route}`,",
  '      method: "POST",',
  "      headers: {",
  '        "content-type": "application/json",',
  '        "content-length": Buffer.byteLength(requestBody),',
  "      },",
  "    },",
  "    (response) => {",
  "      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {",
  "        response.resume();",
  "        fail();",
  "        return;",
  "      }",
  '      response.setEncoding("utf8");',
  '      let responseBody = "";',
  '      response.on("data", (chunk) => {',
  "        responseBody += chunk;",
  "        if (Buffer.byteLength(responseBody) > 1024 * 1024) {",
  "          fail();",
  "          response.destroy();",
  "        }",
  "      });",
  '      response.once("error", fail);',
  '      response.once("end", () => {',
  "        if (!failed) process.stdout.write(responseBody);",
  "      });",
  "    },",
  "  );",
  '  request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));',
  '  request.once("error", fail);',
  "  request.end(requestBody);",
  "});",
].join("\n");

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

function validateProviderName(value, label) {
  if (!isValidProviderName(value)) throw new Error(`${label} is invalid`);
  return value;
}

function getHermesToolGatewayProviderName(sandboxName) {
  return validateProviderName(
    `${validateName(sandboxName, "sandbox name")}-hermes-tool-gateway`,
    "Hermes tool-gateway provider name",
  );
}

function getHermesInferenceProviderName(sandboxName) {
  return validateProviderName(
    `${validateName(sandboxName, "sandbox name")}-hermes-inference`,
    "Hermes inference provider name",
  );
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
    inference_provider_name: validateProviderName(
      inferenceProviderName,
      "Hermes inference provider name",
    ),
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

function brokerControlJsonRequest(route, payload, options = {}) {
  if (!fs.existsSync(HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH)) return null;
  if (!/^credentials\/(?:activate|discard|register|stage|status|unregister)$/u.test(route)) {
    return null;
  }
  const timeoutMs = options.timeoutMs ?? HERMES_CLONE_CONTROL_CLIENT_TIMEOUT_MS;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "--eval",
      HERMES_TOOL_GATEWAY_CONTROL_CLIENT_SOURCE,
      HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH,
      route,
      String(timeoutMs),
    ],
    {
      encoding: "utf8",
      input: JSON.stringify(payload),
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: timeoutMs + 1_000,
      windowsHide: true,
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

function brokerControlStatus(payload) {
  return brokerControlJsonRequest("credentials/status", payload, {
    timeoutMs: HERMES_CLONE_CONTROL_STATUS_TIMEOUT_MS,
  });
}

function brokerControlRequest(route, payload) {
  return brokerControlJsonRequest(route, payload) !== null;
}

function registerHermesToolGatewayRuntimeCredential(refreshToken, exactSandboxName = null) {
  const digest = hashRefreshToken(refreshToken);
  let matched = false;
  if (exactSandboxName === null) ensurePrivateDir(HERMES_TOOL_GATEWAY_STATE_DIR);
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

function removeHermesToolGatewayProviderState(sandboxName, deps = {}) {
  const sandbox = validateName(sandboxName, "sandbox name");
  const file = (deps.getStatePath ?? getHermesToolGatewayStatePath)(sandbox);
  const controlSocketExists =
    deps.controlSocketExists ?? (() => fs.existsSync(HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH));
  const unregister =
    deps.unregister ??
    (() =>
      brokerControlRequest("credentials/unregister", {
        sandbox,
      }));
  // The file is the durable retry identity for an in-memory credential. Keep
  // it intact until the live broker confirms unregister; otherwise a later
  // cleanup cannot prove which credential remains active.
  if (controlSocketExists() && !unregister()) return false;
  try {
    (deps.unlinkState ?? fs.unlinkSync)(file);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "ENOENT");
  }
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

function stageHermesToolGatewayCloneBinding(sandboxName, refreshToken, options = {}) {
  const sandbox = validateName(sandboxName, "sandbox name");
  const normalized = String(refreshToken || "").trim();
  const requestId = options.requestId || `nc_clone_${crypto.randomBytes(16).toString("hex")}`;
  if (!isValidControlRequestId(requestId)) {
    throw new Error("Hermes clone broker request identity is invalid");
  }
  if (!normalized) {
    throw new Error("Hermes tool gateway refresh credential is empty");
  }
  if (!ensureHermesToolGatewayBroker({ startWithoutCredential: true })) {
    throw new Error("Hermes managed-tool gateway broker could not start before destination change");
  }
  const payload = {
    sandbox,
    refresh_token: normalized,
    inference_provider_name: getHermesInferenceProviderName(sandbox),
    request_id: requestId,
    deadline_at_ms: newControlDeadline(),
  };
  const response =
    brokerControlJsonRequest("credentials/stage", payload) ??
    brokerControlStatus({ request_id: requestId });
  const activationToken =
    response && typeof response.activation_token === "string"
      ? response.activation_token.trim()
      : "";
  const brokerToken =
    response && typeof response.broker_token === "string" ? response.broker_token.trim() : "";
  if (!isValidActivationToken(activationToken) || !brokerToken.startsWith("nc_broker_")) {
    throw new Error("Hermes managed-tool gateway broker could not stage destination credentials");
  }
  return Object.freeze({ activationToken, brokerToken, requestId });
}

function activateHermesToolGatewayCloneBinding(
  sandboxName,
  refreshToken,
  stagedBinding,
  deps = {},
) {
  const sandbox = validateName(sandboxName, "sandbox name");
  const normalized = String(refreshToken || "").trim();
  const activationToken = String(stagedBinding?.activationToken || "").trim();
  const brokerToken = String(stagedBinding?.brokerToken || "").trim();
  if (!normalized || !isValidActivationToken(activationToken) || !brokerToken) {
    throw new Error("Hermes staged destination credential binding is incomplete");
  }
  const previousState = (deps.readState ?? readHermesToolGatewayProviderState)(sandbox);
  const previousStateSnapshot = previousState ? structuredClone(previousState) : null;
  const state = (deps.persistState ?? persistHermesToolGatewayProviderState)(
    sandbox,
    normalized,
    brokerToken,
    getHermesInferenceProviderName(sandbox),
  );
  const response = (deps.controlRequest ?? brokerControlJsonRequest)("credentials/activate", {
    sandbox,
    activation_token: activationToken,
    deadline_at_ms: newControlDeadline(),
  });
  const reconciled =
    response ?? (deps.controlStatus ?? brokerControlStatus)({ activation_token: activationToken });
  if (reconciled?.state === "activated") {
    return state;
  }
  if (reconciled?.state === "discarded" || reconciled?.state === "staged") {
    if (previousStateSnapshot) {
      (deps.writeState ?? atomicWriteJson)(state.file, previousStateSnapshot);
    } else if (!(deps.removeState ?? removeHermesToolGatewayProviderState)(sandbox)) {
      throw Object.assign(
        new Error("Hermes managed-tool gateway broker activation cleanup failed"),
        { code: "hermes_clone_activation_cleanup_failed" },
      );
    }
  } else {
    throw Object.assign(
      new Error("Hermes managed-tool gateway broker activation outcome is unknown"),
      { code: "hermes_clone_activation_outcome_unknown" },
    );
  }
  throw new Error("Hermes managed-tool gateway broker could not activate destination credentials");
}

function discardHermesToolGatewayCloneBinding(sandboxName, stagedBinding) {
  const activationToken = String(stagedBinding?.activationToken || "").trim();
  if (!activationToken) return true;
  const response = brokerControlJsonRequest("credentials/discard", {
    sandbox: validateName(sandboxName, "sandbox name"),
    activation_token: activationToken,
  });
  const reconciled = response ?? brokerControlStatus({ activation_token: activationToken });
  return reconciled?.state === "discarded" || reconciled?.state === "absent";
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
function preflightHermesToolGatewayCloneBinding(sandboxName, deps = {}) {
  validateName(sandboxName, "sandbox name");
  const requiredRuntimeFiles = [
    HERMES_TOOL_GATEWAY_SCRIPT,
    HERMES_TOOL_GATEWAY_MATRIX_PATH,
    HERMES_TOOL_GATEWAY_RUNTIME_CREDENTIALS_PATH,
    HERMES_TOOL_GATEWAY_CONTROL_CONTRACT_PATH,
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
  const { owned: currentBrokerOwned, healthy: currentBrokerHealthy } =
    verifyHermesToolGatewayBroker(pid, deps);
  if (currentBrokerHealthy && !currentBrokerOwned) {
    throw new Error(
      "Hermes managed-tool broker health endpoint is not owned by NemoClaw; " +
        `port ${HERMES_TOOL_GATEWAY_PORT} is held by another process. ` +
        HERMES_TOOL_GATEWAY_UNOWNED_LISTENER_RECOVERY,
    );
  }
  if (!currentBrokerOwned || !currentBrokerHealthy) {
    probeHermesToolGatewayBrokerStart();
    return;
  }
  if (readBrokerHash() !== brokerRuntimeHash()) {
    throw new Error(
      "Hermes managed-tool broker runtime changed while an existing broker is active; " +
        HERMES_TOOL_GATEWAY_RUNTIME_MISMATCH_RECOVERY,
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
        controlContract: HERMES_TOOL_GATEWAY_CONTROL_CONTRACT_PATH,
        controlContractSha256: brokerRuntimeFileHash(HERMES_TOOL_GATEWAY_CONTROL_CONTRACT_PATH),
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

function isHermesToolGatewayBrokerPortOwner(pid, deps = {}) {
  const isBrokerProcess = deps.isBrokerProcess ?? isHermesToolGatewayBrokerProcess;
  if (!isBrokerProcess(pid)) return false;
  const listener = (deps.runCaptureEx ?? runCaptureEx)([
    "lsof",
    "-ti",
    `:${HERMES_TOOL_GATEWAY_PORT}`,
    "-sTCP:LISTEN",
  ]);
  if (listener.exitCode === null && !listener.timedOut) {
    if (!reportedMissingListenerInspector) {
      (deps.reportError ?? console.error)(
        "NemoClaw cannot verify Hermes managed-tool broker port ownership because lsof is " +
          "unavailable. Install lsof, then retry.",
      );
      reportedMissingListenerInspector = true;
    }
    return false;
  }
  const listenerPids = listener.stdout
    .split(/\r?\n/u)
    .map((line) => Number.parseInt(line.trim(), 10));
  return listenerPids.includes(pid);
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

function verifyHermesToolGatewayBroker(pid, deps = {}) {
  const isPortOwner = deps.isPortOwner ?? isHermesToolGatewayBrokerPortOwner;
  const isHealthy = deps.isHealthy ?? isHermesToolGatewayBrokerHealthy;
  const ownedBeforeHealth = isPortOwner(pid);
  const healthy = isHealthy();
  // The unauthenticated health request can outlive the recorded broker. Require
  // the same process to own the listener after each successful health probe.
  const ownedAfterHealth = healthy && isPortOwner(pid);
  return {
    healthy,
    owned: ownedBeforeHealth && ownedAfterHealth,
  };
}

function killStaleHermesToolGatewayBroker() {
  const pid = readPid();
  if (isHermesToolGatewayBrokerPortOwner(pid)) {
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

function ensureHermesToolGatewayBroker(options = {}, deps = {}) {
  const refreshToken =
    typeof options.refreshToken === "string" && options.refreshToken.trim()
      ? options.refreshToken.trim()
      : "";
  const desiredHash = brokerRuntimeHash();
  const hashMatches = readBrokerHash() === desiredHash;
  const pid = readPid();
  const { owned: currentBrokerOwned, healthy: brokerHealthy } =
    verifyHermesToolGatewayBroker(pid, deps);
  const currentBrokerHealthy = currentBrokerOwned && brokerHealthy;
  // `/health` is unauthenticated on a fixed port, so reachability proves
  // liveness and never identity. Ownership comes only from a recorded pid that
  // still resolves to a running broker, re-proved on every call: a broker can
  // exit and leave the port free for another process to bind. Refuse before any
  // path can adopt, restart around, or stage credentials against a listener
  // NemoClaw cannot prove it owns.
  if (brokerHealthy && !currentBrokerOwned) {
    console.error(
      "Hermes managed-tool broker health endpoint is not owned by NemoClaw; " +
        `refusing to reuse the listener on port ${HERMES_TOOL_GATEWAY_PORT}. ` +
        HERMES_TOOL_GATEWAY_UNOWNED_LISTENER_RECOVERY,
    );
    return false;
  }
  if (options.startWithoutCredential) {
    if (currentBrokerHealthy) {
      return hashMatches && fs.existsSync(HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH);
    }
    killStaleHermesToolGatewayBroker();
    const nextPid = spawnHermesToolGatewayBroker("");
    for (let attempt = 0; attempt < 20; attempt++) {
      const nextBroker = verifyHermesToolGatewayBroker(nextPid, deps);
      if (
        nextBroker.owned &&
        nextBroker.healthy &&
        fs.existsSync(HERMES_TOOL_GATEWAY_CONTROL_SOCKET_PATH)
      ) {
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
        HERMES_TOOL_GATEWAY_RUNTIME_MISMATCH_RECOVERY,
    );
    return false;
  }
  if (refreshPlan === "register-with-current") {
    const registered = registerHermesToolGatewayRuntimeCredential(
      refreshToken,
      options.sandboxName ?? null,
    );
    return registered;
  }
  if (refreshPlan === "start-or-restart") {
    killStaleHermesToolGatewayBroker();
    const nextPid = spawnHermesToolGatewayBroker(refreshToken, options.sandboxName ?? null);
    for (let attempt = 0; attempt < 20; attempt++) {
      const nextBroker = verifyHermesToolGatewayBroker(nextPid, deps);
      if (
        nextBroker.owned &&
        nextBroker.healthy &&
        registerHermesToolGatewayRuntimeCredential(refreshToken, options.sandboxName ?? null)
      ) {
        return true;
      }
      sleep(250);
    }
    return false;
  }

  // `currentBrokerHealthy` already requires ownership, covering both proofs the
  // three former branches tested separately, so reuse is one condition.
  if (!options.forceRestart && hashMatches && currentBrokerHealthy) {
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

function matchesHermesToolGatewayProviderIdentity(entry, state) {
  if (entry?.agent !== "hermes" || !state || typeof state !== "object") {
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

function matchesHermesToolGatewayProviderState(entry, state) {
  return (
    isHermesManagedToolGatewayEntry(entry) && matchesHermesToolGatewayProviderIdentity(entry, state)
  );
}

function removeHermesToolGatewayProviderStateForSandboxEntry(entry, deps = {}) {
  if (entry?.agent !== "hermes") return false;
  const sandbox = validateName(entry.name, "sandbox name");
  const isolatedProvider =
    typeof entry.hermesInferenceProvider === "string" ? entry.hermesInferenceProvider.trim() : "";
  if (isolatedProvider && isolatedProvider !== getHermesInferenceProviderName(sandbox)) {
    return false;
  }
  const statePath = (deps.getStatePath ?? getHermesToolGatewayStatePath)(sandbox);
  if (!(deps.stateExists ?? fs.existsSync)(statePath)) return true;
  const state = (deps.readState ?? readHermesToolGatewayProviderState)(sandbox);
  if (!matchesHermesToolGatewayProviderIdentity(entry, state)) return false;
  return (deps.removeState ?? removeHermesToolGatewayProviderState)(sandbox);
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
  registerHermesToolGatewayRuntimeCredential,
  registerHermesToolGatewayRefreshProvider,
  probeHermesToolGatewayBrokerStart,
  preflightHermesToolGatewayCloneBinding,
  stageHermesToolGatewayCloneBinding,
  activateHermesToolGatewayCloneBinding,
  discardHermesToolGatewayCloneBinding,
  bindHermesToolGatewayCloneProviderState,
  planHermesToolGatewayBrokerRefresh,
  brokerRuntimeHash,
  isHermesToolGatewayBrokerPortOwner,
  isHermesToolGatewayBrokerHealthy,
  killStaleHermesToolGatewayBroker,
  ensureHermesToolGatewayBroker,
  isHermesManagedToolGatewayEntry,
  matchesHermesToolGatewayProviderIdentity,
  matchesHermesToolGatewayProviderState,
  removeHermesToolGatewayProviderStateForSandboxEntry,
  ensureHermesToolGatewayBrokerForSandboxEntry,
};
