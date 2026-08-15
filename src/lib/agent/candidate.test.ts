// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { CANDIDATE_MANAGED_IMAGE_AGENTS } from "../onboard/managed-image/contract";
import {
  candidateQualificationContract,
  candidateQualificationEnvironment,
} from "./candidate-test-fixture";
import {
  CANDIDATE_AGENT_FEATURE_ENV,
  CandidateQualificationError,
  isCandidateAgent,
  isCandidateAgentEnabled,
  isCandidateAgentSelectable,
  isCandidateQualificationEnabled,
  readCandidateQualificationReceipt,
  requireCandidateAgentSelectable,
  requireCandidateQualificationEnabled,
} from "./candidate";

describe("candidate agent gate", () => {
  it("treats every declared candidate managed-image agent as a candidate (#7927)", () => {
    for (const agent of CANDIDATE_MANAGED_IMAGE_AGENTS) {
      expect(isCandidateAgent(agent)).toBe(true);
    }
    expect(isCandidateAgent("openclaw")).toBe(false);
    expect(isCandidateAgent("hermes")).toBe(false);
    expect(isCandidateAgent("langchain-deepagents-code")).toBe(false);
  });

  it("never activates a candidate from the protected flag alone (#7927)", () => {
    expect(isCandidateAgentEnabled({ [CANDIDATE_AGENT_FEATURE_ENV]: "1" })).toBe(false);
    expect(isCandidateAgentSelectable("pi", { [CANDIDATE_AGENT_FEATURE_ENV]: "1" })).toBe(false);
    expect(() =>
      requireCandidateAgentSelectable("pi", { [CANDIDATE_AGENT_FEATURE_ENV]: "1" }),
    ).toThrow("is not selectable in this release");
  });

  it("stays closed for an ordinary environment without a receipt (#7927)", () => {
    expect(isCandidateAgentEnabled({})).toBe(false);
    expect(isCandidateAgentEnabled({ [CANDIDATE_AGENT_FEATURE_ENV]: "0" })).toBe(false);
    expect(isCandidateAgentEnabled({ [CANDIDATE_AGENT_FEATURE_ENV]: "true" })).toBe(false);
  });

  it("selects a candidate only with a digest-pinned receipt (#7927)", () => {
    const env = candidateQualificationEnvironment();

    expect(isCandidateAgentEnabled(env)).toBe(true);
    expect(isCandidateAgentSelectable("pi", env)).toBe(true);
    expect(() => requireCandidateAgentSelectable("pi", env)).not.toThrow();
  });

  it("refuses a receipt that does not match its pinned digest (#7927)", () => {
    const env = candidateQualificationEnvironment({ corruptDigest: true });

    expect(() => readCandidateQualificationReceipt("pi", env)).toThrow(CandidateQualificationError);
    expect(() => readCandidateQualificationReceipt("pi", env)).toThrow(
      "does not match its pinned digest",
    );
    expect(isCandidateQualificationEnabled("pi", env)).toBe(false);
  });

  it("refuses a receipt whose contents change after the digest is pinned (#7927)", () => {
    const env = candidateQualificationEnvironment();
    fs.writeFileSync(env.receiptPath, JSON.stringify(candidateQualificationContract("pi")) + " ");

    expect(() => readCandidateQualificationReceipt("pi", env)).toThrow(
      "does not match its pinned digest",
    );
  });

  it("refuses a receipt that claims a shipped agent (#7927)", () => {
    const contract = { ...candidateQualificationContract("pi"), agent: "hermes" as const };
    const env = candidateQualificationEnvironment({ contract: contract as never });

    expect(() => readCandidateQualificationReceipt("pi", env)).toThrow(
      "failed closed contract validation",
    );
  });

  it("returns the exact accepted image identity from the receipt (#7927)", () => {
    const env = candidateQualificationEnvironment();
    const contract = readCandidateQualificationReceipt("pi", env);

    expect(contract).toMatchObject({
      agent: "pi",
      image: "ghcr.io/nvidia/nemoclaw/pi-sandbox",
    });
    expect(contract.reference).toBe(`${contract.image}@${contract.digest}`);
  });

  it("never refuses a shipped agent through the candidate gate (#7927)", () => {
    for (const agent of ["openclaw", "hermes", "langchain-deepagents-code"]) {
      expect(() => requireCandidateAgentSelectable(agent, {})).not.toThrow();
      expect(() => requireCandidateQualificationEnabled(agent, {})).not.toThrow();
    }
  });

  it("refuses to start a candidate without qualification authority (#7927)", () => {
    expect(() => requireCandidateQualificationEnabled("pi", {})).toThrow(
      "is not selectable in this release",
    );
    expect(() =>
      requireCandidateQualificationEnabled("pi", candidateQualificationEnvironment()),
    ).not.toThrow();
  });
});
