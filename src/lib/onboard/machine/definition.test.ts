// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getOnboardMachineStateDefinition,
  ONBOARD_MACHINE_NON_TERMINAL_STATE_IDS,
  ONBOARD_MACHINE_STATE_DEFINITIONS,
  ONBOARD_MACHINE_STATE_IDS,
  ONBOARD_MACHINE_TERMINAL_STATE_IDS,
} from "./definition";

const expectedStateOrder = [
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
];

describe("onboard machine definition", () => {
  it("is the canonical ordered state catalog", () => {
    expect(ONBOARD_MACHINE_STATE_IDS).toEqual(expectedStateOrder);
    expect(ONBOARD_MACHINE_STATE_DEFINITIONS.map((definition) => definition.state)).toEqual(
      expectedStateOrder,
    );
  });

  it("derives terminal and non-terminal state catalogs from the same vocabulary", () => {
    const terminalFromDefinitions = ONBOARD_MACHINE_STATE_DEFINITIONS.filter(
      (definition) => definition.terminal,
    ).map((definition) => definition.state);
    const nonTerminalFromDefinitions = ONBOARD_MACHINE_STATE_DEFINITIONS.filter(
      (definition) => !definition.terminal,
    ).map((definition) => definition.state);

    expect(ONBOARD_MACHINE_TERMINAL_STATE_IDS).toEqual(terminalFromDefinitions);
    expect(ONBOARD_MACHINE_NON_TERMINAL_STATE_IDS).toEqual(nonTerminalFromDefinitions);
  });

  it("keeps resumable step names unique", () => {
    const stepNames = ONBOARD_MACHINE_STATE_DEFINITIONS.flatMap((definition) =>
      "stepName" in definition ? [definition.stepName] : [],
    );

    expect(new Set(stepNames).size).toBe(stepNames.length);
    expect(stepNames).toEqual([
      "preflight",
      "gateway",
      "provider_selection",
      "inference",
      "sandbox",
      "agent_setup",
      "openclaw",
      "policies",
    ]);
  });

  it("keeps progress metadata attached only to state-backed steps", () => {
    for (const definition of ONBOARD_MACHINE_STATE_DEFINITIONS) {
      if (!("progress" in definition)) continue;
      expect("stepName" in definition).toBe(true);
      expect(definition.progress.total).toBe(8);
      expect(definition.progress.number).toBeGreaterThanOrEqual(1);
      expect(definition.progress.number).toBeLessThanOrEqual(definition.progress.total);
      expect(definition.progress.title).not.toHaveLength(0);
    }
  });

  it("looks up definitions by state", () => {
    expect(getOnboardMachineStateDefinition("gateway")).toMatchObject({
      state: "gateway",
      stepName: "gateway",
    });
    expect(getOnboardMachineStateDefinition("complete")).toMatchObject({
      state: "complete",
      terminal: true,
    });
    expect(getOnboardMachineStateDefinition("init")).toMatchObject({
      state: "init",
      terminal: false,
    });
    expect("stepName" in getOnboardMachineStateDefinition("init")).toBe(false);
  });

  it("throws when looking up an unknown state", () => {
    expect(() =>
      getOnboardMachineStateDefinition(
        "unknown" as Parameters<typeof getOnboardMachineStateDefinition>[0],
      ),
    ).toThrow("Unknown onboarding machine state: unknown");
  });
});
