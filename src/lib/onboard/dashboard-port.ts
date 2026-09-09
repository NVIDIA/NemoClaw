// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard-port allocation for the OpenShell sandbox.
 *
 * The allocator runs at sandbox-create time and bakes the chosen port into
 * the sandbox's Dockerfile ARG + NEMOCLAW_DASHBOARD_PORT env. If the port
 * later turns out to be unavailable, the sandbox has to be torn down and
 * re-created, so the allocator needs to be aggressive about detecting
 * already-bound host ports — `lsof` alone misses root-owned listeners on
 * macOS (docker-proxy) and TOCTOU windows where another listener binds
 * mid-build. See #3260 and #2174.
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";

import {
  DASHBOARD_PORT,
  DASHBOARD_PORT_RANGE_END,
  DASHBOARD_PORT_RANGE_START,
  GATEWAY_PORT,
} from "../core/ports";
import { listHostGatewayRegistryEntries } from "../state/gateway-registry";
import { type McpLifecycleLockOptions, withMcpLifecycleLock } from "../state/mcp-lifecycle-lock";

// runner.ts is still CommonJS — use require so module shape matches.
const { runCapture } = require("../runner");
type RunCaptureFn = typeof import("../runner").runCapture;

type SandboxRegistryEntry = {
  name: string;
  dashboardPort?: number | null;
  hermesApiPort?: number | null;
  scopeGatewayPort?: number;
};

export type ListSandboxesFn = () => { sandboxes: SandboxRegistryEntry[] };

const DASHBOARD_PORT_RESERVATION_LOCK = "dashboard-port-reservation:host";

/**
 * Serialize host-wide dashboard-port selection through durable ownership.
 *
 * OpenShell forward listings are gateway-scoped while dashboard ports and the
 * NemoClaw registry are host-scoped. Holding one cross-process lease across
 * allocation and registration prevents onboard or snapshot restores on
 * different gateways from selecting the same currently-free port.
 * Callers that also need lifecycle locks must use the shared order:
 * sandbox mutation → this host reservation → gateway route mutation.
 */
export function withDashboardPortReservationLock<T>(
  operation: () => Promise<T> | T,
  options: McpLifecycleLockOptions = {},
): Promise<T> {
  return withMcpLifecycleLock(DASHBOARD_PORT_RESERVATION_LOCK, operation, options);
}

// Match the broader pattern used by onboard.ts (covers CSI, OSC, and Fe escapes)
// so colorised `openshell forward list` output parses correctly.
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;

/** OpenShell forward statuses that hold a port (and therefore block reuse). */
export function isLiveForwardStatus(status: string): boolean {
  return status === "running" || status === "active";
}

/**
 * Parse `openshell forward list` output into a Map<port, sandboxName>.
 * Only includes running forwards — stopped/stale entries are ignored so
 * they don't block port allocation or cause false "range exhausted" errors.
 *
 * ANSI escape codes (the openshell CLI colourises status columns when
 * stdout is a TTY) are stripped per-line before tokenising so port numbers
 * and status words are matched cleanly.
 *
 * Output format (columns separated by whitespace):
 *   SANDBOX  BIND  PORT  PID  STATUS
 */
export function getOccupiedPorts(forwardListOutput: string | null): Map<string, string> {
  const occupied = new Map<string, string>();
  if (!forwardListOutput) return occupied;
  for (const rawLine of forwardListOutput.split("\n")) {
    const line = rawLine.replace(ANSI_RE, "");
    if (/^\s*SANDBOX\s/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    // parts: [sandbox, bind, port, pid, status...]
    if (parts.length < 3 || !/^\d+$/.test(parts[2])) continue;
    const status = (parts[4] || "").toLowerCase();
    if (!isLiveForwardStatus(status)) continue;
    occupied.set(parts[2], parts[0]);
  }
  return occupied;
}

/**
 * Synchronous Node `net` bind probe — tries to listen on the port and
 * reports whether the bind would have failed with EADDRINUSE. Spawned via
 * spawnSync of `node -e` because `findAvailableDashboardPort` runs deep in
 * a sync allocation flow and `net.createServer().listen()` is async.
 *
 * Exit codes: 0 = bind succeeded (port free); 1 = EADDRINUSE; anything
 * else = inconclusive (treated as free for safety — the forward-start
 * check is authoritative).
 */
export function probePortBoundSync(port: number): boolean {
  try {
    const script =
      "const net = require('node:net');" +
      "const srv = net.createServer();" +
      "let done = false;" +
      "const exit = (code) => { if (!done) { done = true; process.exit(code); } };" +
      "srv.once('error', (e) => exit(e && e.code === 'EADDRINUSE' ? 1 : 2));" +
      `srv.listen(${port}, '127.0.0.1', () => srv.close(() => exit(0)));`;
    const result = spawnSync(process.execPath, ["-e", script], {
      stdio: "ignore",
      timeout: 2_000,
    });
    return result.status === 1;
  } catch {
    return false;
  }
}

/**
 * Synchronous check whether a TCP port has an active listener on the host.
 *
 * Detection chain — any positive signal short-circuits:
 *   1. `lsof` — finds listeners owned by the current user.
 *   2. `sudo -n lsof` — catches root-owned listeners (e.g., docker-proxy on
 *      macOS) that the unprivileged lsof can't see. Silently no-ops when
 *      the user can't escalate non-interactively.
 *   3. Node `net` bind probe — authoritative fallback when both lsof
 *      invocations come up empty, mirroring the direct ForwardTcp bind.
 *
 * Returns false (optimistic) when every probe is inconclusive. The detached
 * OpenShell launch performs the final bind check.
 */
export function isPortBoundOnHost(port: number): boolean {
  try {
    const out: ReturnType<RunCaptureFn> = runCapture(
      ["lsof", "-i", `:${port}`, "-sTCP:LISTEN", "-P", "-n"],
      { ignoreError: true },
    );
    if (out && out.trim().length > 0) return true;
  } catch {
    /* fall through to the next probe */
  }

  try {
    const sudoOut: ReturnType<RunCaptureFn> = runCapture(
      ["sudo", "-n", "lsof", "-i", `:${port}`, "-sTCP:LISTEN", "-P", "-n"],
      { ignoreError: true },
    );
    if (sudoOut && sudoOut.trim().length > 0) return true;
  } catch {
    /* fall through to the bind probe */
  }

  return probePortBoundSync(port);
}

/**
 * Find the next available dashboard port for the given sandbox.
 * Returns the preferred port if free or already owned by this sandbox,
 * otherwise scans DASHBOARD_PORT_RANGE_START..END for a free port.
 * Validates host-port availability (via the proactive probe chain in
 * isPortBoundOnHost) so ports bound by non-OpenShell processes are
 * skipped (#3260).
 * Throws if the entire range is exhausted.
 *
 * `isPortBoundCheck` is an injectable seam for tests so they don't have
 * to spawn real lsof / Node probes; production callers leave it at the
 * default.
 */
export function findDashboardForwardOwner(
  forwardListOutput: string | null | undefined,
  portToStop: string,
): string | null {
  return getOccupiedPorts(forwardListOutput ?? null).get(portToStop) ?? null;
}

/**
 * Merge per-gateway forward-list occupancy with cross-gateway registry
 * occupancy. `openshell forward list` only reports forwards owned by the
 * currently selected gateway, so a second NemoClaw gateway on a different
 * `NEMOCLAW_GATEWAY_PORT` cannot see the first gateway's dashboard forwards
 * and would happily re-allocate the same dashboard port to a fresh sandbox.
 * The host-level bind probe also misses Docker-mediated forwards on macOS,
 * which is exactly the scenario reported on multi-instance hosts.
 *
 * The registry persists `dashboardPort` per sandbox. Allocation aggregates
 * the default registry plus bounded real directories under `gateways/*`, so
 * the view remains host-wide after gateway state becomes port-scoped. The
 * forward-list value still wins for sandboxes whose forward exists on the
 * currently selected gateway.
 */
function mergeOccupiedPorts(
  forwardOccupied: Map<string, string>,
  registryOccupied: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  if (!registryOccupied) return forwardOccupied;
  for (const [port, sandbox] of registryOccupied.entries()) {
    if (!forwardOccupied.has(port)) {
      forwardOccupied.set(port, sandbox);
    }
  }
  return forwardOccupied;
}

/** Host-wide registry view shared by the allocator and the persisted-port lookup. */
function listHostRegistrySandboxes(): { sandboxes: SandboxRegistryEntry[] } {
  return {
    sandboxes: listHostGatewayRegistryEntries(process.env.HOME || os.homedir()).map(
      ({ entry, gatewayPort }) => ({
        name: entry.name,
        dashboardPort: entry.dashboardPort,
        hermesApiPort: entry.hermesApiPort,
        scopeGatewayPort: gatewayPort,
      }),
    ),
  };
}

/**
 * Build a cross-gateway occupancy map (port → owning sandbox name) from the
 * persisted sandbox registries, excluding the current sandbox only in the
 * selected gateway scope. `openshell forward list` only knows about the
 * currently selected gateway's forwards, so a fresh onboard against a second
 * `NEMOCLAW_GATEWAY_PORT` gateway needs this host-wide view.
 *
 * Production enumeration is bounded and rejects symlinked, malformed, or
 * unreadable registry state. Errors propagate so the allocator fails closed
 * instead of silently handing out a colliding port.
 *
 * `listSandboxesFn` is an injectable seam for tests; production callers
 * leave it at the host-wide default.
 */
function getRegistryOccupiedPorts(
  currentSandboxName: string,
  selectPort: (entry: SandboxRegistryEntry) => number | null | undefined,
  listSandboxesFn?: ListSandboxesFn,
): Map<string, string> {
  const occupied = new Map<string, string>();
  const list = listSandboxesFn ?? listHostRegistrySandboxes;
  for (const entry of list().sandboxes) {
    if (
      entry.name === currentSandboxName &&
      (entry.scopeGatewayPort === undefined || entry.scopeGatewayPort === GATEWAY_PORT)
    )
      continue;
    const port = selectPort(entry);
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) continue;
    const owner =
      entry.scopeGatewayPort !== undefined && entry.scopeGatewayPort !== GATEWAY_PORT
        ? `${entry.name} (gateway ${String(entry.scopeGatewayPort)})`
        : entry.name;
    occupied.set(String(port), owner);
  }
  return occupied;
}

/**
 * Cross-gateway occupancy view for dashboard ports, keyed by port. See
 * {@link getRegistryOccupiedPorts} for why the registry supplements the
 * per-gateway forward list.
 */
export function getRegistryOccupiedDashboardPorts(
  currentSandboxName: string,
  listSandboxesFn?: ListSandboxesFn,
): Map<string, string> {
  return getRegistryOccupiedPorts(
    currentSandboxName,
    (entry) => entry.dashboardPort,
    listSandboxesFn,
  );
}

/**
 * Dashboard port recorded in the registry for one sandbox on the selected
 * gateway. The onboard resume path skips sandbox creation, which is the step
 * that normally publishes the created sandbox's port through `CHAT_UI_URL`,
 * so finalization re-reads the port that onboarding persisted (#8214).
 * Returns null when the entry has no positive integer port. (#8970)
 */
export function getPersistedDashboardPort(
  currentSandboxName: string,
  listSandboxesFn?: ListSandboxesFn,
): number | null {
  const list = listSandboxesFn ?? listHostRegistrySandboxes;
  for (const entry of list().sandboxes) {
    if (entry.name !== currentSandboxName) continue;
    if (entry.scopeGatewayPort !== undefined && entry.scopeGatewayPort !== GATEWAY_PORT) continue;
    const port = entry.dashboardPort;
    if (typeof port === "number" && Number.isInteger(port) && port > 0) return port;
  }
  return null;
}

/**
 * Cross-gateway occupancy view for Hermes API ports. The API forward is a
 * per-sandbox host resource just like the dashboard forward, so allocation
 * needs the same host-wide registry view that `openshell forward list` cannot
 * provide on its own.
 */
export function getRegistryOccupiedHermesApiPorts(
  currentSandboxName: string,
  listSandboxesFn?: ListSandboxesFn,
): Map<string, string> {
  return getRegistryOccupiedPorts(
    currentSandboxName,
    (entry) => entry.hermesApiPort,
    listSandboxesFn,
  );
}

/** A contiguous host-port range that one sandbox resource is allocated from. */
export interface HostPortRange {
  start: number;
  end: number;
  /** Names the resource in the range-exhausted error, e.g. "dashboard". */
  label: string;
  /** Operator remedy appended to the range-exhausted error. */
  remedy: string;
}

const DASHBOARD_RANGE: HostPortRange = {
  start: DASHBOARD_PORT_RANGE_START,
  end: DASHBOARD_PORT_RANGE_END,
  label: "dashboard",
  remedy: "Free a sandbox or use --control-ui-port <N> with a port outside this range.",
};

/**
 * Find the next available port in `range` for the given sandbox. Returns the
 * preferred port when it is free or already owned by this sandbox, otherwise
 * scans the range. Shared by the dashboard allocator and the Hermes API-port
 * allocator so both apply the same forward-list, registry, and host-bind view.
 */
export function findAvailablePortInRange(
  sandboxName: string,
  preferredPort: number,
  forwardListOutput: string | null,
  range: HostPortRange,
  isPortBoundCheck: (port: number) => boolean = isPortBoundOnHost,
  registryOccupiedPorts: ReadonlyMap<string, string> = new Map(),
): number {
  const occupied = mergeOccupiedPorts(getOccupiedPorts(forwardListOutput), registryOccupiedPorts);
  const hostBoundPorts: number[] = [];
  // Try the preferred port first (it may be outside the range when a caller
  // passes --control-ui-port), then the rest of the range. Each port is probed
  // at most once so we don't pay for `lsof` + `sudo lsof` + Node bind multiple
  // times per port.
  const portsToScan = [
    preferredPort,
    ...Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i).filter(
      (p) => p !== preferredPort,
    ),
  ];
  for (const p of portsToScan) {
    const pStr = String(p);
    const pOwner = occupied.get(pStr) ?? null;
    if (pOwner === sandboxName) return p;
    if (pOwner === null) {
      if (!isPortBoundCheck(p)) return p;
      hostBoundPorts.push(p);
    }
  }

  const ownerLines = [...occupied.entries()]
    .filter(([p]) => Number(p) >= range.start && Number(p) <= range.end)
    .map(([p, s]) => `  ${p} → ${s}`);
  const hostLines = hostBoundPorts
    .filter((p) => p >= range.start && p <= range.end)
    .map((p) => `  ${p} → non-OpenShell host listener`);
  const lines = [...ownerLines, ...hostLines].join("\n");
  throw new Error(
    `All ${range.label} ports in range ${range.start}-${range.end} are occupied:\n${lines}\n` +
      range.remedy,
  );
}

export function findAvailableDashboardPort(
  sandboxName: string,
  preferredPort: number,
  forwardListOutput: string | null,
  isPortBoundCheck: (port: number) => boolean = isPortBoundOnHost,
  // Default to an empty map so unit tests of this allocator do not become
  // dependent on whatever sandboxes happen to live in the caller's real
  // `~/.nemoclaw/sandboxes.json`. Production wrappers
  // (`resolveCreateSandboxDashboardPort`, `ensureDashboardForward`) pass an
  // explicit `getRegistryOccupiedDashboardPorts(sandboxName)` result.
  registryOccupiedPorts: ReadonlyMap<string, string> = new Map(),
): number {
  return findAvailablePortInRange(
    sandboxName,
    preferredPort,
    forwardListOutput,
    DASHBOARD_RANGE,
    isPortBoundCheck,
    registryOccupiedPorts,
  );
}

export interface CreateSandboxDashboardPortInput {
  sandboxName: string;
  controlUiPort: number | null;
  chatUiUrlEnv: string | null | undefined;
  persistedPort: number | null;
  agentForwardPort: number | null | undefined;
  forwardListOutput: string | null;
  defaultPort?: number;
  findAvailablePort?: typeof findAvailableDashboardPort;
  warn?: (message: string) => void;
  // Cross-gateway occupancy view derived from the sandbox registry. Lets the
  // allocator avoid handing out a dashboard port that already belongs to a
  // sandbox on a different `NEMOCLAW_GATEWAY_PORT`, which the per-gateway
  // forward-list view cannot see.
  registryOccupiedPorts?: ReadonlyMap<string, string>;
}

export interface CreateSandboxDashboardPortResult {
  preferredPort: number;
  effectivePort: number;
  chatUiUrl: string;
}

export interface DashboardPortReservation {
  port: number;
  release(): Promise<void>;
}

export interface DashboardPortReservationScope {
  current: DashboardPortReservation | null;
  release(): Promise<void>;
}

export interface ReservedCreateSandboxDashboardPortResult extends CreateSandboxDashboardPortResult {
  reservation: DashboardPortReservation | null;
}

function normalizeChatUiUrlForParsing(chatUiUrl: string): string {
  return chatUiUrl.includes("://") ? chatUiUrl : `http://${chatUiUrl}`;
}

function parseChatUiUrlPort(chatUiUrlEnv: string | null | undefined): number | null {
  if (!chatUiUrlEnv) return null;
  try {
    const parsed = new URL(normalizeChatUiUrlForParsing(chatUiUrlEnv));
    const port = Number(parsed.port);
    return port > 0 ? port : null;
  } catch {
    return null;
  }
}

function buildCreateSandboxChatUiUrl(
  chatUiUrlEnv: string | null | undefined,
  controlUiPort: number | null,
  effectivePort: number,
): string {
  if (chatUiUrlEnv && controlUiPort == null) {
    try {
      const parsed = new URL(normalizeChatUiUrlForParsing(chatUiUrlEnv));
      parsed.port = String(effectivePort);
      return parsed.toString().replace(/\/$/, "");
    } catch {
      /* malformed URL - keep the local default */
    }
  }
  return `http://127.0.0.1:${effectivePort}`;
}

export function resolveCreateSandboxDashboardPort(
  input: CreateSandboxDashboardPortInput,
): CreateSandboxDashboardPortResult {
  const preferredPort =
    input.controlUiPort ??
    parseChatUiUrlPort(input.chatUiUrlEnv) ??
    input.persistedPort ??
    input.agentForwardPort ??
    input.defaultPort ??
    DASHBOARD_PORT;
  // When a caller does not supply an explicit cross-gateway view, read the
  // persisted registry here so the allocator never silently hands out a
  // dashboard port that already belongs to a sibling sandbox on a different
  // NemoClaw gateway. The allocator itself defaults to an empty map to keep
  // its unit tests independent of the caller's real `~/.nemoclaw/` state.
  const registryOccupiedPorts =
    input.registryOccupiedPorts ?? getRegistryOccupiedDashboardPorts(input.sandboxName);
  const effectivePort = (input.findAvailablePort ?? findAvailableDashboardPort)(
    input.sandboxName,
    preferredPort,
    input.forwardListOutput,
    undefined,
    registryOccupiedPorts,
  );
  if (effectivePort !== preferredPort) {
    input.warn?.(`  ! Port ${preferredPort} is taken. Using port ${effectivePort} instead.`);
  }
  return {
    preferredPort,
    effectivePort,
    chatUiUrl: buildCreateSandboxChatUiUrl(input.chatUiUrlEnv, input.controlUiPort, effectivePort),
  };
}

/**
 * Bind the selected host port until sandbox creation can start its OpenShell
 * forward. The server closes attempted connections and does not keep the
 * process alive. The reservation closes on normal release or process exit.
 */
export async function reserveDashboardPort(port: number): Promise<DashboardPortReservation> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
  server.unref();

  let released = false;
  const closeOnExit = () => {
    if (server.listening) server.close();
  };
  process.once("exit", closeOnExit);

  return {
    port,
    async release() {
      if (released) return;
      released = true;
      process.removeListener("exit", closeOnExit);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "EADDRINUSE";
}

/**
 * Select and bind a dashboard port before sandbox preparation begins. If a
 * listener wins the gap between the allocation probe and bind, classify that
 * port as occupied and select again before any sandbox side effect.
 *
 * A live forward owned by the target sandbox already holds its port while the
 * caller decides whether to reuse or recreate that sandbox.
 */
export async function reserveCreateSandboxDashboardPort(
  input: CreateSandboxDashboardPortInput,
  reservePort: (port: number) => Promise<DashboardPortReservation> = reserveDashboardPort,
): Promise<ReservedCreateSandboxDashboardPortResult> {
  const occupied = new Map(
    input.registryOccupiedPorts ?? getRegistryOccupiedDashboardPorts(input.sandboxName),
  );
  const forwardOwner = getOccupiedPorts(input.forwardListOutput);
  while (true) {
    const result = resolveCreateSandboxDashboardPort({
      ...input,
      registryOccupiedPorts: occupied,
      warn: undefined,
    });
    if (forwardOwner.get(String(result.effectivePort)) === input.sandboxName) {
      if (result.effectivePort !== result.preferredPort) {
        input.warn?.(
          `  ! Port ${result.preferredPort} is taken. Using port ${result.effectivePort} instead.`,
        );
      }
      return { ...result, reservation: null };
    }
    try {
      const reservation = await reservePort(result.effectivePort);
      if (result.effectivePort !== result.preferredPort) {
        input.warn?.(
          `  ! Port ${result.preferredPort} is taken. Using port ${result.effectivePort} instead.`,
        );
      }
      return { ...result, reservation };
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      occupied.set(String(result.effectivePort), "non-OpenShell host listener");
    }
  }
}

/** Release a dashboard reservation after both successful and failed creation. */
export async function withDashboardPortReservationScope<T>(
  operation: (scope: DashboardPortReservationScope) => Promise<T>,
): Promise<T> {
  const scope: DashboardPortReservationScope = {
    current: null,
    release: async () => {
      const reservation = scope.current;
      scope.current = null;
      await reservation?.release();
    },
  };
  try {
    return await operation(scope);
  } finally {
    await scope.release();
  }
}

interface DashboardPortScopedSandboxEntryPointDeps<
  Args extends unknown[],
  Result,
  BaseImageResolutionContext,
  PortableRuntimeContext,
  ComputePlan,
> {
  createBaseImageResolutionContext(): BaseImageResolutionContext;
  createSandboxWithBaseImageResolution(
    baseImageResolutionContext: BaseImageResolutionContext,
    portableRuntimeContext: PortableRuntimeContext,
    computePlan: ComputePlan,
    managedWorkloadRebuild: null,
    temporaryManagedRuntime: boolean,
    temporaryManagedRuntimeCatalog: null,
    dashboardPortReservationScope: DashboardPortReservationScope,
    ...args: Args
  ): Promise<Result>;
  resolvePortableRuntimeContext(): PortableRuntimeContext;
  resolveComputePlan(): ComputePlan;
}

export function createDashboardPortScopedSandboxEntryPoints<
  Args extends unknown[],
  Result,
  BaseImageResolutionContext,
  PortableRuntimeContext,
  ComputePlan,
>(
  deps: DashboardPortScopedSandboxEntryPointDeps<
    Args,
    Result,
    BaseImageResolutionContext,
    PortableRuntimeContext,
    ComputePlan
  >,
): {
  createSandbox: (...args: Args) => Promise<Result>;
  createSandboxWithTemporaryManagedRuntime: (...args: Args) => Promise<Result>;
} {
  const create = async (temporaryManagedRuntime: boolean, args: Args): Promise<Result> => {
    const computePlan = deps.resolveComputePlan();
    return withDashboardPortReservationScope((dashboardPortReservationScope) =>
      deps.createSandboxWithBaseImageResolution(
        deps.createBaseImageResolutionContext(),
        deps.resolvePortableRuntimeContext(),
        computePlan,
        null,
        temporaryManagedRuntime,
        null,
        dashboardPortReservationScope,
        ...args,
      ),
    );
  };

  return {
    createSandbox: (...args) => create(false, args),
    createSandboxWithTemporaryManagedRuntime: (...args) => create(true, args),
  };
}

/**
 * Preflight scan of the dashboard port range. If every port in
 * [DASHBOARD_PORT_RANGE_START, DASHBOARD_PORT_RANGE_END] is bound on
 * the host, print the same "All dashboard ports in range … are
 * occupied" error that `findAvailableDashboardPort` would eventually
 * raise during sandbox creation and exit non-zero. Calling this from
 * `preflight()` surfaces the failure before any side effects (gateway
 * start, inference setup), matching the contract reporters expect
 * (#3953).
 *
 * Intentionally narrower than `findAvailableDashboardPort`: it does not
 * consult OpenShell forward state, never reserves a port, and treats
 * every bound port as a non-OpenShell listener. That is sound here —
 * if every port is bound, the host either has no free port for a new
 * sandbox OR every port already serves an existing sandbox dashboard;
 * both cases require operator intervention via `--control-ui-port`.
 *
 * The `exitFn` and `isPortBoundCheck` parameters are dependency
 * injection seams for unit tests; production callers use the defaults.
 */
export function preflightDashboardPortRangeAvailability(
  isPortBoundCheck: (port: number) => boolean = isPortBoundOnHost,
  exitFn: (code?: number) => never = process.exit as (code?: number) => never,
): void {
  const ports = Array.from(
    { length: DASHBOARD_PORT_RANGE_END - DASHBOARD_PORT_RANGE_START + 1 },
    (_, i) => DASHBOARD_PORT_RANGE_START + i,
  );
  const bound: number[] = [];
  for (const p of ports) {
    if (!isPortBoundCheck(p)) return;
    bound.push(p);
  }
  const lines = bound.map((p) => `  ${p} → non-OpenShell host listener`).join("\n");
  console.error(
    `  All dashboard ports in range ${DASHBOARD_PORT_RANGE_START}-${DASHBOARD_PORT_RANGE_END} are occupied:\n${lines}\n` +
      `  Free a sandbox or use --control-ui-port <N> with a port outside this range.`,
  );
  exitFn(1);
}
