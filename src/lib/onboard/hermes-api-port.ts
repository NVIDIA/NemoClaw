// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HERMES_API_PORT_RANGE_END,
  HERMES_API_PORT_RANGE_START,
  HERMES_OPENAI_API_PORT,
} from "../core/ports";
import * as registry from "../state/registry";
import {
  findAvailablePortInRange,
  getRegistryOccupiedHermesApiPorts,
  type HostPortRange,
  isPortBoundOnHost,
  type ListSandboxesFn,
} from "./dashboard-port";

export const HERMES_API_PORT_ENV = "NEMOCLAW_HERMES_API_PORT";

const HERMES_API_RANGE: HostPortRange = {
  start: HERMES_API_PORT_RANGE_START,
  end: HERMES_API_PORT_RANGE_END,
  label: "Hermes API",
  remedy: `Free a sandbox or set ${HERMES_API_PORT_ENV}=<N> with a port outside this range.`,
};

export function isValidHermesApiPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
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
      `Invalid port: ${HERMES_API_PORT_ENV}="${raw}" must be an integer between 1024 and 65535`,
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
 * Resolve the API port for an onboarding sandbox and publish it to the
 * environment so every later consumer in the same run agrees on one value.
 *
 * Onboarding resolves this port in three places that never see each other's
 * result: the sandbox-create environment, the registry row, and the host
 * forward. Publishing through the environment is how the dashboard port already
 * reaches its later consumers (`ensureAgentDashboardForward` writes
 * `CHAT_UI_URL`), and it carries the value into the sandbox without threading
 * an argument through the onboarding entrypoint.
 *
 * Precedence matches `resolveCreateSandboxDashboardPort`: an explicit operator
 * value wins, then the sandbox's registered value, then a fresh allocation.
 */
/**
 * Retarget a manifest-derived URL at the sandbox's own API port.
 *
 * Manifest URLs name the agent's default port. A probe that runs inside a
 * sandbox whose relay listens elsewhere would otherwise report the default
 * port as unreachable, or reach a sibling sandbox's relay through the host.
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

export function resolveOnboardHermesApiPort(
  sandboxName: string,
  options: {
    env?: NodeJS.ProcessEnv;
    getSandbox?: (name: string) => { hermesApiPort?: number | null } | undefined;
    forwardListOutput?: string | null;
    findAvailablePort?: typeof findAvailableHermesApiPort;
    warn?: (message: string) => void;
  } = {},
): number {
  const env = options.env ?? process.env;
  const requested = readHermesApiPort(env);
  const publish = (port: number): number => {
    env[HERMES_API_PORT_ENV] = String(port);
    return port;
  };
  if (env[HERMES_API_PORT_ENV]?.trim()) return publish(requested);
  const registeredPort = (options.getSandbox ?? registry.getSandbox)(sandboxName)?.hermesApiPort;
  if (isValidHermesApiPort(registeredPort)) return publish(registeredPort);
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
