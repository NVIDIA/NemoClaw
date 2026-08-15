// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { CANDIDATE_MANAGED_IMAGE_AGENTS } from "../onboard/managed-image/contract";
import {
  isCandidateAgent,
  isCandidateAgentEnabled,
  isCandidateAgentSelectable,
  isCandidateQualificationEnabled,
  requireCandidateAgentSelectable,
  requireCandidateQualificationEnabled,
} from "./candidate";

const ENABLED = { NEMOCLAW_CANDIDATE_AGENTS: "1" };
const QUALIFIED = { NEMOCLAW_CANDIDATE_AGENTS: "1", NEMOCLAW_CANDIDATE_QUALIFICATION: "1" };

describe("candidate agent gate", () => {
  it("treats every declared candidate managed-image agent as a candidate (#7927)", () => {
    for (const agent of CANDIDATE_MANAGED_IMAGE_AGENTS) {
      expect(isCandidateAgent(agent)).toBe(true);
    }
    expect(isCandidateAgent("openclaw")).toBe(false);
    expect(isCandidateAgent("hermes")).toBe(false);
    expect(isCandidateAgent("langchain-deepagents-code")).toBe(false);
  });

  it("stays closed until the protected gate is set to exactly 1 (#7927)", () => {
    expect(isCandidateAgentEnabled({})).toBe(false);
    expect(isCandidateAgentEnabled({ NEMOCLAW_CANDIDATE_AGENTS: "0" })).toBe(false);
    expect(isCandidateAgentEnabled({ NEMOCLAW_CANDIDATE_AGENTS: "true" })).toBe(false);
    expect(isCandidateAgentEnabled({ NEMOCLAW_CANDIDATE_AGENTS: " 1" })).toBe(false);
    expect(isCandidateAgentEnabled(ENABLED)).toBe(true);
  });

  it("requires the candidate agent gate before qualification authority (#7927)", () => {
    expect(isCandidateQualificationEnabled({ NEMOCLAW_CANDIDATE_QUALIFICATION: "1" })).toBe(false);
    expect(isCandidateQualificationEnabled(ENABLED)).toBe(false);
    expect(isCandidateQualificationEnabled(QUALIFIED)).toBe(true);
  });

  it("reports a candidate as selectable only behind the gate (#7927)", () => {
    expect(isCandidateAgentSelectable("pi", {})).toBe(false);
    expect(isCandidateAgentSelectable("pi", ENABLED)).toBe(true);
    expect(isCandidateAgentSelectable("openclaw", {})).toBe(false);
  });

  it("names the refused candidate in the selection error (#7927)", () => {
    expect(() => requireCandidateAgentSelectable("pi", {})).toThrow(
      "Agent 'pi' is a release candidate and is not selectable in this release",
    );
    expect(() => requireCandidateAgentSelectable("pi", ENABLED)).not.toThrow();
  });

  it("never refuses a shipped agent through the candidate gate (#7927)", () => {
    for (const agent of ["openclaw", "hermes", "langchain-deepagents-code"]) {
      expect(() => requireCandidateAgentSelectable(agent, {})).not.toThrow();
      expect(() => requireCandidateQualificationEnabled(agent, {})).not.toThrow();
    }
  });

  it("refuses to start a candidate without protected qualification authority (#7927)", () => {
    expect(() => requireCandidateQualificationEnabled("pi", {})).toThrow(
      "is not selectable in this release",
    );
    expect(() => requireCandidateQualificationEnabled("pi", ENABLED)).toThrow(
      "Agent 'pi' requires protected candidate qualification before it can start",
    );
    expect(() => requireCandidateQualificationEnabled("pi", QUALIFIED)).not.toThrow();
  });
});
