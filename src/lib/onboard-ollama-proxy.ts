// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Ollama auth-proxy lifecycle: token persistence, PID management,
// proxy start/stop, model pull and validation.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const { ROOT, SCRIPTS, run, runCapture, shellQuote } = require("./runner");
const { OLLAMA_PORT, OLLAMA_PROXY_PORT } = require("./ports");
const {
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  getResolvedOllamaHost,
  OLLAMA_HOST_DOCKER_INTERNAL,
  validateOllamaModel,
} = require("./local-inference");
const { buildSubprocessEnv } = require("./subprocess-env");
const { prompt } = require("./credentials");
const { promptManualModelId } = require("./model-prompts");

// ── State ────────────────────────────────────────────────────────

const PROXY_STATE_DIR = path.join(os.homedir(), ".nemoclaw");
const PROXY_TOKEN_PATH = path.join(PROXY_STATE_DIR, "ollama-proxy-token");
const PROXY_PID_PATH = path.join(PROXY_STATE_DIR, "ollama-auth-proxy.pid");

let ollamaProxyToken: string | null = null;

function sleep(seconds) {
  spawnSync("sleep", [String(seconds)]);
}

// ── Proxy state dir ──────────────────────────────────────────────

function ensureProxyStateDir(): void {
  if (!fs.existsSync(PROXY_STATE_DIR)) {
    fs.mkdirSync(PROXY_STATE_DIR, { recursive: true });
  }
}

// ── Token persistence ────────────────────────────────────────────

function persistProxyToken(token: string): void {
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_TOKEN_PATH, token, { mode: 0o600 });
  // mode only applies on creation; ensure permissions on existing files too
  fs.chmodSync(PROXY_TOKEN_PATH, 0o600);
}

function loadPersistedProxyToken(): string | null {
  try {
    if (fs.existsSync(PROXY_TOKEN_PATH)) {
      const token = fs.readFileSync(PROXY_TOKEN_PATH, "utf-8").trim();
      return token || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ── PID persistence ──────────────────────────────────────────────

function persistProxyPid(pid: number | null | undefined): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_PID_PATH, `${pid}\n`, { mode: 0o600 });
  fs.chmodSync(PROXY_PID_PATH, 0o600);
}

function loadPersistedProxyPid(): number | null {
  try {
    if (!fs.existsSync(PROXY_PID_PATH)) return null;
    const raw = fs.readFileSync(PROXY_PID_PATH, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearPersistedProxyPid(): void {
  try {
    if (fs.existsSync(PROXY_PID_PATH)) {
      fs.unlinkSync(PROXY_PID_PATH);
    }
  } catch {
    /* ignore */
  }
}

// ── Process management ───────────────────────────────────────────

function isOllamaProxyProcess(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const cmdline = runCapture(["ps", "-p", String(pid), "-o", "args="], { ignoreError: true });
  return Boolean(cmdline && cmdline.includes("ollama-auth-proxy.js"));
}

function spawnOllamaAuthProxy(token: string): number | null {
  const child = spawn(process.execPath, [path.join(SCRIPTS, "ollama-auth-proxy.js")], {
    detached: true,
    stdio: "ignore",
    env: buildSubprocessEnv({
      OLLAMA_PROXY_TOKEN: token,
      OLLAMA_PROXY_PORT: String(OLLAMA_PROXY_PORT),
      OLLAMA_BACKEND_PORT: String(OLLAMA_PORT),
    }),
  });
  child.unref();
  persistProxyPid(child.pid);
  return child.pid ?? null;
}

function killStaleProxy(): void {
  try {
    const persistedPid = loadPersistedProxyPid();
    if (isOllamaProxyProcess(persistedPid)) {
      run(["kill", String(persistedPid)], { ignoreError: true, suppressOutput: true });
    }
    clearPersistedProxyPid();

    // Best-effort cleanup for older proxy processes created before the PID file
    // existed. Only kill processes that are actually the auth proxy, not
    // unrelated services that happen to use the same port.
    const pidOutput = runCapture(["lsof", "-ti", `:${OLLAMA_PROXY_PORT}`], { ignoreError: true });
    if (pidOutput && pidOutput.trim()) {
      for (const pid of pidOutput.trim().split(/\s+/)) {
        if (isOllamaProxyProcess(Number.parseInt(pid, 10))) {
          run(["kill", pid], { ignoreError: true, suppressOutput: true });
        }
      }
      sleep(1);
    }
  } catch {
    /* ignore */
  }
}

// ── Public API ───────────────────────────────────────────────────

function startOllamaAuthProxy(): boolean {
  const crypto = require("crypto");
  killStaleProxy();

  const proxyToken = crypto.randomBytes(24).toString("hex");
  ollamaProxyToken = proxyToken;
  // Don't persist yet — wait until provider is confirmed in setupInference.
  // If the user backs out to a different provider, the token stays in memory
  // only and is discarded.
  const pid = spawnOllamaAuthProxy(proxyToken);
  sleep(1);
  if (!isOllamaProxyProcess(pid)) {
    console.error(`  Error: Ollama auth proxy failed to start on :${OLLAMA_PROXY_PORT}`);
    console.error(`  Containers will not be able to reach Ollama without the proxy.`);
    console.error(
      `  Check if port ${OLLAMA_PROXY_PORT} is already in use: lsof -ti :${OLLAMA_PROXY_PORT}`,
    );
    return false;
  }
  return true;
}

/**
 * Probe the running proxy to confirm it accepts the given token.
 * The proxy validates auth before forwarding to Ollama. A backend error like
 * 502 still proves the token was accepted, while 401 means token mismatch.
 */
function probeProxyToken(token: string): "accepted" | "rejected" | "unreachable" {
  const result = spawnSync(
    "curl",
    [
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "3",
      "-H",
      `Authorization: Bearer ${token}`,
      `http://localhost:${OLLAMA_PROXY_PORT}/v1/models`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return "unreachable";

  const status = String(result.stdout || "").trim();
  if (status === "401") return "rejected";
  if (/^\d{3}$/.test(status)) return "accepted";
  return "unreachable";
}

/**
 * Ensure the auth proxy is running with the correct persisted token.
 * Called on sandbox connect to recover from host reboots where the
 * background proxy process was lost, and to detect token divergence
 * after a failed re-onboard (see issue #2553).
 */
function ensureOllamaAuthProxy(): void {
  // Try to load persisted token first — if none, this isn't an Ollama setup.
  const token = loadPersistedProxyToken();
  if (!token) return;

  const pid = loadPersistedProxyPid();
  if (isOllamaProxyProcess(pid)) {
    const tokenStatus = probeProxyToken(token);
    if (tokenStatus === "accepted") {
      ollamaProxyToken = token;
      return;
    }
  }
  killStaleProxy();

  // Proxy not running, token mismatch, or PID stale — restart with the persisted token.
  ollamaProxyToken = token;
  const startedPid = spawnOllamaAuthProxy(token);
  for (let attempt = 0; attempt < 10; attempt++) {
    if (isOllamaProxyProcess(startedPid) && probeProxyToken(token) === "accepted") return;
    sleep(1);
  }
  console.error(`  Error: Ollama auth proxy did not become ready after restart.`);
}

/** Return the current proxy token, falling back to the persisted file. */
function getOllamaProxyToken(): string | null {
  if (ollamaProxyToken) return ollamaProxyToken;
  // Fall back to persisted token (resume / reconnect scenario)
  ollamaProxyToken = loadPersistedProxyToken();
  return ollamaProxyToken;
}

/**
 * Check whether the Ollama auth proxy is actually healthy — not just that
 * the PID exists, but that the proxy endpoint responds to HTTP requests.
 *
 * This is the correct check for the setupInference fallback: if the
 * container reachability test fails (Docker bridge issue) but the proxy
 * is confirmed healthy on the host, onboarding can safely continue.
 */
function isProxyHealthy(): boolean {
  // 1. PID check — informational, but don't early-return on failure.
  //    The proxy may have been restarted with a new PID that isn't in our
  //    PID file, so the HTTP probe is the authoritative signal.
  const pid = loadPersistedProxyPid();
  const hasValidPid = isOllamaProxyProcess(pid);

  // 2. HTTP probe — confirm the proxy actually responds. This is the
  //    authoritative check: a successful probe wins even if the PID file
  //    is missing or stale (e.g., after a manual restart).
  const proxyUrl = `http://127.0.0.1:${OLLAMA_PROXY_PORT}/api/tags`;
  const token = loadPersistedProxyToken();
  const probeCmd = token
    ? ["curl", "-sf", "--connect-timeout", "3", "--max-time", "5",
       "-H", `Authorization: Bearer ${token}`, proxyUrl]
    : ["curl", "-sf", "--connect-timeout", "3", "--max-time", "5", proxyUrl];

  const output = runCapture(probeCmd, { ignoreError: true });
  if (output) return true;

  // HTTP probe failed — fall back to PID as a weaker signal.
  // This covers edge cases where the probe transiently fails but the
  // process is confirmed alive.
  return hasValidPid;
}

async function promptOllamaModel(gpu = null) {
  const installed = getOllamaModelOptions();
  const options = installed.length > 0 ? installed : getBootstrapOllamaModelOptions(gpu);
  const defaultModel = getDefaultOllamaModel(gpu);
  const defaultIndex = Math.max(0, options.indexOf(defaultModel));

  console.log("");
  console.log(installed.length > 0 ? "  Ollama models:" : "  Ollama starter models:");
  options.forEach((option, index) => {
    console.log(`    ${index + 1}) ${option}`);
  });
  console.log(`    ${options.length + 1}) Other...`);
  if (installed.length === 0) {
    console.log("");
    console.log("  No local Ollama models are installed yet. Choose one to pull and load now.");
  }
  console.log("");

  const choice = await prompt(`  Choose model [${defaultIndex + 1}]: `);
  const index = parseInt(choice || String(defaultIndex + 1), 10) - 1;
  if (index >= 0 && index < options.length) {
    return options[index];
  }
  return promptManualModelId("  Ollama model id: ", "Ollama");
}

function printOllamaExposureWarning() {
  console.log("");
  console.log("  ⚠ Ollama is binding to 0.0.0.0 so the sandbox can reach it via Docker.");
  console.log("    This exposes the Ollama API to your local network (no auth required).");
  console.log("    On public WiFi, any device on the same network can send prompts to your GPU.");
  console.log("    See: CNVD-2025-04094, CVE-2024-37032");
  console.log("");
}

function pullOllamaModelViaCli(model) {
  const result = spawnSync("bash", ["-c", `ollama pull ${shellQuote(model)}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 600_000,
    env: buildSubprocessEnv(),
  });
  if (result.signal === "SIGTERM") {
    console.error(
      `  Model pull timed out after 10 minutes. Try a smaller model or check your network connection.`,
    );
    return false;
  }
  return result.status === 0;
}

// Pull via Ollama's HTTP API instead of shelling out to the `ollama` CLI.
// Used only when the resolved host is the Windows host (host.docker.internal),
// where there is no `ollama` binary in WSL to shell out to. Native Linux/macOS
// keeps the CLI path so existing behavior is unchanged.
function pullOllamaModelViaHttp(model) {
  return new Promise((resolve) => {
    const host = getResolvedOllamaHost();
    const url = `http://${host}:${OLLAMA_PORT}/api/pull`;
    const body = JSON.stringify({ model, stream: true });
    const TIMEOUT_MS = 600_000; // 10 min, matches the CLI path
    const isTTY = Boolean(process.stdout.isTTY);
    const BAR_WIDTH = 40;

    const proc = spawn(
      "curl",
      [
        "-sN",
        "--connect-timeout",
        "10",
        "--max-time",
        String(Math.floor(TIMEOUT_MS / 1000)),
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-d",
        body,
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const readline = require("readline");
    const rl = readline.createInterface({ input: proc.stdout });
    let currentStatus = "";
    let progressActive = false;
    let lastNonTtyLine = "";
    let sawSuccess = false;
    let sawError = false;

    const formatSize = (bytes) => {
      if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
      if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
      if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
      return `${bytes} B`;
    };

    const renderBar = (pct) => {
      const filled = Math.floor((pct / 100) * BAR_WIDTH);
      return `${"█".repeat(filled)}${" ".repeat(BAR_WIDTH - filled)}`;
    };

    const finishLine = () => {
      if (isTTY && progressActive) {
        process.stdout.write("\n");
        progressActive = false;
      }
    };

    rl.on("line", (line) => {
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof evt?.error === "string" && evt.error.trim()) {
        finishLine();
        console.error(`  Error: ${evt.error.trim()}`);
        sawError = true;
        return;
      }
      const status = typeof evt?.status === "string" ? evt.status : "";
      if (!status) return;
      if (status === "success") sawSuccess = true;

      const hasProgress =
        typeof evt.completed === "number" && typeof evt.total === "number" && evt.total > 0;

      // Status changed (new layer or new phase): commit the previous line
      // and either render the new status as a plain line (no progress) or
      // fall through to the in-place progress renderer.
      if (status !== currentStatus) {
        finishLine();
        currentStatus = status;
        if (!hasProgress) {
          console.log(`  ${status}`);
          return;
        }
      } else if (!hasProgress) {
        return;
      }

      const pct = Math.floor((evt.completed / evt.total) * 100);
      if (isTTY) {
        const bar = renderBar(pct);
        const sz = `${formatSize(evt.completed)} / ${formatSize(evt.total)}`;
        process.stdout.write(`\r  ${status}: ${pct}% ${bar} ${sz}`);
        progressActive = true;
      } else {
        // Non-TTY (CI, logs): throttle to one line per percent change.
        const summary = `  ${status}: ${pct}%`;
        if (summary !== lastNonTtyLine) {
          console.log(summary);
          lastNonTtyLine = summary;
        }
      }
    });

    proc.on("error", (err) => {
      finishLine();
      console.error(`  Pull failed to start: ${err.message}`);
      resolve(false);
    });

    // Use 'close' rather than 'exit' so the promise resolves only after the
    // child's stdio streams are fully drained, ensuring readline has emitted
    // the final 'line' event for the trailing `success` JSON.
    proc.on("close", (code) => {
      finishLine();
      if (sawError) {
        resolve(false);
        return;
      }
      if (code !== 0) {
        // curl exit 28 = CURLE_OPERATION_TIMEDOUT (--max-time hit).
        if (code === 28) {
          console.error(`  Model pull timed out after ${TIMEOUT_MS / 60_000} minutes.`);
        } else {
          console.error(`  Model pull exited with code ${String(code)} (network error).`);
        }
        console.error("  Already-downloaded layers are kept; re-running the pull resumes them.");
        resolve(false);
        return;
      }
      resolve(sawSuccess);
    });
  });
}

// Dispatch to HTTP pull when Ollama was resolved on the Windows host.
async function pullOllamaModel(model) {
  if (getResolvedOllamaHost() === OLLAMA_HOST_DOCKER_INTERNAL) {
    return pullOllamaModelViaHttp(model);
  }
  return pullOllamaModelViaCli(model);
}

async function prepareOllamaModel(model, installedModels = []) {
  const alreadyInstalled = installedModels.includes(model);
  if (!alreadyInstalled) {
    console.log(`  Pulling Ollama model: ${model}`);
    if (!(await pullOllamaModel(model))) {
      return {
        ok: false,
        message:
          `Failed to pull Ollama model '${model}'. ` +
          "Check the model name and that Ollama can access the registry, then try another model.",
      };
    }
  }

  console.log(`  Loading Ollama model: ${model}`);
  run(getOllamaWarmupCommand(model), { ignoreError: true });
  return validateOllamaModel(model);
}

/**
 * Unload all running Ollama models from GPU memory.
 * Best-effort operation: silently ignores errors if Ollama is not running.
 */
function unloadOllamaModels() {
  try {
    const req = http.get(
      {
        hostname: "localhost",
        port: OLLAMA_PORT,
        path: "/api/ps",
        timeout: 3000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return;
          try {
            const parsed = JSON.parse(data);
            const models = parsed.models || [];
            for (const entry of models) {
              if (!entry.name) continue;
              const unloadReq = http.request(
                {
                  hostname: "localhost",
                  port: OLLAMA_PORT,
                  path: "/api/generate",
                  method: "POST",
                  timeout: 3000,
                  headers: { "Content-Type": "application/json" },
                },
                () => {
                  /* ignore response */
                },
              );
              unloadReq.on("error", () => {
                /* best-effort */
              });
              unloadReq.write(JSON.stringify({ model: entry.name, keep_alive: 0 }));
              unloadReq.end();
            }
          } catch {
            /* best-effort */
          }
        });
      },
    );
    req.on("error", () => {
      /* best-effort */
    });
  } catch {
    /* best-effort */
  }
}

export {
  ensureOllamaAuthProxy,
  getOllamaProxyToken,
  isProxyHealthy,
  killStaleProxy,
  persistProxyToken,
  startOllamaAuthProxy,
  promptOllamaModel,
  printOllamaExposureWarning,
  pullOllamaModel,
  prepareOllamaModel,
  unloadOllamaModels,
};
