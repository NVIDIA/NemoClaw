// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";
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
    revalidatePolicyAuthority?: (operation: string) => void,
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
    options?: { revalidatePolicyAuthority?: (operation: string) => void },
  ): number;
  hermesDashboardForwarding: ReusedSandboxDashboardForwarding;
  updateSandbox?(sandboxName: string, updates: Partial<SandboxEntry>): unknown;
  revalidatePolicyRequirements?(operation: string): void;
  updateReusedSandboxMetadata(
    sandboxName: string,
    agent: AgentDefinition | null | undefined,
    model: string,
    provider: string,
    dashboardPort: number,
    selectionVerified: boolean,
    sandboxGpuConfig: SandboxGpuConfig,
    revalidatePolicyAuthority?: (operation: string) => void,
  ): void;
}

export interface ReusedSandboxDashboardStateResult {
  chatUiUrl: string;
  dashboardPort: number;
  hermesDashboardState: HermesDashboardOnboardState;
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
  input.revalidatePolicyRequirements?.(
    `restore dashboard state for sandbox '${input.sandboxName}'`,
  );
  const dashboardPort = manageDashboard
    ? input.revalidatePolicyRequirements
      ? input.ensureDashboardForward(input.sandboxName, input.chatUiUrl, {
          revalidatePolicyAuthority: input.revalidatePolicyRequirements,
        })
      : input.ensureDashboardForward(input.sandboxName, input.chatUiUrl)
    : 0;
  const chatUiUrl = manageDashboard ? `http://127.0.0.1:${dashboardPort}` : input.chatUiUrl;
  if (manageDashboard) {
    input.revalidatePolicyRequirements?.(`record dashboard URL for sandbox '${input.sandboxName}'`);
    input.env.CHAT_UI_URL = chatUiUrl;
  }
  const hermesDashboardState = manageDashboard
    ? input.hermesDashboardForwarding.resolveStateForPort(dashboardPort)
    : { enabled: false, config: null };
  if (manageDashboard) {
    input.revalidatePolicyRequirements?.(
      `restore Hermes dashboard state for sandbox '${input.sandboxName}'`,
    );
    input.hermesDashboardForwarding.ensureForState(
      hermesDashboardState,
      input.sandboxName,
      false,
      input.revalidatePolicyRequirements,
    );
  }
  input.revalidatePolicyRequirements?.(`update reused sandbox metadata for '${input.sandboxName}'`);
  input.updateReusedSandboxMetadata(
    input.sandboxName,
    input.agent,
    input.model,
    input.provider,
    dashboardPort,
    input.selectionVerified,
    input.sandboxGpuConfig,
    input.revalidatePolicyRequirements,
  );
  input.revalidatePolicyRequirements?.(
    `record reused dashboard state for sandbox '${input.sandboxName}'`,
  );
  (input.updateSandbox ?? registry.updateSandbox)(input.sandboxName, {
    ...getHermesDashboardRegistryFields(hermesDashboardState),
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
