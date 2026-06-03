// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ONBOARD_MACHINE_STATE_DEFINITIONS } from "./definition";
import { getOnboardProgressStep, ONBOARD_PROGRESS_STEPS } from "./progress";

describe("onboard progress metadata", () => {
  it("derives state-backed progress labels from machine definitions", () => {
    for (const definition of ONBOARD_MACHINE_STATE_DEFINITIONS) {
      if (!("progress" in definition)) continue;
      expect(ONBOARD_PROGRESS_STEPS[definition.stepName]).toEqual(definition.progress);
    }
  });

  it("preserves the existing eight-step onboarding labels", () => {
    expect(ONBOARD_PROGRESS_STEPS).toEqual({
      preflight: { number: 1, total: 8, title: "Preflight checks" },
      gateway: { number: 2, total: 8, title: "Starting OpenShell gateway" },
      provider_selection: { number: 3, total: 8, title: "Configuring inference (NIM)" },
      inference: { number: 4, total: 8, title: "Setting up inference provider" },
      messaging: { number: 5, total: 8, title: "Messaging channels" },
      sandbox: { number: 6, total: 8, title: "Creating sandbox" },
      openclaw: { number: 7, total: 8, title: "Setting up agent inside sandbox" },
      policies: { number: 8, total: 8, title: "Policy presets" },
    });
  });

  it("looks up known labels and ignores unknown steps", () => {
    expect(getOnboardProgressStep("gateway")).toEqual({
      number: 2,
      total: 8,
      title: "Starting OpenShell gateway",
    });
    expect(getOnboardProgressStep("not-a-step")).toBeNull();
  });
});
