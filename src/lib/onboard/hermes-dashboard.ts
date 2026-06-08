// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HERMES_DASHBOARD_ENABLE_ENV,
  HERMES_DASHBOARD_INTERNAL_PORT_ENV,
  HERMES_DASHBOARD_PORT_ENV,
  HERMES_DASHBOARD_TUI_ENV,
  type HermesDashboardConfig,
  readHermesDashboardConfig,
} from "../hermes-dashboard";
import type { SandboxEntry } from "../state/registry";

export interface HermesDashboardOnboardState {
  config: HermesDashboardConfig | null;
  enabled: boolean;
}

type RunOpenshell = (args: string[], options: { ignoreError: true }) => unknown;

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
    if (config.port === effectivePort) {
      const message = `${HERMES_DASHBOARD_PORT_ENV} must not equal the Hermes API port (${effectivePort}).`;
      if (fail) return fail(message);
      throw new Error(message);
    }
    if (config.port === config.internalPort) {
      const message = `${HERMES_DASHBOARD_PORT_ENV} must not equal ${HERMES_DASHBOARD_INTERNAL_PORT_ENV}.`;
      if (fail) return fail(message);
      throw new Error(message);
    }
    if (config.internalPort === effectivePort) {
      const message = `${HERMES_DASHBOARD_INTERNAL_PORT_ENV} must not equal the Hermes API port (${effectivePort}).`;
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
}: {
  state: HermesDashboardOnboardState;
  sandboxName: string;
  ensureForward: (sandboxName: string, port: number, label: string) => boolean;
  note: (message: string) => void;
}): boolean {
  if (!state.enabled || !state.config) return true;
  if (!ensureForward(sandboxName, state.config.port, "Hermes dashboard")) return false;
  note(`  ✓ Hermes dashboard forwarded at http://127.0.0.1:${state.config.port}/`);
  return true;
}

export function formatHermesDashboardForwardFailure(
  state: HermesDashboardOnboardState,
): string {
  const port = state.config?.port ?? "unknown";
  return `Failed to start Hermes dashboard forward on port ${port}. Free the port and re-run onboarding, or set ${HERMES_DASHBOARD_PORT_ENV} to another port.`;
}

export function createHermesDashboardForwardEnsurer({
  state,
  ensureForward,
  note,
  rollbackSandbox,
  fail,
}: {
  state: HermesDashboardOnboardState;
  ensureForward: (sandboxName: string, port: number, label: string) => boolean;
  note: (message: string) => void;
  rollbackSandbox: (sandboxName: string) => void;
  fail: (message: string) => never;
}): (sandboxName: string, rollback?: boolean) => void {
  return (sandboxName: string, rollback = false): void => {
    const ok = ensureHermesDashboardForwardIfEnabled({ state, sandboxName, ensureForward, note });
    if (ok) return;
    if (rollback) rollbackSandbox(sandboxName);
    fail(formatHermesDashboardForwardFailure(state));
  };
}

export function createHermesDashboardOnboardForwarding({
  agentName,
  env,
  ensureForward,
  note,
  runOpenshell,
  getApiForwardPort,
  fail,
}: {
  agentName: string | null | undefined;
  env: NodeJS.ProcessEnv;
  ensureForward: (sandboxName: string, port: number, label: string) => boolean;
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
  const resolveStateForPort = (effectivePort: number) =>
    resolveHermesDashboardOnboardState({ agentName, effectivePort, env, fail: failWithMessage });

  const ensureForState = (
    state: HermesDashboardOnboardState,
    sandboxName: string,
    rollback = false,
  ) =>
    createHermesDashboardForwardEnsurer({
      state,
      ensureForward,
      note,
      rollbackSandbox: (targetSandbox) => {
        runOpenshell(["forward", "stop", getApiForwardPort(), targetSandbox], {
          ignoreError: true,
        });
        if (state.config) {
          runOpenshell(["forward", "stop", String(state.config.port), targetSandbox], {
            ignoreError: true,
          });
        }
        runOpenshell(["sandbox", "delete", targetSandbox], { ignoreError: true });
      },
      fail: failWithMessage,
    })(sandboxName, rollback);

  return { resolveStateForPort, ensureForState };
}
