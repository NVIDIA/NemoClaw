// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Coarse onboarding finite-state-machine vocabulary.
 *
 * These types intentionally model only major step boundaries. Mid-operation
 * resume inside gateway startup, sandbox creation, credential upserts, model
 * probes, or policy application is out of scope for the initial FSM shell.
 */

export const ONBOARD_MACHINE_STATES = [
  "init",
  "preflight",
  "gateway",
  "provider_selection",
  "inference",
  "sandbox",
  "agent_setup",
  "openclaw",
  "policies",
  "finalizing",
  "post_verify",
  "complete",
  "failed",
] as const;

export type OnboardMachineState = (typeof ONBOARD_MACHINE_STATES)[number];

export const ONBOARD_TERMINAL_MACHINE_STATES = ["complete", "failed"] as const;

export type OnboardTerminalMachineState =
  (typeof ONBOARD_TERMINAL_MACHINE_STATES)[number];

export type OnboardNonTerminalMachineState = Exclude<
  OnboardMachineState,
  OnboardTerminalMachineState
>;

export const ONBOARD_NON_TERMINAL_MACHINE_STATES: readonly OnboardNonTerminalMachineState[] =
  ONBOARD_MACHINE_STATES.filter(
    (state): state is OnboardNonTerminalMachineState =>
      !ONBOARD_TERMINAL_MACHINE_STATES.includes(state as OnboardTerminalMachineState),
  );

export const ONBOARD_MACHINE_EVENT_TYPES = [
  "onboard.started",
  "onboard.resumed",
  "onboard.completed",
  "onboard.failed",
  "state.entered",
  "state.exited",
  "state.skipped",
  "state.completed",
  "state.failed",
  "state.repair.started",
  "state.repair.completed",
  "state.repair.failed",
  "context.updated",
  "resume.conflict",
  "hook.started",
  "hook.completed",
  "hook.failed",
] as const;

export type OnboardMachineEventType = (typeof ONBOARD_MACHINE_EVENT_TYPES)[number];

export type OnboardMachineTransitionKind =
  | "advance"
  | "retry"
  | "branch"
  | "failure";

export interface OnboardMachineTransition {
  from: OnboardMachineState;
  to: OnboardMachineState;
  kind: OnboardMachineTransitionKind;
}

/**
 * Stable, redacted context keys that machine events may expose.
 *
 * Do not add raw secrets or unredacted URLs here. Runtime-derived topology
 * decisions such as Docker/WSL reachability, Ollama proxy necessity, or live
 * gateway health should be recomputed during execution rather than stored as
 * durable FSM context.
 */
export interface OnboardMachineContext {
  agent?: string | null;
  sandboxName?: string | null;
  provider?: string | null;
  model?: string | null;
  endpointOrigin?: string | null;
  credentialEnv?: string | null;
  preferredInferenceApi?: string | null;
  hermesAuthMethod?: "oauth" | "api_key" | null;
  hermesToolGateways?: string[] | null;
  policyPresets?: string[] | null;
  messagingChannels?: string[] | null;
  gpuPassthrough?: boolean;
}
