// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HERMES_API_PORT_RANGE_END,
  HERMES_API_PORT_RANGE_START,
  HERMES_OPENAI_API_PORT,
  isHermesApiPort,
} from "../core/ports";
import * as registry from "../state/registry";
import {
  createDashboardPortScopedSandboxEntryPoints,
  type DashboardPortReservation,
  type DashboardPortReservationScope,
  findAvailablePortInRange,
  getOccupiedPorts,
  getRegistryOccupiedHermesApiPorts,
  type HostPortRange,
  isPortBoundOnHost,
  type ListSandboxesFn,
  reserveDashboardPort,
} from "./dashboard-port";

export const HERMES_API_PORT_ENV = "NEMOCLAW_HERMES_API_PORT";

/** Registry fields the Hermes API-port allocator reads for identity vs allocation. */
export type HermesApiPortSandboxLookup = {
  hermesApiPort?: number | null;
  pendingRouteReservation?: true;
  createdAt?: string;
};

/**
 * Durable sandboxes keep a recorded (or legacy-default) API port. A route-only
 * inference reservation is only a pre-create lock and must not pin the default
 * port before allocation runs (#9291).
 */
function durableHermesApiPortSandbox(
  registered: HermesApiPortSandboxLookup | null | undefined,
): HermesApiPortSandboxLookup | null {
  if (registered == null || registry.isRouteOnlySandboxReservation(registered)) {
    return null;
  }
  return registered;
}

export interface HermesApiPortReservationInput {
  agentName?: string | null;
  sandboxName: string;
  env: NodeJS.ProcessEnv;
  getSandbox(name: string): HermesApiPortSandboxLookup | null | undefined;
  captureForwardList(): string | null;
  reservePort?(port: number): Promise<DashboardPortReservation>;
  warn(message: string): void;
}

export interface HermesApiPortReservationScope {
  current: DashboardPortReservation | null;
  effectivePort: number | null;
  selectAndReserve(input: HermesApiPortReservationInput): Promise<void>;
  rebindAfterOwnedForwardDelete(input: HermesApiPortReservationInput): Promise<void>;
  releaseBeforeForward(agentName: string, port: number): Promise<void>;
  release(): Promise<void>;
}

export interface ReservedCreateSandboxHermesApiPortResult {
  effectivePort: number;
  reservation: DashboardPortReservation | null;
}

interface HermesApiPortScopedSandboxEntryPointDeps<
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
    hermesApiPortReservationScope: HermesApiPortReservationScope,
    ...args: Args
  ): Promise<Result>;
  resolvePortableRuntimeContext(): PortableRuntimeContext;
  resolveComputePlan(): ComputePlan;
}

/** Compose dashboard and Hermes API port ownership around sandbox creation. */
export function createHermesApiPortScopedSandboxEntryPoints<
  Args extends unknown[],
  Result,
  BaseImageResolutionContext,
  PortableRuntimeContext,
  ComputePlan,
>(
  deps: HermesApiPortScopedSandboxEntryPointDeps<
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
  return createDashboardPortScopedSandboxEntryPoints({
    createBaseImageResolutionContext: deps.createBaseImageResolutionContext,
    createSandboxWithBaseImageResolution: (
      baseImageResolutionContext,
      portableRuntimeContext,
      computePlan,
      managedWorkloadRebuild,
      temporaryManagedRuntime,
      temporaryManagedRuntimeCatalog,
      dashboardPortReservationScope,
      ...args
    ) =>
      withHermesApiPortReservationScope((hermesApiPortReservationScope) =>
        deps.createSandboxWithBaseImageResolution(
          baseImageResolutionContext,
          portableRuntimeContext,
          computePlan,
          managedWorkloadRebuild,
          temporaryManagedRuntime,
          temporaryManagedRuntimeCatalog,
          dashboardPortReservationScope,
          hermesApiPortReservationScope,
          ...args,
        ),
      ),
    resolveComputePlan: deps.resolveComputePlan,
    resolvePortableRuntimeContext: deps.resolvePortableRuntimeContext,
  });
}

const HERMES_API_RANGE: HostPortRange = {
  start: HERMES_API_PORT_RANGE_START,
  end: HERMES_API_PORT_RANGE_END,
  label: "Hermes API",
  remedy:
    "Destroy a listed Hermes sandbox or stop a listed non-OpenShell listener, then rerun onboarding.",
};

export function isValidHermesApiPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && isHermesApiPort(value);
}

/**
 * Read the requested Hermes API port from the environment, falling back to the
 * range start. The sandbox exposes its OpenAI-compatible API on this port, and
 * the host forward uses the same number, so the value has to survive from
 * allocation through sandbox create into `start.sh`.
 */
export function readHermesApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[HERMES_API_PORT_ENV];
  if (raw === undefined || raw.trim() === "") return HERMES_OPENAI_API_PORT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || !isValidHermesApiPort(Number(trimmed))) {
    throw new Error(
      `Invalid port: ${HERMES_API_PORT_ENV}="${raw}" must be an integer from 8642 through 8652`,
    );
  }
  return Number(trimmed);
}

export function findAvailableHermesApiPort(
  sandboxName: string,
  preferredPort: number = HERMES_OPENAI_API_PORT,
  forwardListOutput: string | null = null,
  isPortBoundCheck: (port: number) => boolean = isPortBoundOnHost,
  registryOccupiedPorts?: ReadonlyMap<string, string>,
  listSandboxesFn?: ListSandboxesFn,
): number {
  return findAvailablePortInRange(
    sandboxName,
    preferredPort,
    forwardListOutput,
    HERMES_API_RANGE,
    isPortBoundCheck,
    registryOccupiedPorts ?? getRegistryOccupiedHermesApiPorts(sandboxName, listSandboxesFn),
  );
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "EADDRINUSE";
}

/**
 * Select and bind the Hermes API port before sandbox preparation begins.
 *
 * The host-wide lifecycle lock serializes NemoClaw allocators until registry
 * publication. This reservation also closes the gap against unrelated host
 * listeners and keeps the selected port owned until the host-forward handoff.
 */
export async function reserveCreateSandboxHermesApiPort(options: {
  sandboxName: string;
  env?: NodeJS.ProcessEnv;
  getSandbox?: (name: string) => HermesApiPortSandboxLookup | null | undefined;
  allowRegisteredOverride?: boolean;
  forwardListOutput?: string | null;
  isPortBoundCheck?: (port: number) => boolean;
  registryOccupiedPorts?: ReadonlyMap<string, string>;
  reservePort?: (port: number) => Promise<DashboardPortReservation>;
  warn?: (message: string) => void;
}): Promise<ReservedCreateSandboxHermesApiPortResult> {
  const env = options.env ?? process.env;
  const getSandbox = options.getSandbox ?? registry.getSandbox;
  const registered = durableHermesApiPortSandbox(getSandbox(options.sandboxName));
  const hasRequestedPort = Boolean(env[HERMES_API_PORT_ENV]?.trim());
  const forwardListOutput = options.forwardListOutput ?? null;
  const forwardOwners = getOccupiedPorts(forwardListOutput);
  const reservePort = options.reservePort ?? reserveDashboardPort;
  const reserveSelectedPort = async (
    effectivePort: number,
  ): Promise<ReservedCreateSandboxHermesApiPortResult> => {
    if (forwardOwners.get(String(effectivePort)) === options.sandboxName) {
      return { effectivePort, reservation: null };
    }
    return { effectivePort, reservation: await reservePort(effectivePort) };
  };

  // Explicit and durable registered ports pin the sandbox endpoint, not
  // allocation hints. Preserve them and report a bind collision instead of
  // silently changing the sandbox's configured endpoint. Route-only inference
  // reservations are not a durable sandbox and must allocate like an
  // unregistered name (#9291).
  if (hasRequestedPort || registered) {
    const effectivePort = resolveOnboardHermesApiPort(options.sandboxName, {
      env,
      getSandbox,
      allowRegisteredOverride: options.allowRegisteredOverride,
      forwardListOutput,
    });
    return reserveSelectedPort(effectivePort);
  }

  const occupied = new Map(
    options.registryOccupiedPorts ?? getRegistryOccupiedHermesApiPorts(options.sandboxName),
  );
  while (true) {
    const effectivePort = findAvailableHermesApiPort(
      options.sandboxName,
      HERMES_OPENAI_API_PORT,
      forwardListOutput,
      options.isPortBoundCheck ?? isPortBoundOnHost,
      occupied,
    );
    try {
      const result = await reserveSelectedPort(effectivePort);
      env[HERMES_API_PORT_ENV] = String(effectivePort);
      if (effectivePort !== HERMES_OPENAI_API_PORT) {
        options.warn?.(
          `  ! Port ${HERMES_OPENAI_API_PORT} is taken. Using port ${effectivePort} instead.`,
        );
      }
      return result;
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      occupied.set(String(effectivePort), "non-OpenShell host listener");
    }
  }
}

export function createHermesApiPortReservationScope(): HermesApiPortReservationScope {
  return {
    current: null,
    effectivePort: null,
    async selectAndReserve(input) {
      if (input.agentName !== "hermes") return;
      const selection = await reserveCreateSandboxHermesApiPort({
        sandboxName: input.sandboxName,
        env: input.env,
        getSandbox: input.getSandbox,
        allowRegisteredOverride: true,
        forwardListOutput: input.captureForwardList(),
        reservePort: input.reservePort,
        warn: input.warn,
      });
      this.effectivePort = selection.effectivePort;
      this.current = selection.reservation;
    },
    async rebindAfterOwnedForwardDelete(input) {
      if (input.agentName !== "hermes" || this.current !== null) return;
      await this.selectAndReserve({ ...input, captureForwardList: () => "" });
    },
    async releaseBeforeForward(agentName, port) {
      if (agentName === "hermes" && this.current?.port === port) await this.release();
    },
    async release() {
      const reservation = this.current;
      this.current = null;
      await reservation?.release();
    },
  };
}

/** Release a Hermes API-port reservation after both successful and failed onboarding. */
export async function withHermesApiPortReservationScope<T>(
  operation: (scope: HermesApiPortReservationScope) => Promise<T>,
): Promise<T> {
  const scope = createHermesApiPortReservationScope();
  try {
    return await operation(scope);
  } finally {
    await scope.release();
  }
}

/**
 * Resolve the API port a sandbox actually uses. Sandboxes registered before the
 * port became per-sandbox carry no value and keep the default, which is also
 * what `start.sh` falls back to when the environment does not carry one.
 */
export function resolveSandboxHermesApiPort(sandbox: { hermesApiPort?: number | null }): number {
  return isValidHermesApiPort(sandbox.hermesApiPort)
    ? sandbox.hermesApiPort
    : HERMES_OPENAI_API_PORT;
}

/**
 * Retarget a manifest-derived URL at the sandbox's own API port.
 *
 * Manifest URLs name the agent's default port. A probe that runs inside a
 * sandbox whose relay listens elsewhere would otherwise target an unused port
 * that the sandbox user can bind, instead of the port the relay listens on.
 * Only the default port is rewritten, so a manifest that already names a
 * different port is left alone.
 */
export function retargetHermesApiPortInUrl(url: string, apiPort: number): string {
  if (apiPort === HERMES_OPENAI_API_PORT || !isValidHermesApiPort(apiPort)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.port !== String(HERMES_OPENAI_API_PORT)) return url;
  parsed.port = String(apiPort);
  return parsed.toString();
}

/**
 * Resolve the API port for a sandbox and publish it to the environment so every
 * later consumer in the same run agrees on one value.
 *
 * Onboarding resolves this port in places that never see each other's result:
 * the sandbox-create environment, the registry row, the host forward, and the
 * ready summary. Publishing through the environment is how the dashboard port
 * already reaches its later consumers (`ensureAgentDashboardForward` writes
 * `CHAT_UI_URL`), and it carries the value into the sandbox without threading an
 * argument through the onboarding entrypoint. The ready summary instead reads
 * the registry, which is equivalent because registration precedes it.
 *
 * An existing durable sandbox keeps its recorded port unless the caller is the
 * actual create/recreate or created-sandbox registration boundary. Other
 * consumers reject a conflicting explicit value before they mutate a host
 * forward. A durable registered sandbox without a port predates this feature
 * and already runs on the default. A route-only inference reservation is not a
 * durable sandbox and must allocate like an unregistered name (#9291).
 *
 * A recreate keeps its source row, so its create and registration boundaries
 * may apply an explicit value. Without an explicit value, it preserves the
 * recorded port.
 */
export function resolveOnboardHermesApiPort(
  sandboxName: string,
  options: {
    env?: NodeJS.ProcessEnv;
    getSandbox?: (name: string) => HermesApiPortSandboxLookup | null | undefined;
    allowRegisteredOverride?: boolean;
    forwardListOutput?: string | null;
    findAvailablePort?: typeof findAvailableHermesApiPort;
    warn?: (message: string) => void;
  } = {},
): number {
  const env = options.env ?? process.env;
  const hasRequestedPort = Boolean(env[HERMES_API_PORT_ENV]?.trim());
  const requested = readHermesApiPort(env);
  const publish = (port: number): number => {
    env[HERMES_API_PORT_ENV] = String(port);
    return port;
  };
  const registered = durableHermesApiPortSandbox(
    (options.getSandbox ?? registry.getSandbox)(sandboxName),
  );
  if (registered) {
    const registeredPort = resolveSandboxHermesApiPort(registered);
    if (
      hasRequestedPort &&
      requested !== registeredPort &&
      options.allowRegisteredOverride !== true
    ) {
      throw new Error(
        `${HERMES_API_PORT_ENV}=${requested} conflicts with sandbox "${sandboxName}", which serves its OpenAI-compatible API on port ${registeredPort}. Rerun onboarding with --recreate-sandbox to apply a different port.`,
      );
    }
    return publish(hasRequestedPort ? requested : registeredPort);
  }
  if (hasRequestedPort) return publish(requested);
  const port = (options.findAvailablePort ?? findAvailableHermesApiPort)(
    sandboxName,
    HERMES_OPENAI_API_PORT,
    options.forwardListOutput ?? null,
  );
  if (port !== HERMES_OPENAI_API_PORT) {
    options.warn?.(`  ! Port ${HERMES_OPENAI_API_PORT} is taken. Using port ${port} instead.`);
  }
  return publish(port);
}

/**
 * Resolve the API port deployment verification must probe for `agent`.
 *
 * Returns the agent's declared health-probe port, except for Hermes, whose
 * per-sandbox allocation from the 8642-8652 range means the manifest default
 * would name a sibling sandbox's port. Returns undefined when the agent
 * declares no health-probe port, which leaves `buildChain` on its dashboard-port
 * fallback so agents without a separate API surface keep their existing single
 * host probe (#9290).
 */
export function resolveVerifyAgentApiPort(
  sandboxName: string,
  agent: { name?: string; healthProbe?: { port?: number } | null } | null | undefined,
  options: {
    getSandbox?: (name: string) => { hermesApiPort?: number | null } | null | undefined;
  } = {},
): number | undefined {
  const declared = agent?.healthProbe?.port;
  if (!Number.isInteger(declared)) return undefined;
  if (agent?.name !== "hermes" || declared !== HERMES_OPENAI_API_PORT) return declared;
  const getSandbox = options.getSandbox ?? registry.getSandbox;
  return resolveSandboxHermesApiPort(getSandbox(sandboxName) ?? {});
}
