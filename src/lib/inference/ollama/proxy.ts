// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Ollama auth-proxy lifecycle: token persistence, PID management,
// proxy start/stop, model pull and validation.
//
// @ts-nocheck is pre-existing. Removing it surfaces ~14 implicit-any
// parameter errors scattered through the 992-line file (sleep, model, err,
// code, bytes, pct, line, tag, ...). Typing each callback is a separate
// refactor tracked as a follow-up on #6014. This PR only touches the
// status-file IPC seam and the spawn env; it does not extend the
// @ts-nocheck-suppressed area with new implicit-any surface.

import type { GpuInfo } from "../local";
import type { PulledModelDiscoveryDeps } from "./model-discovery";
import type { ProxyBackendKind } from "./proxy-status";

const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ROOT, SCRIPTS, redact, run, runCapture, shellQuote } = require("../../runner");
const {
  redirectInheritedChildStdoutToStderr,
}: typeof import("../../cli/stdout-guard") = require("../../cli/stdout-guard");
const { OLLAMA_PORT, OLLAMA_PROXY_PORT } = require("../../core/ports");
const { isNonInteractiveEnv }: typeof import("../../core/non-interactive") =
  require("../../core/non-interactive");
const { sleepMs, waitForPort } = require("../../core/wait");
const { ensurePulledOllamaModel }: typeof import("./model-discovery") =
  require("./model-discovery");
const { ollamaModelRefsMatch }: typeof import("./model-discovery") = require("./model-discovery");
const {
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  getResolvedOllamaHost,
  OLLAMA_HOST_DOCKER_INTERNAL,
  probeOllamaModelCapabilities,
  validateOllamaModel,
} = require("../local");
const {
  anyRegistryModelFits,
  describeOllamaModelCapacity,
  effectiveGpuMemoryMB,
  modelFitsAvailableMemory,
} = require("../ollama-model-registry");
const { formatBytes } = require("./model-size");
const { isOllamaAuthProxyCommandLine }: typeof import("./process") = require("./process");
const { buildSubprocessEnv } = require("../../subprocess-env");
const { prompt } = require("../../credentials/store");
const { promptManualModelId } = require("../model-prompts");
const { listGatewayStateRoots } = require("../../state/gateway-registry");
const {
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} = require("../../state/mcp-lifecycle-lock");
const { openRegularFileNoFollow } = require("../../adapters/fs/regular-file");
const {
  formatOllamaProxyUnreachableMessage,
  probeOllamaProxySandboxReachability,
} = require("../../onboard/ollama-proxy-reachability");
const {
  isLocalAdapterProcess,
  killLocalAdapterPid,
  loadLocalAdapterPid,
  persistLocalAdapterPid,
  removeLocalAdapterFile,
  SHARED_LOCAL_ADAPTER_STATE_DIR,
  spawnDetachedNodeAdapter,
  writeLocalAdapterJsonFile,
  writeLocalAdapterSecretFile,
} = require("../local-adapter-lifecycle");
const {
  clearStaleProxyStatus,
  defaultProxyStatusPath,
  printProxyStartupReason,
  PROXY_STATUS_ENV,
  readProxyExitStatus,
} = require("./proxy-status");

// ── State ────────────────────────────────────────────────────────

const PROXY_STATE_DIR = SHARED_LOCAL_ADAPTER_STATE_DIR;
const PROXY_TOKEN_PATH = path.join(PROXY_STATE_DIR, "ollama-proxy-token");
const PROXY_BACKEND_PATH = path.join(PROXY_STATE_DIR, "ollama-backend");
const PROXY_BACKEND_DESCRIPTOR_PATH = path.join(PROXY_STATE_DIR, "ollama-backend.json");
const PROXY_PORT_PATH = path.join(PROXY_STATE_DIR, "ollama-proxy-port");
const PROXY_PID_PATH = path.join(PROXY_STATE_DIR, "ollama-auth-proxy.pid");
const PROXY_STATUS_PATH = defaultProxyStatusPath(PROXY_STATE_DIR);
const OLLAMA_PROXY_LIFECYCLE_LOCK = "host-global-ollama-auth-proxy";
const OLLAMA_MODEL_OWNERSHIP_LOCK = "host-global-ollama-model-ownership";
const MAX_PROXY_STATE_FILE_BYTES = 64 * 1024;

type StoredProxyBackendKind = Exclude<ProxyBackendKind, "unknown">;
type ProxyBackendDescriptor = {
  readonly schemaVersion: 1;
  readonly kind: StoredProxyBackendKind;
  readonly url: string;
};
type ProxyBackendIdentity = {
  readonly kind: ProxyBackendKind;
  readonly url: string | null;
};

let ollamaProxyToken: string | null = null;

function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

// ── Token persistence ────────────────────────────────────────────

function withOllamaProxyLifecycleLock<T>(operation: () => T): T {
  // The shared state/ directory is the repository's recognized home for
  // host-global lifecycle locks. An empty lock directory does not masquerade
  // as a default-port gateway during scoped uninstall discovery.
  return withMcpLifecycleLockSync(OLLAMA_PROXY_LIFECYCLE_LOCK, operation, {
    stateDir: path.join(PROXY_STATE_DIR, "state"),
  });
}

/** Serialize model-holder checks and GPU release across sandbox commands. */
function withOllamaModelOwnershipLock<T>(operation: () => T): T {
  return withMcpLifecycleLockSync(OLLAMA_MODEL_OWNERSHIP_LOCK, operation);
}

function withOllamaProxyLifecycleTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
  // Async setup steps can call the synchronous helpers below while retaining
  // this lock through the shared re-entrant lifecycle-lock context.
  return withMcpLifecycleLock(OLLAMA_PROXY_LIFECYCLE_LOCK, operation, {
    stateDir: path.join(PROXY_STATE_DIR, "state"),
  });
}

function persistProxyTokenUnlocked(
  token: string,
  backendUrl = `http://127.0.0.1:${OLLAMA_PORT}`,
  backendKind: StoredProxyBackendKind | null = "ollama",
): void {
  writeLocalAdapterSecretFile(PROXY_BACKEND_PATH, backendUrl);
  if (backendKind === null) {
    removeLocalAdapterFile(PROXY_BACKEND_DESCRIPTOR_PATH);
  } else {
    writeLocalAdapterJsonFile(PROXY_BACKEND_DESCRIPTOR_PATH, {
      schemaVersion: 1,
      kind: backendKind,
      url: backendUrl,
    } satisfies ProxyBackendDescriptor);
  }
  writeLocalAdapterSecretFile(PROXY_TOKEN_PATH, token);
}

function persistProxyToken(
  token: string,
  backendUrl = `http://127.0.0.1:${OLLAMA_PORT}`,
  backendKind: StoredProxyBackendKind = "ollama",
): void {
  withOllamaProxyLifecycleLock(() => persistProxyTokenUnlocked(token, backendUrl, backendKind));
}

function readProxyStateFile(filePath: string): string | null {
  let opened;
  try {
    opened = openRegularFileNoFollow(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot safely read Ollama auth proxy state at ${filePath}`, { cause: error });
  }
  try {
    return opened.readBytes(MAX_PROXY_STATE_FILE_BYTES).toString("utf8").trim() || null;
  } finally {
    opened.close();
  }
}

function parseProxyBackendDescriptor(raw: string | null): ProxyBackendDescriptor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed?.schemaVersion !== 1 ||
      (parsed.kind !== "ollama" && parsed.kind !== "compatible-endpoint") ||
      typeof parsed.url !== "string" ||
      parsed.url.trim().length === 0
    ) {
      return null;
    }
    return { schemaVersion: 1, kind: parsed.kind, url: parsed.url };
  } catch {
    return null;
  }
}

function readProxyBackendIdentity(root = PROXY_STATE_DIR): ProxyBackendIdentity {
  const url = readProxyStateFile(path.join(root, "ollama-backend"));
  const descriptor = parseProxyBackendDescriptor(
    readProxyStateFile(path.join(root, "ollama-backend.json")),
  );
  return descriptor?.url === url ? { kind: descriptor.kind, url } : { kind: "unknown", url };
}

function commonKnownBackendKind(
  backends: readonly ProxyBackendIdentity[],
): StoredProxyBackendKind | null {
  const kinds = backends.map(({ kind }) => kind);
  if (kinds.length === 0 || kinds.includes("unknown")) return null;
  const uniqueKinds = [...new Set(kinds)];
  return uniqueKinds.length === 1 ? (uniqueKinds[0] as StoredProxyBackendKind) : null;
}

function persistOrValidateProxyPortUnlocked(): boolean {
  const requestedPort = String(OLLAMA_PROXY_PORT);
  const persistedPort = readProxyStateFile(PROXY_PORT_PATH);
  if (!persistedPort) {
    writeLocalAdapterSecretFile(PROXY_PORT_PATH, requestedPort);
    return true;
  }
  if (persistedPort === requestedPort) return false;

  throw new Error(
    `The shared Ollama auth proxy already uses port ${persistedPort}, but this command requested port ${requestedPort}. ` +
      `Export NEMOCLAW_OLLAMA_PROXY_PORT=${persistedPort} for every gateway port on this host and retry.`,
  );
}

// Persist the proxy token then probe sandbox → proxy reachability. Runs
// before `inference set` so isInferenceRouteReady() stays false on failure
// and a retry (including --resume) re-enters setupInference and re-probes.
// A tcp_failed result prints the UFW remediation and exits 1; probe_unavailable
// (Docker Desktop, DNS, missing network) is non-fatal.
async function persistAndProbeOllamaProxy(token: string): Promise<void> {
  persistProxyToken(token);
  const reach = await probeOllamaProxySandboxReachability();
  if (!reach.ok && reach.reason === "tcp_failed") {
    console.error(formatOllamaProxyUnreachableMessage(reach));
    process.exit(1);
  }
}

function loadPersistedProxyToken(): string | null {
  return withOllamaProxyLifecycleLock(
    () => readProxyStateFile(PROXY_TOKEN_PATH) ?? adoptGatewayScopedProxyToken(),
  );
}

function adoptGatewayScopedProxyToken(): string | null {
  const candidates = listGatewayStateRoots(path.dirname(PROXY_STATE_DIR))
    .filter(({ root }) => root !== PROXY_STATE_DIR)
    .flatMap(({ root }) => {
      const token = readProxyStateFile(path.join(root, "ollama-proxy-token"));
      if (!token) return [];
      return [
        {
          backend: readProxyBackendIdentity(root),
          token,
          tokenPath: path.join(root, "ollama-proxy-token"),
        },
      ];
    });
  if (candidates.length === 0) return null;

  const tokens = [...new Set(candidates.map(({ token }) => token))];
  let selectedToken: string;
  if (tokens.length === 1) {
    [selectedToken] = tokens;
  } else {
    const accepted = tokens.filter((token) => probeProxyToken(token) === "accepted");
    if (accepted.length !== 1) {
      const tokenPaths = candidates.map(({ tokenPath }) => tokenPath).join(", ");
      throw new Error(
        "Conflicting legacy Ollama proxy tokens exist across gateway state roots. " +
          "NemoClaw cannot safely select one while preserving existing sandbox access. " +
          `After confirming which token serves the active sandboxes, reconcile or remove the stale files and retry: ${tokenPaths}`,
      );
    }
    [selectedToken] = accepted;
  }

  const selectedCandidates = candidates.filter(({ token }) => token === selectedToken);
  const backendUrls = [
    ...new Set(selectedCandidates.map(({ backend }) => backend.url).filter(Boolean)),
  ];
  if (backendUrls.length > 1) {
    throw new Error(
      "Conflicting legacy Ollama backend URLs exist for the shared proxy token. " +
        "NemoClaw cannot safely select one.",
    );
  }
  const sharedBackend = readProxyBackendIdentity();
  const selectedBackendUrl =
    backendUrls[0] ?? sharedBackend.url ?? `http://127.0.0.1:${OLLAMA_PORT}`;
  const selectedBackends =
    backendUrls.length > 0 ? selectedCandidates.map(({ backend }) => backend) : [sharedBackend];
  persistProxyTokenUnlocked(
    selectedToken,
    selectedBackendUrl,
    commonKnownBackendKind(selectedBackends),
  );
  return selectedToken;
}

function curlAuthHeaderConfig(token: string): string {
  const escaped = String(token)
    .replace(/[\r\n]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `header = "Authorization: Bearer ${escaped}"\n`;
}

function runCurlWithAuthConfig(args: string[], endpoint: string, token: string | null = null) {
  const curlArgs = [...args];
  const options: {
    cwd: string;
    encoding: "utf8";
    env: Record<string, string>;
    input?: string;
  } = {
    cwd: ROOT,
    encoding: "utf8",
    env: buildSubprocessEnv(),
  };
  if (token) {
    curlArgs.push("--config", "-");
    options.input = curlAuthHeaderConfig(token);
  }
  curlArgs.push(endpoint);

  // The only dynamic value is a 0600 local auth token for a fixed loopback proxy endpoint.
  // codeql[js/request-forgery]
  return spawnSync("curl", curlArgs, options);
}

function runCurlCaptureWithAuthConfig(
  args: string[],
  endpoint: string,
  token: string | null = null,
): string {
  const result = runCurlWithAuthConfig(args, endpoint, token);
  return result.status === 0 ? String(result.stdout || "") : "";
}

// ── PID persistence ──────────────────────────────────────────────

function persistProxyPid(pid: number | null | undefined): void {
  persistLocalAdapterPid(PROXY_PID_PATH, pid);
}

function loadPersistedProxyPid(): number | null {
  return loadLocalAdapterPid(PROXY_PID_PATH);
}

// ── Process management ───────────────────────────────────────────

function isOllamaProxyProcess(pid: number | null | undefined): boolean {
  return isLocalAdapterProcess(pid, isOllamaAuthProxyCommandLine, runCapture);
}

function spawnOllamaAuthProxy(token: string, backendUrl?: string): number | null {
  // Clear any stale status file so a read after this spawn observes the new
  // proxy's exit reason (or finds no file when the proxy starts cleanly).
  clearStaleProxyStatus(PROXY_STATUS_PATH);
  const url = backendUrl || readProxyStateFile(PROXY_BACKEND_PATH);
  const child = spawnDetachedNodeAdapter({
    scriptPath: path.join(SCRIPTS, "ollama-auth-proxy.mts"),
    env: {
      OLLAMA_PROXY_TOKEN: token,
      OLLAMA_PROXY_PORT: String(OLLAMA_PROXY_PORT),
      OLLAMA_BACKEND_PORT: String(OLLAMA_PORT),
      [PROXY_STATUS_ENV]: PROXY_STATUS_PATH,
      ...(url ? { OLLAMA_BACKEND_URL: url } : {}),
    },
    buildEnv: buildSubprocessEnv,
  });
  persistProxyPid(child.pid);
  return child.pid ?? null;
}

function killStaleProxy(): void {
  try {
    killLocalAdapterPid({
      pidPath: PROXY_PID_PATH,
      processMatcher: isOllamaAuthProxyCommandLine,
      run,
      runCapture,
    });

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

// ── Port-conflict diagnostics ────────────────────────────────────

// Inspect what currently listens on the proxy port, excluding our own
// auth-proxy processes. Returns the owning PIDs and a human-readable
// description (command line) for each so a port conflict can be reported
// with the exact owning process instead of telling the user to run lsof
// themselves (issue #4820).
//
// `family` scopes the lookup:
//   "4"   — IPv4 listeners only. The proxy binds IPv4 (0.0.0.0), so only an
//           IPv4 (or IPv6 dual-stack-wildcard) listener can actually block it.
//           An IPv6-only listener (e.g. ::1 with IPV6_V6ONLY) does NOT conflict,
//           so the pre-start abort uses this scope to avoid a false conflict.
//   "any" — all TCP listeners. Used only to diagnose an already-failed bind,
//           where the proxy died from EADDRINUSE: the culprit may be an IPv6
//           dual-stack wildcard (`:::PORT`) that blocks IPv4 yet lsof reports
//           as IPv6, so the broad scope still names the owner.
// Either way we restrict to TCP listeners (not outbound connections / UDP that
// merely involve the port number).
function inspectForeignProxyPortOwners(family: "4" | "any" = "any"): {
  pids: number[];
  descriptions: string[];
} {
  const pids: number[] = [];
  const descriptions: string[] = [];
  const selector = family === "4" ? `-ti4TCP:${OLLAMA_PROXY_PORT}` : `-tiTCP:${OLLAMA_PROXY_PORT}`;
  const pidOutput = runCapture(["lsof", selector, "-sTCP:LISTEN"], {
    ignoreError: true,
  });
  if (!pidOutput || !String(pidOutput).trim()) return { pids, descriptions };
  for (const raw of String(pidOutput).trim().split(/\s+/)) {
    const pid = Number.parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    // Our own auth proxy is not a conflict — killStaleProxy() reclaims it.
    if (isOllamaProxyProcess(pid)) continue;
    pids.push(pid);
    // Redact the owner's command line before display: a foreign process may
    // carry a secret in its argv (e.g. `--token=…`), and this string is printed
    // to the console. Matches the codebase convention of redacting command
    // output before surfacing it.
    const args = String(
      redact(runCapture(["ps", "-p", String(pid), "-o", "args="], { ignoreError: true }) || ""),
    ).trim();
    descriptions.push(args ? `PID ${pid}: ${args}` : `PID ${pid}`);
  }
  return { pids, descriptions };
}

function printProxyPortConflict(owners: { pids: number[]; descriptions: string[] }): void {
  console.error(
    `  Error: Ollama auth proxy cannot start — port ${OLLAMA_PROXY_PORT} is already in use by another process.`,
  );
  for (const description of owners.descriptions) {
    console.error(`    ${description}`);
  }
  console.error("  Resolve the conflict, then re-run onboarding:");
  console.error(`    • Stop the process above (e.g. kill ${owners.pids.join(" ") || "<pid>"}), or`);
  // Export (don't inline) the override: OLLAMA_PROXY_PORT is read from the
  // environment on every NemoClaw command, so a one-shot `VAR=… nemoclaw
  // onboard` would drift — a later `nemoclaw connect` without it would manage
  // the proxy on the default port while the route points at the custom one.
  console.error("    • Choose a free proxy port and export it so every NemoClaw command");
  console.error("      uses the same value (add it to your shell profile to persist):");
  console.error("        export NEMOCLAW_OLLAMA_PROXY_PORT=<port>");
  console.error("  Containers will not be able to reach the inference endpoint without the proxy.");
}

// ── Public API ───────────────────────────────────────────────────

// How long to wait for the detached proxy to bind the port. Slower hosts and
// the window right after the systemd loopback restart can need several seconds,
// so poll with backoff instead of the previous single 2s probe (issue #4820).
const PROXY_START_ATTEMPTS = 12;

function generateProxyToken(): string {
  const crypto = require("crypto");
  return crypto.randomBytes(24).toString("hex");
}

function attemptStartOllamaAuthProxyWithTokenUnlocked(
  proxyToken: string,
  backendUrl?: string,
): boolean {
  killStaleProxy();

  // After clearing any stale NemoClaw proxy, a process still holding the port
  // is a genuine conflict. Report the exact owner and remediation up front so
  // the user does not have to run lsof and interpret it themselves. Scope to
  // IPv4: an IPv6-only listener does not block our 0.0.0.0 bind, so aborting on
  // it would be a false conflict (a dual-stack blocker is still caught below
  // via the spawned proxy's EADDRINUSE).
  const preOwners = inspectForeignProxyPortOwners("4");
  if (preOwners.pids.length > 0) {
    printProxyPortConflict(preOwners);
    return false;
  }

  ollamaProxyToken = proxyToken;
  // Don't commit the selected backend yet — wait until setupInference confirms
  // the provider. A newly generated token remains in memory and is discarded
  // if the user backs out.
  const pid = spawnOllamaAuthProxy(proxyToken, backendUrl || `http://127.0.0.1:${OLLAMA_PORT}`);

  // Poll for readiness with backoff. Three terminal outcomes:
  //   • proxy alive and listening → success
  //   • proxy gone, a foreign process now owns the port → conflict (lost the
  //     EADDRINUSE race after the pre-check)
  //   • proxy gone, port free → it exited during startup (spawn failure)
  for (let attempt = 0; attempt < PROXY_START_ATTEMPTS; attempt++) {
    if (isOllamaProxyProcess(pid)) {
      // waitForPort is a cheap TCP gate; proxyOwnsPortWithToken then proves the
      // listener is our proxy (not a foreign service that grabbed the port)
      // before we treat startup as successful.
      if (waitForPort(OLLAMA_PROXY_PORT, 1) && proxyOwnsPortWithToken(proxyToken)) {
        return true;
      }
      sleep(1); // alive but not yet bound — give a slow host more time
      continue;
    }
    // The spawned proxy is gone. Three failure modes, in priority order:
    //   1. #6014 backend-bind probe failed (or any structured reason the
    //      proxy wrote to PROXY_STATUS_PATH before exit)
    //   2. Port conflict (EADDRINUSE race lost after pre-check)
    //   3. Generic "exited during startup" without a structured reason
    const status = readProxyExitStatus(PROXY_STATUS_PATH);
    if (printProxyStartupReason(status, OLLAMA_PORT, backendUrl)) {
      // Already rendered above.
    } else {
      const owners = inspectForeignProxyPortOwners("any");
      if (owners.pids.length > 0) {
        printProxyPortConflict(owners);
      } else {
        console.error(`  Error: Ollama auth proxy exited during startup on :${OLLAMA_PROXY_PORT}.`);
        console.error("  Containers will not be able to reach the inference endpoint without the proxy.");
        console.error(`  Check the proxy port owner: lsof -ti :${OLLAMA_PROXY_PORT}`);
      }
    }
    return false;
  }

  console.error(
    `  Error: Ollama auth proxy did not become ready on :${OLLAMA_PROXY_PORT} within ${PROXY_START_ATTEMPTS}s.`,
  );
  console.error("  Containers will not be able to reach the inference endpoint without the proxy.");
  console.error(`  Check the proxy port owner: lsof -ti :${OLLAMA_PROXY_PORT}`);
  return false;
}

function startOllamaAuthProxyWithTokenUnlocked(
  proxyToken: string,
  backendUrl?: string,
  releaseReservedPortOnFailure = false,
): boolean {
  // Bind the host-global proxy state to one port before touching its process.
  // A second gateway with a different environment must not move the shared
  // proxy away from routes that existing sandboxes still use.
  const reservedPort = persistOrValidateProxyPortUnlocked();
  try {
    const started = attemptStartOllamaAuthProxyWithTokenUnlocked(proxyToken, backendUrl);
    if (!started && reservedPort && releaseReservedPortOnFailure) {
      removeLocalAdapterFile(PROXY_PORT_PATH);
    }
    return started;
  } catch (error) {
    if (reservedPort && releaseReservedPortOnFailure) removeLocalAdapterFile(PROXY_PORT_PATH);
    throw error;
  }
}

function startOllamaAuthProxyWithToken(proxyToken: string, backendUrl?: string): boolean {
  return withOllamaProxyLifecycleLock(() => {
    const releaseReservedPortOnFailure = !readProxyStateFile(PROXY_TOKEN_PATH);
    return startOllamaAuthProxyWithTokenUnlocked(
      proxyToken,
      backendUrl,
      releaseReservedPortOnFailure,
    );
  });
}

function startOllamaAuthProxy(backendUrl?: string): boolean {
  return withOllamaProxyLifecycleLock(() => {
    // Re-onboarding the committed local Ollama route must keep the credential
    // already mounted in the sandbox. A compatible custom endpoint uses the
    // explicit fresh-token path below until provider selection commits it.
    let proxyToken = loadPersistedProxyToken();
    const reservedNewToken = !proxyToken;
    if (!proxyToken) {
      proxyToken = generateProxyToken();
      // Reserve the first host token before restarting the shared process so
      // another gateway cannot mint a different credential after this lock is
      // released. The backend remains uncommitted until provider selection.
      writeLocalAdapterSecretFile(PROXY_TOKEN_PATH, proxyToken);
    }
    try {
      const started = startOllamaAuthProxyWithTokenUnlocked(
        proxyToken,
        backendUrl,
        reservedNewToken,
      );
      if (!started && reservedNewToken) removeLocalAdapterFile(PROXY_TOKEN_PATH);
      return started;
    } catch (error) {
      if (reservedNewToken) removeLocalAdapterFile(PROXY_TOKEN_PATH);
      throw error;
    }
  });
}

function noAuthProxy(endpointUrl: string) {
  const endpoint = new URL(endpointUrl);
  if (!startOllamaAuthProxyWithToken(generateProxyToken(), endpoint.origin)) {
    restorePersistedOllamaAuthProxy();
    throw new Error("Could not start the protected loopback route.");
  }
  return {
    baseUrl: `http://host.openshell.internal:${OLLAMA_PROXY_PORT}${endpoint.pathname}`,
    credentialValue: getOllamaProxyToken()!,
    persist: () =>
      persistProxyToken(getOllamaProxyToken()!, endpoint.origin, "compatible-endpoint"),
    restore: restorePersistedOllamaAuthProxy,
  };
}

function restorePersistedOllamaAuthProxy(): void {
  withOllamaProxyLifecycleLock(() => {
    const hasPersistedToken = readProxyStateFile(PROXY_TOKEN_PATH) !== null;
    killStaleProxy();
    if (!hasPersistedToken) removeLocalAdapterFile(PROXY_PORT_PATH);
    ollamaProxyToken = null;
    ensureOllamaAuthProxy();
  });
}

/**
 * Probe the running proxy to confirm it accepts the given token.
 * The proxy validates auth before forwarding to Ollama. A backend error like
 * 502 still proves the token was accepted, while 401 means token mismatch.
 *
 * Targets 127.0.0.1 (not `localhost`): the proxy binds IPv4 0.0.0.0, and
 * `localhost` can resolve to ::1 first — on a host where an unrelated IPv6-only
 * service holds the port, that would probe the wrong listener. This matches the
 * other proxy probes (isProxyHealthy, probeOllamaAuthProxyHealth). See #4820.
 */
function probeProxyToken(token: string): "accepted" | "rejected" | "unreachable" {
  const result = runCurlWithAuthConfig(
    ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3"],
    `http://127.0.0.1:${OLLAMA_PROXY_PORT}/v1/models`,
    token,
  );
  if (result.status !== 0) return "unreachable";

  const status = String(result.stdout || "").trim();
  if (status === "401") return "rejected";
  if (/^\d{3}$/.test(status)) return "accepted";
  return "unreachable";
}

// Confirm the listener on the proxy port is actually our auth proxy holding
// THIS token — not a foreign service that merely answers on the port. Our
// proxy is the only listener that BOTH rejects an unauthenticated request with
// 401 AND accepts the current token (200 from Ollama, or 502 when the backend
// is down — both non-401). A foreign HTTP service that ignores Authorization
// (answers 200/404 to everything) fails the unauthenticated-401 half, and a
// raw socket fails both. Requiring both halves is what makes this a
// proxy-specific readiness proof: without it we could persist a token for a
// process that never bound (lsof unavailable, or a dual-stack listener the
// IPv4 precheck missed, losing the EADDRINUSE race). The probes target
// 127.0.0.1, so they confirm our IPv4 proxy even when an unrelated IPv6-only
// listener shares the port number. See #4820.
function proxyOwnsPortWithToken(token: string): boolean {
  return probeProxyToken(token) === "accepted" && probeProxyToken("") === "rejected";
}

/**
 * Ensure the auth proxy is running with the correct persisted token.
 * Called on sandbox connect to recover from host reboots where the
 * background proxy process was lost, and to detect token divergence
 * after a failed re-onboard (see issue #2553).
 */
function ensureOllamaAuthProxyUnlocked(): void {
  const pid = loadPersistedProxyPid();
  // noAuthProxy can replace the live proxy before setupInference confirms a
  // compatible endpoint and commits its new token and backend. Preserve this
  // in-memory proxy across recovery during that transition. This exception can
  // go away when compatible-provider selection commits the replacement state
  // before any recovery path can call ensureOllamaAuthProxy.
  if (
    ollamaProxyToken &&
    isOllamaProxyProcess(pid) &&
    probeProxyToken(ollamaProxyToken) === "accepted"
  ) {
    return;
  }

  // Try to load persisted token first — if none, this isn't an Ollama setup.
  const token = loadPersistedProxyToken();
  if (!token) return;
  persistOrValidateProxyPortUnlocked();

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
  const backend = readProxyBackendIdentity();
  const startedPid = spawnOllamaAuthProxy(token, backend.url ?? undefined);
  for (let attempt = 0; attempt < 10; attempt++) {
    if (isOllamaProxyProcess(startedPid) && probeProxyToken(token) === "accepted") return;
    sleep(1);
  }
  const status = readProxyExitStatus(PROXY_STATUS_PATH);
  if (printProxyStartupReason(status, OLLAMA_PORT, backend.url ?? undefined, backend.kind)) return;
  console.error(`  Error: Ollama auth proxy did not become ready after restart.`);
}

function ensureOllamaAuthProxy(): void {
  withOllamaProxyLifecycleLock(ensureOllamaAuthProxyUnlocked);
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
  const output = runCurlCaptureWithAuthConfig(
    ["-sf", "--connect-timeout", "3", "--max-time", "5"],
    proxyUrl,
    token,
  );
  if (output) return true;

  // HTTP probe failed — fall back to PID as a weaker signal.
  // This covers edge cases where the probe transiently fails but the
  // process is confirmed alive.
  return hasValidPid;
}

function probeOllamaAuthProxyHealth(): { ok: boolean; endpoint: string; detail: string } {
  const endpoint = `http://127.0.0.1:${OLLAMA_PROXY_PORT}/v1/models`;
  const token = loadPersistedProxyToken();
  if (!token) {
    return {
      ok: false,
      endpoint,
      detail:
        "Ollama auth proxy token is missing. Re-run NemoClaw onboarding for the Ollama-local sandbox.",
    };
  }

  const result = runCurlWithAuthConfig(
    ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "3", "--max-time", "5"],
    endpoint,
    token,
  );

  const status = Number(String(result.stdout || "").trim());
  if (result.status === 0 && Number.isFinite(status) && status >= 200 && status < 300) {
    return {
      ok: true,
      endpoint,
      detail: `Ollama auth proxy is reachable on ${endpoint}.`,
    };
  }

  if (status === 401) {
    return {
      ok: false,
      endpoint,
      detail:
        "Ollama auth proxy rejected the persisted token. Re-run NemoClaw onboarding for the Ollama-local sandbox.",
    };
  }

  if (Number.isFinite(status) && status >= 300 && status < 500) {
    return {
      ok: false,
      endpoint,
      detail:
        `Ollama auth proxy is reachable on ${endpoint}, but returned HTTP ${status}. ` +
        "Check auth, route, and proxy configuration.",
    };
  }

  if (Number.isFinite(status) && status >= 500) {
    return {
      ok: false,
      endpoint,
      detail:
        `Ollama auth proxy is running on ${endpoint}, but its backend returned HTTP ${status}. ` +
        `Verify host Ollama on localhost:${OLLAMA_PORT} and retry.`,
    };
  }

  const failure = String(result.stderr || result.error?.message || "").trim();
  return {
    ok: false,
    endpoint,
    detail: failure
      ? `Ollama auth proxy is not reachable on ${endpoint}. (${failure})`
      : `Ollama auth proxy is not reachable on ${endpoint}.`,
  };
}

function formatOllamaMemoryMB(memoryMB: number): string {
  return formatBytes(memoryMB * 1024 * 1024);
}

function annotateOllamaModelOption(tag: string, gpu: GpuInfo | null): string {
  const facts = describeOllamaModelCapacity(tag, gpu);
  const hasAvailableMemory =
    typeof gpu?.availableMemoryMB === "number" && gpu.availableMemoryMB > 0;
  const parts: string[] = [];
  if (typeof facts.downloadSizeBytes === "number") {
    parts.push(`${formatBytes(facts.downloadSizeBytes)} download`);
  }
  if (typeof facts.requiredMemoryMB === "number") {
    parts.push(`~${formatOllamaMemoryMB(facts.requiredMemoryMB)} VRAM`);
  }
  if (facts.fits === false) {
    parts.push(hasAvailableMemory ? "exceeds available memory" : "exceeds total memory");
  }
  return parts.length > 0 ? `  (${parts.join(" · ")})` : "";
}

async function promptOllamaModel(
  gpu: GpuInfo | null = null,
  promptOptions: { defaultModel?: string | null; excludeModels?: ReadonlySet<string> } = {},
) {
  const excludeModels = promptOptions.excludeModels;
  const isExcluded = (tag: string): boolean =>
    excludeModels !== undefined && excludeModels.has(tag);
  const installed = getOllamaModelOptions();
  // Filter installed entries by registry-known memory fit so a host that
  // currently cannot load the only installed model still gets a usable
  // default — without the filter, pressing Enter would re-select the
  // oversized model the runner is about to crash on. Unknown tags (user-
  // pulled models the registry has never seen) pass the filter so the
  // user's prior selection is respected. `excludeModels` additionally drops
  // tags the caller knows the local probe has already rejected this round.
  const installedFitting = installed.filter(
    (tag: string) => modelFitsAvailableMemory(tag, gpu) && !isExcluded(tag),
  );
  const usingInstalled = installedFitting.length > 0;
  const bootstrap = getBootstrapOllamaModelOptions(gpu).filter((tag: string) => !isExcluded(tag));
  const options = usingInstalled ? installedFitting : bootstrap;
  const requestedDefaultModel =
    typeof promptOptions.defaultModel === "string" ? promptOptions.defaultModel.trim() : "";
  const requestedDefaultOption = requestedDefaultModel
    ? options.find((option: string) => ollamaModelRefsMatch(option, requestedDefaultModel))
    : undefined;
  const defaultModelCandidate = getDefaultOllamaModel(gpu);
  const defaultModel =
    requestedDefaultOption ??
    (isExcluded(defaultModelCandidate)
      ? (options[0] ?? defaultModelCandidate)
      : defaultModelCandidate);
  const defaultIndex = Math.max(
    0,
    options.findIndex((option: string) => ollamaModelRefsMatch(option, defaultModel)),
  );

  console.log("");
  console.log(usingInstalled ? "  Ollama models:" : "  Ollama starter models:");
  const effectiveMemoryMB = effectiveGpuMemoryMB(gpu);
  const hasAvailableMemory =
    typeof gpu?.availableMemoryMB === "number" && gpu.availableMemoryMB > 0;
  const capacityLabel = hasAvailableMemory ? "currently available GPU memory" : "total GPU memory";
  if (typeof effectiveMemoryMB === "number") {
    const memoryKind = hasAvailableMemory ? "Available" : "Total";
    console.log(`  ${memoryKind} GPU memory: ${formatOllamaMemoryMB(effectiveMemoryMB)}.`);
  }
  options.forEach((option: string, index: number) => {
    console.log(`    ${index + 1}) ${option}${annotateOllamaModelOption(option, gpu)}`);
  });
  console.log(`    ${options.length + 1}) Other...`);
  if (!usingInstalled) {
    console.log("");
    if (installed.length === 0) {
      console.log("  No local Ollama models are installed yet. Choose one to pull and load now.");
    } else {
      console.log(
        `  No installed Ollama model fits the host's ${capacityLabel}; showing starter models instead.`,
      );
    }
  }
  if (!usingInstalled && !anyRegistryModelFits(gpu)) {
    console.log(
      `  ! Even the smallest known bootstrap model may not fit ${capacityLabel}; ${
        hasAvailableMemory ? "free memory" : "choose a smaller model"
      } or expect the runner to reject the load.`,
    );
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

const DEFAULT_OLLAMA_PULL_TIMEOUT_MS = 30 * 60 * 1000;
const PULL_TIMEOUT_ENV = "NEMOCLAW_OLLAMA_PULL_TIMEOUT";

function getOllamaPullTimeoutMs(): number {
  const raw = process.env[PULL_TIMEOUT_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_OLLAMA_PULL_TIMEOUT_MS;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_OLLAMA_PULL_TIMEOUT_MS;
  return Math.floor(seconds * 1000);
}

function pullTimeoutErrorHint(timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60_000);
  return [
    `  Model pull timed out after ${minutes} minutes.`,
    "  Already-downloaded layers are kept; re-running the pull resumes them.",
    `  Set ${PULL_TIMEOUT_ENV}=<seconds> to raise the wall-clock limit (default ${Math.round(DEFAULT_OLLAMA_PULL_TIMEOUT_MS / 60_000)} minutes).`,
  ].join("\n");
}

function normalizeOllamaPullModel(model: string): string {
  const value = String(model || "").trim();
  if (!value || /[\0\r\n]/.test(value)) {
    throw new Error("Invalid Ollama model id for pull request");
  }
  return value;
}

function buildLocalOllamaEndpoint(resolveHost = getResolvedOllamaHost): string {
  const host = resolveHost();
  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", OLLAMA_HOST_DOCKER_INTERNAL]);
  if (!allowedHosts.has(host)) {
    throw new Error(`Refusing to contact unexpected Ollama host: ${host}`);
  }
  const url = new URL("http://127.0.0.1");
  url.hostname = host;
  url.port = String(OLLAMA_PORT);
  return url.origin;
}

function buildLocalOllamaPullUrl(): string {
  return `${buildLocalOllamaEndpoint()}/api/pull`;
}

function pullOllamaModelViaCli(model: string): boolean {
  const timeoutMs = getOllamaPullTimeoutMs();
  const result = spawnSync("bash", ["-c", `ollama pull ${shellQuote(model)}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: redirectInheritedChildStdoutToStderr("inherit"),
    timeout: timeoutMs,
    env: buildSubprocessEnv(),
  });
  if (result.signal === "SIGTERM") {
    console.error(pullTimeoutErrorHint(timeoutMs));
    return false;
  }
  return result.status === 0;
}

// Pull via Ollama's HTTP API instead of shelling out to the `ollama` CLI.
// Used only when the resolved host is the Windows host (host.docker.internal),
// where there is no `ollama` binary in WSL to shell out to. Native Linux/macOS
// keeps the CLI path so existing behavior is unchanged.
function pullOllamaModelViaHttp(model: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const url = buildLocalOllamaPullUrl();
    const body = JSON.stringify({ model: normalizeOllamaPullModel(model), stream: true });
    const TIMEOUT_MS = getOllamaPullTimeoutMs();
    const isTTY = Boolean(process.stdout.isTTY);
    const BAR_WIDTH = 40;

    // The endpoint is restricted to the local Ollama hosts NemoClaw probes and
    // the model id is normalized before being serialized as JSON request data.
    const proc = spawn(
      "curl",
      [
        "-sN",
        "--connect-timeout",
        "10",
        "--max-time",
        String(TIMEOUT_MS / 1000),
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-d",
        // codeql[js/file-access-to-http]: local-only Ollama API with a normalized model id.
        body,
        url,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // #2616: inject NO_PROXY=localhost so the streamed pull against the
        // local Ollama daemon doesn't tunnel through the user's host proxy.
        env: buildSubprocessEnv(),
      },
    );

    const readline = require("readline");
    const rl = readline.createInterface({ input: proc.stdout });
    let currentStatus = "";
    let progressActive = false;
    let lastNonTtyLine = "";
    let sawSuccess = false;
    let sawError = false;

    const formatSize = (bytes: number): string => {
      if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
      if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
      if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
      return `${bytes} B`;
    };

    const renderBar = (pct: number): string => {
      const filled = Math.floor((pct / 100) * BAR_WIDTH);
      return `${"█".repeat(filled)}${" ".repeat(BAR_WIDTH - filled)}`;
    };

    const finishLine = () => {
      if (isTTY && progressActive) {
        process.stdout.write("\n");
        progressActive = false;
      }
    };

    rl.on("line", (line: string) => {
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

    proc.on("error", (err: Error) => {
      finishLine();
      console.error(`  Pull failed to start: ${err.message}`);
      resolve(false);
    });

    // Use 'close' rather than 'exit' so the promise resolves only after the
    // child's stdio streams are fully drained, ensuring readline has emitted
    // the final 'line' event for the trailing `success` JSON.
    proc.on("close", (code: number | null) => {
      finishLine();
      if (sawError) {
        resolve(false);
        return;
      }
      if (code !== 0) {
        // curl exit 28 = CURLE_OPERATION_TIMEDOUT (--max-time hit).
        if (code === 28) {
          console.error(pullTimeoutErrorHint(TIMEOUT_MS));
        } else {
          console.error(`  Model pull exited with code ${String(code)} (network error).`);
          console.error("  Already-downloaded layers are kept; re-running the pull resumes them.");
        }
        resolve(false);
        return;
      }
      resolve(sawSuccess);
    });
  });
}

function hasLocalOllamaCli(): boolean {
  return !!runCapture(["sh", "-c", "command -v ollama"], { ignoreError: true }).trim();
}

// Dispatch to HTTP pull whenever there is no local `ollama` binary to invoke.
// Keying on the resolved host alone missed the WSL mirrored networking case,
// where the Windows-host daemon answers on 127.0.0.1 and no Linux binary
// exists — the CLI branch then failed with "ollama: command not found" against
// a daemon that answered `/api/tags` (#7472).
async function pullOllamaModel(model: string): Promise<boolean> {
  if (getResolvedOllamaHost() === OLLAMA_HOST_DOCKER_INTERNAL || !hasLocalOllamaCli()) {
    return pullOllamaModelViaHttp(model);
  }
  return pullOllamaModelViaCli(model);
}

// ── Tools-capability gate (issue #2667) ─────────────────────────
//
// Ollama models without the "tools" capability fail at first agent prompt
// with "400 ... does not support tools" — too late to recover gracefully.
// We probe /api/show right after the pull completes (and before warmup) to
// warn the user up front and either prompt for confirmation, accept an
// override env var in non-interactive mode, or block. Probe failures
// degrade to "unknown" and never block onboarding.

export type OllamaToolCapabilityInteraction = Readonly<{
  isNonInteractive: () => boolean;
  isAutoYes: () => boolean;
  confirm: (question: string, defaultIsYes: boolean) => Promise<boolean>;
}>;

async function promptProxyYesNo(question: string, defaultIsYes: boolean): Promise<boolean> {
  // Standalone callers use the credential-store prompt. Onboarding injects
  // its own confirmation helper so this module does not depend on onboard.ts.
  const reply = await prompt(`${question} ${defaultIsYes ? "[Y/n]" : "[y/N]"}: `);
  const v = String(reply ?? "")
    .trim()
    .toLowerCase();
  if (v === "y" || v === "yes") return true;
  if (v === "n" || v === "no") return false;
  return defaultIsYes;
}

const defaultOllamaToolCapabilityInteraction: OllamaToolCapabilityInteraction = {
  isNonInteractive: isNonInteractiveEnv,
  isAutoYes: () => process.env.NEMOCLAW_YES === "1",
  confirm: promptProxyYesNo,
};

function printToolsIncompatibleWarning(model: string): void {
  console.log("");
  console.log(`  ⚠ Ollama model '${model}' does not advertise the 'tools' capability.`);
  console.log("    NemoClaw agents need tool-calling for file operations, web search, and");
  console.log('    running commands. This model will likely fail with "400 ... does not');
  console.log('    support tools" at first prompt.');
  console.log("    Inspect a model's capabilities with `ollama show <model>` and pick");
  console.log("    one whose list includes 'tools'.");
}

async function checkOllamaModelToolSupport(
  model: string,
  interaction: OllamaToolCapabilityInteraction = defaultOllamaToolCapabilityInteraction,
): Promise<{ ok: boolean; message?: string; allowToolsIncompatible?: boolean }> {
  const caps = probeOllamaModelCapabilities(model);

  if (caps.supportsTools === true) {
    return { ok: true };
  }

  if (caps.supportsTools === null) {
    // Graceful degradation — never block on probe failure.
    console.log(
      `  \x1b[2mCould not verify 'tools' capability for '${model}' — Ollama did ` +
        `not return capability metadata; continuing.\x1b[0m`,
    );
    return { ok: true };
  }

  // supportsTools === false — model is on disk but advertises no tools support.
  // Every code path below that returns ok:true must also set
  // allowToolsIncompatible:true so downstream validators (validateOllamaModel,
  // probeChatCompletionsToolCalling via setupOllama / setupInference) don't
  // reject the same model on the same condition — see issue #4241.
  printToolsIncompatibleWarning(model);

  if (interaction.isAutoYes()) {
    console.log("  Continuing because --yes was passed.");
    return { ok: true, allowToolsIncompatible: true };
  }

  if (interaction.isNonInteractive()) {
    if (process.env.NEMOCLAW_OLLAMA_REQUIRE_TOOLS === "0") {
      console.error(
        `  NEMOCLAW_OLLAMA_REQUIRE_TOOLS=0 set — proceeding with '${model}' despite missing 'tools'.`,
      );
      return { ok: true, allowToolsIncompatible: true };
    }
    console.error(
      "  Re-run with NEMOCLAW_OLLAMA_REQUIRE_TOOLS=0 to override, or pick a tools-capable model.",
    );
    return { ok: false, message: "Tools-incompatible model in non-interactive mode." };
  }

  const proceed = await interaction.confirm("  Use this model anyway?", false);
  if (!proceed) {
    return { ok: false, message: "Choose a tools-capable model." };
  }
  return { ok: true, allowToolsIncompatible: true };
}

async function prepareOllamaModel(
  model: string,
  installedModels: string[] = [],
  interaction: OllamaToolCapabilityInteraction = defaultOllamaToolCapabilityInteraction,
  discoveryDeps: PulledModelDiscoveryDeps = {},
): Promise<{
  ok: boolean;
  message?: string;
  allowToolsIncompatible?: boolean;
  daemonFailure?: boolean;
}> {
  const testSleep = process.env.NEMOCLAW_TEST_NO_SLEEP === "1" ? () => {} : undefined;
  const discovery = await ensurePulledOllamaModel(model, installedModels, pullOllamaModel, {
    ...discoveryDeps,
    sleep: discoveryDeps.sleep ?? testSleep,
  });
  if (!discovery.ok) return discovery;

  const capCheck = await checkOllamaModelToolSupport(model, interaction);
  if (!capCheck.ok) {
    return { ok: false, message: capCheck.message };
  }

  console.log(`  Loading Ollama model: ${model}`);
  run(getOllamaWarmupCommand(model), { ignoreError: true });
  const allowToolsIncompatible = capCheck.allowToolsIncompatible === true;
  const result = validateOllamaModel(model, undefined, undefined, undefined, {
    allowToolsIncompatible,
  });
  return { ...result, allowToolsIncompatible };
}

const OLLAMA_RELEASE_MAX_ATTEMPTS = 3;
const OLLAMA_RELEASE_RETRY_DELAY_MS = 250;
const OLLAMA_RELEASE_VERIFY_DELAY_MS = 100;

export type OllamaModelDiscoveryEvidence = {
  readonly attempt: number;
  readonly endpoint: string;
  readonly status: number | null;
  readonly residentModels: readonly string[];
  readonly matchedModels: readonly string[];
  readonly error?: string;
};

export type OllamaUnloadRequestEvidence = {
  readonly attempt: number;
  readonly endpoint: string;
  readonly model: string;
  readonly status: number | null;
  readonly error?: string;
};

export type OllamaUnloadResult = {
  readonly ok: boolean;
  readonly outcome:
    | "released"
    | "not-resident"
    | "discovery-failed"
    | "unload-request-failed"
    | "still-resident";
  readonly endpoint: string;
  readonly selectedModels: readonly string[];
  readonly discoveries: readonly OllamaModelDiscoveryEvidence[];
  readonly requests: readonly OllamaUnloadRequestEvidence[];
  readonly message?: string;
};

type OllamaUnloadOptions = {
  readonly getResolvedOllamaHost?: typeof getResolvedOllamaHost;
  readonly maxAttempts?: number;
  readonly sleep?: (milliseconds: number) => void;
  readonly spawnSync?: typeof spawnSync;
};

function boundedCurlError(result): string | undefined {
  const detail = String(result?.stderr || result?.error?.message || "").trim();
  return detail ? detail.slice(0, 300) : undefined;
}

function transientCurlFailure(status: number | null): boolean {
  return status === 6 || status === 7 || status === 18 || status === 28 || status === 52 || status === 56;
}

function defaultReleaseSleep(milliseconds: number): void {
  if (process.env.VITEST === "true" || process.env.NEMOCLAW_TEST_NO_SLEEP === "1") return;
  sleepMs(milliseconds);
}

function discoverResidentOllamaModels(
  attempt: number,
  selectedModels: readonly string[] | null,
  releaseEndpoint: string,
  spawnSyncImpl: typeof spawnSync,
): OllamaModelDiscoveryEvidence {
  const endpoint = `${releaseEndpoint}/api/ps`;
  let result;
  try {
    result = spawnSyncImpl(
      "curl",
      ["-sS", "--fail-with-body", "--max-time", "3", endpoint],
      // #2616: env-sanitize so an ambient HTTP proxy cannot intercept the
      // loopback-only Ollama ownership and release checks.
      { encoding: "utf8", env: buildSubprocessEnv() },
    );
  } catch (error) {
    return {
      attempt,
      endpoint,
      status: null,
      residentModels: [],
      matchedModels: [],
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    };
  }
  if (result.status !== 0) {
    return {
      attempt,
      endpoint,
      status: result.status,
      residentModels: [],
      matchedModels: [],
      error: boundedCurlError(result) ?? `curl exited ${String(result.status)}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "");
  } catch {
    return {
      attempt,
      endpoint,
      status: result.status,
      residentModels: [],
      matchedModels: [],
      error: "Ollama /api/ps returned malformed JSON",
    };
  }
  if (!parsed || !Array.isArray(parsed.models)) {
    return {
      attempt,
      endpoint,
      status: result.status,
      residentModels: [],
      matchedModels: [],
      error: "Ollama /api/ps response is missing the models array",
    };
  }
  const malformedEntry = parsed.models.find(
    (entry) => !entry || typeof entry.name !== "string" || !entry.name.trim(),
  );
  if (malformedEntry) {
    return {
      attempt,
      endpoint,
      status: result.status,
      residentModels: [],
      matchedModels: [],
      error: "Ollama /api/ps returned a model without a valid name",
    };
  }
  const residentModels = parsed.models.map((entry) => entry.name.trim());
  const matchedModels = selectedModels
    ? residentModels.filter((resident) =>
        selectedModels.some((selected) => ollamaModelRefsMatch(selected, resident)),
      )
    : residentModels;
  return { attempt, endpoint, status: result.status, residentModels, matchedModels };
}

/**
 * Synchronously release selected Ollama models and prove that they disappeared.
 *
 * The CLI can exit immediately after this call, so the implementation remains
 * synchronous. A scoped caller passes one or more model references; an empty or
 * absent selection retains the host-wide cleanup behavior used by destroy and
 * stop-all. Every discovery, request, retry, and verification result is returned
 * so a sandbox stop can fail instead of reporting release that did not happen.
 */
function unloadOllamaModels(
  onlyModels?: readonly string[],
  options: OllamaUnloadOptions = {},
): OllamaUnloadResult {
  const releaseEndpoint = buildLocalOllamaEndpoint(
    options.getResolvedOllamaHost ?? getResolvedOllamaHost,
  );
  const spawnSyncImpl = options.spawnSync ?? spawnSync;
  const sleepImpl = options.sleep ?? defaultReleaseSleep;
  const maxAttempts = Math.max(1, options.maxAttempts ?? OLLAMA_RELEASE_MAX_ATTEMPTS);
  const requestedModels = onlyModels?.map((model) => model.trim()).filter(Boolean) ?? [];
  let selectedModels: readonly string[] | null = onlyModels?.length ? requestedModels : null;
  const discoveries: OllamaModelDiscoveryEvidence[] = [];
  const requests: OllamaUnloadRequestEvidence[] = [];
  let lastMatchedModels: readonly string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const discovery = discoverResidentOllamaModels(attempt, selectedModels, releaseEndpoint, spawnSyncImpl);
    discoveries.push(discovery);
    if (discovery.error) {
      if (attempt < maxAttempts && transientCurlFailure(discovery.status)) {
        sleepImpl(OLLAMA_RELEASE_RETRY_DELAY_MS);
        continue;
      }
      return {
        ok: false,
        outcome: "discovery-failed",
        endpoint: releaseEndpoint,
        selectedModels: selectedModels ?? [],
        discoveries,
        requests,
        message: discovery.error,
      };
    }

    if (selectedModels === null) selectedModels = discovery.residentModels;
    lastMatchedModels = discovery.matchedModels;
    if (lastMatchedModels.length === 0) {
      return {
        ok: true,
        outcome: requests.length ? "released" : "not-resident",
        endpoint: releaseEndpoint,
        selectedModels,
        discoveries,
        requests,
      };
    }

    let retryRequest = false;
    for (const model of lastMatchedModels) {
      const endpoint = `${releaseEndpoint}/api/generate`;
      let result;
      try {
        result = spawnSyncImpl(
          "curl",
          [
            "-sS",
            "--fail-with-body",
            "-o",
            "/dev/null",
            "--max-time",
            "3",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-d",
            JSON.stringify({ model, keep_alive: 0 }),
            endpoint,
          ],
          { encoding: "utf8", env: buildSubprocessEnv() },
        );
      } catch (error) {
        result = {
          status: null,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
      const request = {
        attempt,
        endpoint,
        model,
        status: result.status,
        ...(result.status === 0
          ? {}
          : { error: boundedCurlError(result) ?? `curl exited ${String(result.status)}` }),
      };
      requests.push(request);
      if (request.error) {
        if (attempt < maxAttempts && transientCurlFailure(request.status)) {
          retryRequest = true;
          break;
        }
        return {
          ok: false,
          outcome: "unload-request-failed",
          endpoint: releaseEndpoint,
          selectedModels,
          discoveries,
          requests,
          message: request.error,
        };
      }
    }
    if (retryRequest) {
      sleepImpl(OLLAMA_RELEASE_RETRY_DELAY_MS);
      continue;
    }

    sleepImpl(OLLAMA_RELEASE_VERIFY_DELAY_MS);
    const verification = discoverResidentOllamaModels(attempt, selectedModels, releaseEndpoint, spawnSyncImpl);
    discoveries.push(verification);
    if (verification.error) {
      if (attempt < maxAttempts && transientCurlFailure(verification.status)) {
        sleepImpl(OLLAMA_RELEASE_RETRY_DELAY_MS);
        continue;
      }
      return {
        ok: false,
        outcome: "discovery-failed",
        endpoint: releaseEndpoint,
        selectedModels,
        discoveries,
        requests,
        message: verification.error,
      };
    }
    lastMatchedModels = verification.matchedModels;
    if (lastMatchedModels.length === 0) {
      return {
        ok: true,
        outcome: "released",
        endpoint: releaseEndpoint,
        selectedModels,
        discoveries,
        requests,
      };
    }
    if (attempt < maxAttempts) sleepImpl(OLLAMA_RELEASE_RETRY_DELAY_MS);
  }

  return {
    ok: false,
    outcome: "still-resident",
    endpoint: releaseEndpoint,
    selectedModels: selectedModels ?? [],
    discoveries,
    requests,
    message: `Ollama still reports: ${lastMatchedModels.join(", ")}`,
  };
}

export {
  checkOllamaModelToolSupport,
  ensureOllamaAuthProxy,
  getOllamaProxyToken,
  getOllamaPullTimeoutMs,
  isProxyHealthy,
  killStaleProxy,
  noAuthProxy,
  persistAndProbeOllamaProxy,
  persistProxyToken,
  prepareOllamaModel,
  printOllamaExposureWarning,
  probeOllamaAuthProxyHealth,
  promptOllamaModel,
  pullOllamaModel,
  startOllamaAuthProxy,
  unloadOllamaModels,
  withOllamaModelOwnershipLock,
  withOllamaProxyLifecycleTransaction,
};
