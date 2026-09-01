// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isHermesApiPort } from "../core/ports";
import {
  HERMES_DASHBOARD_ENABLE_ENV,
  HERMES_DASHBOARD_INTERNAL_PORT_ENV,
  HERMES_DASHBOARD_PORT_ENV,
  HERMES_DASHBOARD_TUI_ENV,
  type HermesDashboardConfig,
  readHermesDashboardConfig,
} from "../hermes-dashboard";
import type { SandboxEntry } from "../state/registry";
import { reservedHermesDashboardPortMessage } from "./preflight-ports";

export interface HermesDashboardOnboardState {
  config: HermesDashboardConfig | null;
  enabled: boolean;
}

type RunOpenshell = (args: string[], options: { ignoreError: true }) => unknown;
type RevalidateSandboxIdentity = (operation: string) => void;
type EnsureForward = (
  sandboxName: string,
  port: number,
  label: string,
  revalidateSandboxIdentity?: RevalidateSandboxIdentity,
) => boolean;

export function resolveHermesDashboardOnboardState({
  agentName,
  effectivePort,
  env,
  fail,
}: {
  agentName: string | null | undefined;
  effectivePort: number;
  env: NodeJS.ProcessEnv;
  fail?: (message: string) => never;
}): HermesDashboardOnboardState {
  // #4984 — reject a reserved Hermes API port as the dashboard port for ANY
  // agent, before any sandbox is built. Every port in the API range is reserved
  // because each Hermes sandbox allocates its own from that range. Check both
  // the resolved effectivePort (covers --control-ui-port / CHAT_UI_URL /
  // persisted) and the raw env override, which the host otherwise silently
  // drops so effectivePort never shows it. This host guard rejects the whole
  // API range; agents/hermes/start.sh rejects only this sandbox's resolved port.
  const rawDashboardPort = env.NEMOCLAW_DASHBOARD_PORT?.trim();
  const requestedDashboardPort = rawDashboardPort ? Number(rawDashboardPort) : undefined;
  const reservedPort = [effectivePort, requestedDashboardPort].find(
    (port): port is number => port !== undefined && isHermesApiPort(port),
  );
  if (reservedPort !== undefined) {
    const message = reservedHermesDashboardPortMessage(reservedPort);
    if (fail) return fail(message);
    throw new Error(message);
  }

  if (agentName !== "hermes") return { config: null, enabled: false };

  let config: HermesDashboardConfig;
  try {
    config = readHermesDashboardConfig(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (fail) return fail(message);
    throw error;
  }

  if (config.enabled) {
    const rawHermesDashboardPort = env[HERMES_DASHBOARD_PORT_ENV]?.trim();
    if (rawHermesDashboardPort && config.port !== effectivePort) {
      const message = `${HERMES_DASHBOARD_PORT_ENV} must match the NemoClaw dashboard port (${effectivePort}). Set NEMOCLAW_DASHBOARD_PORT or pass --control-ui-port <N> to change the Hermes WebUI port.`;
      if (fail) return fail(message);
      throw new Error(message);
    }
    config = { ...config, port: effectivePort };
    if (config.port === config.internalPort) {
      const message = `${HERMES_DASHBOARD_INTERNAL_PORT_ENV} must not equal the Hermes WebUI port (${config.port}).`;
      if (fail) return fail(message);
      throw new Error(message);
    }
  }

  return { config, enabled: config.enabled === true };
}

export function getHermesDashboardRegistryFields(
  state: HermesDashboardOnboardState,
): Partial<SandboxEntry> {
  if (!state.enabled || !state.config) {
    return {
      hermesDashboardEnabled: undefined,
      hermesDashboardPort: undefined,
      hermesDashboardInternalPort: undefined,
      hermesDashboardTui: undefined,
    };
  }
  return {
    hermesDashboardEnabled: true,
    hermesDashboardPort: state.config.port,
    hermesDashboardInternalPort: state.config.internalPort,
    hermesDashboardTui: state.config.tuiEnabled ? true : undefined,
  };
}

export function hasHermesDashboardDrift({
  agentName,
  existing,
  state,
}: {
  agentName: string | null | undefined;
  existing: SandboxEntry | null | undefined;
  state: HermesDashboardOnboardState;
}): boolean {
  if (agentName !== "hermes") return false;
  const recordedEnabled = existing?.hermesDashboardEnabled === true;
  if (recordedEnabled !== state.enabled) return true;
  if (!state.enabled || !state.config) return false;
  return (
    existing?.hermesDashboardPort !== state.config.port ||
    existing?.hermesDashboardInternalPort !== state.config.internalPort ||
    (existing?.hermesDashboardTui === true) !== state.config.tuiEnabled
  );
}

export function appendHermesDashboardEnvArgs(
  envArgs: string[],
  state: HermesDashboardOnboardState,
  formatEnvAssignment: (name: string, value: string) => string,
): void {
  if (!state.enabled || !state.config) return;
  envArgs.push(formatEnvAssignment(HERMES_DASHBOARD_ENABLE_ENV, "1"));
  envArgs.push(formatEnvAssignment(HERMES_DASHBOARD_PORT_ENV, String(state.config.port)));
  envArgs.push(
    formatEnvAssignment(HERMES_DASHBOARD_INTERNAL_PORT_ENV, String(state.config.internalPort)),
  );
  if (state.config.tuiEnabled) {
    envArgs.push(formatEnvAssignment(HERMES_DASHBOARD_TUI_ENV, "1"));
  }
}

export function ensureHermesDashboardForwardIfEnabled({
  state,
  sandboxName,
  ensureForward,
  note,
  revalidateSandboxIdentity,
}: {
  state: HermesDashboardOnboardState;
  sandboxName: string;
  ensureForward: EnsureForward;
  note: (message: string) => void;
  revalidateSandboxIdentity?: RevalidateSandboxIdentity;
}): boolean {
  if (!state.enabled || !state.config) return true;
  if (
    !ensureForward(sandboxName, state.config.port, "Hermes dashboard", revalidateSandboxIdentity)
  ) {
    return false;
  }
  revalidateSandboxIdentity?.(`report Hermes dashboard forward for sandbox '${sandboxName}'`);
  note(`  ✓ Hermes dashboard forwarded at http://127.0.0.1:${state.config.port}/`);
  return true;
}

export function formatHermesDashboardForwardFailure(state: HermesDashboardOnboardState): string {
  const port = state.config?.port ?? "unknown";
  return `Failed to start Hermes dashboard forward on port ${port}. NemoClaw left the sandbox and any established OpenShell service forwards running. Free the port and re-run onboarding, set NEMOCLAW_DASHBOARD_PORT, or pass --control-ui-port <N> to choose another port.`;
}

export function createHermesDashboardForwardEnsurer({
  state,
  ensureForward,
  note,
  rollbackSandbox,
  fail,
}: {
  state: HermesDashboardOnboardState;
  ensureForward: EnsureForward;
  note: (message: string) => void;
  rollbackSandbox: (
    sandboxName: string,
    revalidateSandboxIdentity?: RevalidateSandboxIdentity,
  ) => void;
  fail: (message: string) => never;
}): (
  sandboxName: string,
  rollback?: boolean,
  revalidateSandboxIdentity?: RevalidateSandboxIdentity,
) => void {
  return (
    sandboxName: string,
    rollback = false,
    revalidateSandboxIdentity?: RevalidateSandboxIdentity,
  ): void => {
    const ok = ensureHermesDashboardForwardIfEnabled({
      state,
      sandboxName,
      ensureForward,
      note,
      revalidateSandboxIdentity,
    });
    if (ok) return;
    if (rollback) {
      if (revalidateSandboxIdentity) {
        rollbackSandbox(sandboxName, revalidateSandboxIdentity);
      } else {
        rollbackSandbox(sandboxName);
      }
    }
    fail(formatHermesDashboardForwardFailure(state));
  };
}

export function createHermesDashboardOnboardForwarding({
  agentName,
  env,
  ensureForward,
  note,
  runOpenshell: _runOpenshell,
  getApiForwardPort: _getApiForwardPort,
  fail,
}: {
  agentName: string | null | undefined;
  env: NodeJS.ProcessEnv;
  ensureForward: EnsureForward;
  note: (message: string) => void;
  runOpenshell: RunOpenshell;
  getApiForwardPort: () => string;
  fail?: (message: string) => never;
}) {
  const failWithMessage =
    fail ??
    ((message: string): never => {
      console.error(`  ${message}`);
      process.exit(1);
    });
  void _runOpenshell;
  void _getApiForwardPort;
  const resolveStateForPort = (effectivePort: number) =>
    resolveHermesDashboardOnboardState({ agentName, effectivePort, env, fail: failWithMessage });

  const ensureForState = (
    state: HermesDashboardOnboardState,
    sandboxName: string,
    rollback = false,
    revalidateSandboxIdentity?: RevalidateSandboxIdentity,
  ) =>
    createHermesDashboardForwardEnsurer({
      state,
      ensureForward,
      note,
      rollbackSandbox: (targetSandbox, revalidateRollback) => {
        revalidateRollback?.(`preserve OpenShell forwards for sandbox '${targetSandbox}'`);
      },
      fail: failWithMessage,
    })(sandboxName, rollback, revalidateSandboxIdentity);

  return { resolveStateForPort, ensureForState };
}
