// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical metadata for the coarse onboard finite-state machine.
 *
 * Keep this file free of imports from the rest of the machine package so the
 * core state vocabulary can be reused by type, transition, event, session, and
 * progress helpers without introducing circular dependencies.
 */

export const ONBOARD_MACHINE_STATE_DEFINITIONS = [
  { state: "init", terminal: false },
  {
    state: "preflight",
    terminal: false,
    stepName: "preflight",
    progress: { number: 1, total: 8, title: "Preflight checks" },
  },
  {
    state: "gateway",
    terminal: false,
    stepName: "gateway",
    progress: { number: 2, total: 8, title: "Starting OpenShell gateway" },
  },
  {
    state: "provider_selection",
    terminal: false,
    stepName: "provider_selection",
    progress: { number: 3, total: 8, title: "Configuring inference (NIM)" },
  },
  {
    state: "inference",
    terminal: false,
    stepName: "inference",
    progress: { number: 4, total: 8, title: "Setting up inference provider" },
  },
  {
    state: "sandbox",
    terminal: false,
    stepName: "sandbox",
    progress: { number: 6, total: 8, title: "Creating sandbox" },
  },
  {
    state: "agent_setup",
    terminal: false,
    stepName: "agent_setup",
  },
  {
    state: "openclaw",
    terminal: false,
    stepName: "openclaw",
    progress: { number: 7, total: 8, title: "Setting up agent inside sandbox" },
  },
  {
    state: "policies",
    terminal: false,
    stepName: "policies",
    progress: { number: 8, total: 8, title: "Policy presets" },
  },
  { state: "finalizing", terminal: false },
  { state: "post_verify", terminal: false },
  { state: "complete", terminal: true },
  { state: "failed", terminal: true },
] as const;

export type OnboardMachineStateDefinition = (typeof ONBOARD_MACHINE_STATE_DEFINITIONS)[number];

export type OnboardMachineStateId = OnboardMachineStateDefinition["state"];

export type OnboardTerminalMachineStateId = Extract<
  OnboardMachineStateDefinition,
  { terminal: true }
>["state"];

export type OnboardNonTerminalMachineStateId = Extract<
  OnboardMachineStateDefinition,
  { terminal: false }
>["state"];

export const ONBOARD_MACHINE_STATE_IDS = ONBOARD_MACHINE_STATE_DEFINITIONS.map(
  (definition) => definition.state,
) as readonly OnboardMachineStateId[];

export const ONBOARD_MACHINE_TERMINAL_STATE_IDS = ONBOARD_MACHINE_STATE_DEFINITIONS.filter(
  (definition): definition is Extract<OnboardMachineStateDefinition, { terminal: true }> =>
    definition.terminal === true,
).map((definition) => definition.state) as readonly OnboardTerminalMachineStateId[];

export const ONBOARD_MACHINE_NON_TERMINAL_STATE_IDS = ONBOARD_MACHINE_STATE_DEFINITIONS.filter(
  (definition): definition is Extract<OnboardMachineStateDefinition, { terminal: false }> =>
    definition.terminal === false,
).map((definition) => definition.state) as readonly OnboardNonTerminalMachineStateId[];

export type OnboardMachineStateWithStepDefinition = Extract<
  OnboardMachineStateDefinition,
  { stepName: string }
>;

export type OnboardMachineStateWithProgressDefinition = Extract<
  OnboardMachineStateDefinition,
  { progress: { number: number; total: number; title: string } }
>;

export function getOnboardMachineStateDefinition(
  state: OnboardMachineStateId,
): OnboardMachineStateDefinition {
  const definition = ONBOARD_MACHINE_STATE_DEFINITIONS.find((entry) => entry.state === state);
  if (!definition) throw new Error(`Unknown onboarding machine state: ${state}`);
  return definition;
}
