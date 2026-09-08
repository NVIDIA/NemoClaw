// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";
import { buildDashboardChain } from "./dashboard-access";
import {
  getHermesDashboardRegistryFields,
  type HermesDashboardOnboardState,
} from "./hermes-dashboard";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import {
  isExplicitMissingSandboxGatewayOutput,
  SANDBOX_RECREATE_PROBE_TIMEOUT_MS,
} from "./sandbox-recreate-probe";
import {
  fingerprintSandboxLiveIdentity,
  type SandboxRecreateObservation,
} from "./sandbox-recreate-transaction";

interface SandboxCaptureResult {
  status: number | null;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

export interface SandboxReuseDeps {
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string;
  captureOpenshell(args: string[], opts?: Record<string, unknown>): SandboxCaptureResult;
  getSandboxStateFromOutputs(sandboxName: string, getOutput: string, listOutput: string): string;
  // Read at call time: onboarding rebinds the gateway after preflight resolves it.
  getGatewayName?(): string;
  now?(): number;
  sleep?(milliseconds: number): void;
  waitUntil?(
    condition: () => boolean,
    options: {
      deadlineMs: number;
      initialIntervalMs: number;
      maxIntervalMs: number;
      maxAttempts: number;
      now: () => number;
      sleep?: (milliseconds: number) => void;
    },
  ): boolean;
}

export interface SandboxReuseHelpers {
  getSandboxReuseState(sandboxName: string | null): string;
  getSandboxRecreateObservation(
    sandboxName: string | null,
    gatewayName?: string,
  ): SandboxRecreateObservation;
  waitForSandboxRecreateDeleteAbsence(
    sandboxName: string,
    gatewayName: string,
    note: (message: string) => void,
  ): boolean;
}

const DELETE_ABSENCE_MAX_ATTEMPTS = 20;
const DELETE_ABSENCE_INITIAL_INTERVAL_MS = 250;
const DELETE_ABSENCE_MAX_INTERVAL_MS = 1_000;

function capturedProbeOutput(probe: SandboxCaptureResult): {
  combined: string;
  stdout: string;
} {
  const stdout = String(probe.stdout ?? (probe.status === 0 ? probe.output : "")).trim();
  const stderr = String(probe.stderr ?? (probe.status !== 0 ? probe.output : "")).trim();
  return { combined: `${stdout}\n${stderr}`.trim(), stdout };
}

function isCleanFailedProbe(probe: SandboxCaptureResult): boolean {
  return !probe.error && !probe.signal && probe.status !== null && probe.status !== 0;
}

export interface ReusedSandboxDashboardForwarding {
  resolveStateForPort(effectivePort: number): HermesDashboardOnboardState;
  ensureForState(
    state: HermesDashboardOnboardState,
    sandboxName: string,
    rollback?: boolean,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): void;
}

export interface ReusedSandboxDashboardStateInput {
  sandboxName: string;
  chatUiUrl: string;
  env: NodeJS.ProcessEnv;
  agent: AgentDefinition | null | undefined;
  model: string;
  provider: string;
  selectionVerified: boolean;
  sandboxGpuConfig: SandboxGpuConfig;
  gatewayName: string;
  gatewayPort: number;
  manageDashboard?: boolean;
  getSandbox?(sandboxName: string): SandboxEntry | null;
  ensureDashboardForward(
    sandboxName: string,
    chatUiUrl: string,
    options?: {
      revalidateSandboxIdentity?: (operation: string) => void;
      onForwardFailure?: (diagnostic: string) => void;
    },
  ): number;
  hermesDashboardForwarding: ReusedSandboxDashboardForwarding;
  updateSandbox?(sandboxName: string, updates: Partial<SandboxEntry>): unknown;
  revalidateSandboxIdentity?(operation: string): void;
  updateReusedSandboxMetadata(
    sandboxName: string,
    agent: AgentDefinition | null | undefined,
    model: string,
    provider: string,
    dashboardPort: number,
    selectionVerified: boolean,
    sandboxGpuConfig: SandboxGpuConfig,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): void;
}

export interface ReusedSandboxDashboardStateResult {
  chatUiUrl: string;
  dashboardPort: number;
  hermesDashboardState: HermesDashboardOnboardState;
}

/** A registry write fails when it returns false or throws. */
function recordReusedDashboardBind(
  input: ReusedSandboxDashboardStateInput,
  dashboardBindAddress: string | null,
): boolean {
  try {
    return (
      (input.updateSandbox ?? registry.updateSandbox)(input.sandboxName, {
        dashboardBindAddress,
      }) !== false
    );
  } catch {
    return false;
  }
}

/** Explain a refused reused-dashboard restore whose record would misdescribe it. */
function reusedDashboardBindRefusal(
  sandboxName: string,
  bindAddress: string,
  previousBind: string | null,
): string {
  return bindAddress === "0.0.0.0"
    ? `Refusing to restore the dashboard forward for '${sandboxName}' on all interfaces: its exposure could not be recorded, so \`dashboard-url\` and \`status\` would not disclose it. Repair the sandbox registry and re-run onboarding.`
    : `Refusing to restore the dashboard forward for '${sandboxName}' on loopback: the registry still records a bind on ${String(previousBind)} and could not be updated, so \`dashboard-url\` and \`status\` would report exposure that no longer exists. Repair the sandbox registry and re-run onboarding.`;
}

export function applyReusedSandboxDashboardState(
  input: ReusedSandboxDashboardStateInput,
): ReusedSandboxDashboardStateResult {
  const manageDashboard = input.manageDashboard ?? true;
  if (
    manageDashboard &&
    input.env.NEMOCLAW_DASHBOARD_BIND === "0.0.0.0" &&
    (input.getSandbox ?? registry.getSandbox)(input.sandboxName)?.dashboardRemoteBindPrepared !==
      true
  ) {
    throw new Error(
      `Sandbox '${input.sandboxName}' was created without remote dashboard exposure. Re-run onboarding with NEMOCLAW_DASHBOARD_BIND=0.0.0.0 and --recreate-sandbox before opening a remote bind.`,
    );
  }
  input.revalidateSandboxIdentity?.(
    `restore dashboard state for sandbox '${input.sandboxName}'`,
  );
  // The bind the restored forward will have, from the same URL and
  // environment `ensureDashboardForward` decides it from (#10861). It is
  // recorded before the forward exists whenever the record would otherwise
  // misdescribe exposure: a wide bind must never be started undisclosed, and
  // a loopback bind replacing a recorded wide one must not leave that record
  // standing if a later step fails. Either is refused when the write fails.
  // A loopback bind over a loopback or absent record is recorded with the
  // rest of the dashboard state below.
  const dashboardBindAddress = manageDashboard
    ? buildDashboardChain(input.chatUiUrl, { env: input.env }).bindAddress
    : null;
  const previousBind = manageDashboard
    ? ((input.getSandbox ?? registry.getSandbox)(input.sandboxName)?.dashboardBindAddress ?? null)
    : null;
  const recordBeforeLaunch =
    dashboardBindAddress !== null &&
    (dashboardBindAddress === "0.0.0.0" || previousBind === "0.0.0.0");
  if (recordBeforeLaunch) {
    input.revalidateSandboxIdentity?.(
      `record the dashboard bind for sandbox '${input.sandboxName}'`,
    );
    if (!recordReusedDashboardBind(input, dashboardBindAddress)) {
      throw new Error(
        reusedDashboardBindRefusal(input.sandboxName, dashboardBindAddress, previousBind),
      );
    }
  }
  // The launcher warns and still returns the port when the forward does not
  // start, so it reports that here. A record written for a forward that
  // never came up goes back to what it was: no command may claim a listener
  // that does not exist.
  let forwardFailure: string | null = null;
  const onForwardFailure = (diagnostic: string): void => {
    forwardFailure = diagnostic;
  };
  const dashboardPort = manageDashboard
    ? input.revalidateSandboxIdentity
      ? input.ensureDashboardForward(input.sandboxName, input.chatUiUrl, {
          revalidateSandboxIdentity: input.revalidateSandboxIdentity,
          onForwardFailure,
        })
      : input.ensureDashboardForward(input.sandboxName, input.chatUiUrl, { onForwardFailure })
    : 0;
  const recordedBind = forwardFailure === null ? dashboardBindAddress : previousBind;
  if (
    forwardFailure !== null &&
    recordBeforeLaunch &&
    !recordReusedDashboardBind(input, previousBind)
  ) {
    console.warn(
      `  Warning: the recorded dashboard bind for '${input.sandboxName}' could not be restored after the forward failed to start; \`dashboard-url\` may report a listener that does not exist until the next forward launch.`,
    );
  }
  const chatUiUrl = manageDashboard ? `http://127.0.0.1:${dashboardPort}` : input.chatUiUrl;
  if (manageDashboard) {
    input.revalidateSandboxIdentity?.(`record dashboard URL for sandbox '${input.sandboxName}'`);
    input.env.CHAT_UI_URL = chatUiUrl;
  }
  const hermesDashboardState = manageDashboard
    ? input.hermesDashboardForwarding.resolveStateForPort(dashboardPort)
    : { enabled: false, config: null };
  if (manageDashboard) {
    input.revalidateSandboxIdentity?.(
      `restore Hermes dashboard state for sandbox '${input.sandboxName}'`,
    );
    input.hermesDashboardForwarding.ensureForState(
      hermesDashboardState,
      input.sandboxName,
      false,
      input.revalidateSandboxIdentity,
    );
  }
  input.revalidateSandboxIdentity?.(`update reused sandbox metadata for '${input.sandboxName}'`);
  input.updateReusedSandboxMetadata(
    input.sandboxName,
    input.agent,
    input.model,
    input.provider,
    dashboardPort,
    input.selectionVerified,
    input.sandboxGpuConfig,
    input.revalidateSandboxIdentity,
  );
  input.revalidateSandboxIdentity?.(
    `record reused dashboard state for sandbox '${input.sandboxName}'`,
  );
  (input.updateSandbox ?? registry.updateSandbox)(input.sandboxName, {
    ...getHermesDashboardRegistryFields(hermesDashboardState),
    // With no managed forward nothing was started, so the existing record stands.
    ...(manageDashboard ? { dashboardBindAddress: recordedBind } : {}),
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
  });
  return { chatUiUrl, dashboardPort, hermesDashboardState };
}

export async function restoreReusedSandboxDashboardState(
  input: ReusedSandboxDashboardStateInput & { releaseDashboardPort(): Promise<void> },
): Promise<ReusedSandboxDashboardStateResult> {
  await input.releaseDashboardPort();
  return applyReusedSandboxDashboardState(input);
}

export function createSandboxReuseHelpers(deps: SandboxReuseDeps): SandboxReuseHelpers {
  // A recorded gateway wins over the ambient one: a resumed replacement must
  // prove presence or absence on the gateway its journal names.
  function gatewayArgs(recordedGatewayName?: string): string[] {
    const gatewayName = recordedGatewayName ?? deps.getGatewayName?.();
    return gatewayName ? ["-g", gatewayName] : [];
  }

  function readSandboxState(
    sandboxName: string | null,
    recordedGatewayName?: string,
  ): { state: string; getOutput: string } {
    if (!sandboxName) return { state: "missing", getOutput: "" };
    const args = gatewayArgs(recordedGatewayName);
    const getOutput = deps.runCaptureOpenshell(["sandbox", "get", ...args, sandboxName], {
      ignoreError: true,
      includeStderr: true,
    });
    const listOutput = deps.runCaptureOpenshell(["sandbox", "list", ...args], {
      ignoreError: true,
    });
    const state = deps.getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
    return { state, getOutput };
  }

  function getSandboxRecreateObservation(
    sandboxName: string | null,
    recordedGatewayName?: string,
  ): SandboxRecreateObservation {
    if (!sandboxName) return { state: "missing", liveIdentityFingerprint: null };
    const args = gatewayArgs(recordedGatewayName);
    const probe = deps.captureOpenshell(["sandbox", "get", ...args, sandboxName], {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      timeout: SANDBOX_RECREATE_PROBE_TIMEOUT_MS,
    });
    const { combined, stdout } = capturedProbeOutput(probe);
    if (isCleanFailedProbe(probe) && isExplicitMissingSandboxGatewayOutput(combined, sandboxName)) {
      return { state: "missing", liveIdentityFingerprint: null };
    }
    if (probe.status !== 0 || probe.error || probe.signal || stdout.length === 0) {
      throw new Error(
        `Cannot observe sandbox '${sandboxName}' for recreate recovery: OpenShell reported neither a live sandbox nor explicit absence.`,
      );
    }
    const listOutput = deps.runCaptureOpenshell(["sandbox", "list", ...args], {
      ignoreError: true,
    });
    const state = deps.getSandboxStateFromOutputs(sandboxName, stdout, listOutput);
    if (state !== "missing" && state !== "not_ready" && state !== "ready") {
      throw new Error(
        `Cannot observe sandbox '${sandboxName}' for recreate recovery: OpenShell returned state '${state}'.`,
      );
    }
    if (state === "missing") {
      throw new Error(
        `Cannot observe sandbox '${sandboxName}' for recreate recovery: OpenShell reported neither a live sandbox nor explicit absence.`,
      );
    }
    return {
      state,
      liveIdentityFingerprint: fingerprintSandboxLiveIdentity(stdout),
    };
  }

  function getSandboxReuseState(sandboxName: string | null): string {
    return readSandboxState(sandboxName).state;
  }

  function waitForSandboxRecreateDeleteAbsence(
    sandboxName: string,
    gatewayName: string,
    note: (message: string) => void,
  ): boolean {
    const now = deps.now ?? Date.now;
    const deadlineMs = now() + SANDBOX_RECREATE_PROBE_TIMEOUT_MS;
    if (!deps.waitUntil) {
      throw new Error("Sandbox delete convergence requires the bounded wait dependency.");
    }
    let attempt = 0;

    return deps.waitUntil(
      () => {
        attempt += 1;
        const remainingMs = Math.max(1, Math.ceil(deadlineMs - now()));
        let probe: SandboxCaptureResult | null = null;
        try {
          probe = deps.captureOpenshell(["sandbox", "get", "-g", gatewayName, sandboxName], {
            ignoreError: true,
            includeStderr: true,
            includeStreams: true,
            timeout: remainingMs,
          });
        } catch {
          // Transport failures stay unknown and are retried within the bound.
        }
        const { combined } = probe ? capturedProbeOutput(probe) : { combined: "" };
        const absent =
          probe !== null &&
          isCleanFailedProbe(probe) &&
          isExplicitMissingSandboxGatewayOutput(combined, sandboxName);
        const state = absent ? "absent" : combined.length > 0 ? "present-or-error" : "unknown";
        note(`  Delete convergence probe ${String(attempt)}: state=${state}`);
        return absent;
      },
      {
        deadlineMs,
        initialIntervalMs: DELETE_ABSENCE_INITIAL_INTERVAL_MS,
        maxIntervalMs: DELETE_ABSENCE_MAX_INTERVAL_MS,
        maxAttempts: DELETE_ABSENCE_MAX_ATTEMPTS,
        now,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      },
    );
  }

  return {
    getSandboxReuseState,
    getSandboxRecreateObservation,
    waitForSandboxRecreateDeleteAbsence,
  };
}
