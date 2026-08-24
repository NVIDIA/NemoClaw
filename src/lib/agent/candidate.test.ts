// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CANDIDATE_MANAGED_IMAGE_AGENTS } from "../onboard/managed-image/contract";
import {
  CANDIDATE_AGENT_FEATURE_ENV,
  CANDIDATE_QUALIFICATION_RECEIPT_ENV,
  CandidateQualificationError,
  isCandidateAgent,
  isCandidateAgentSelectable,
  isCandidateQualificationEnabled,
  readCandidateQualificationReceipt,
  requireCandidateAgentSelectable,
  requireCandidateQualificationEnabled,
} from "./candidate";
import {
  candidateQualificationContract,
  candidateQualificationEnvironment,
} from "./candidate-test-fixture";

const receipts: Array<() => void> = [];
const ROOT = path.resolve(import.meta.dirname, "../../..");
const PUBLISHED_PI_RECEIPTS = [
  ["linux/amd64", "ci/pi-agent-qualification-v1-linux-amd64.json"],
  ["linux/arm64", "ci/pi-agent-qualification-v1-linux-arm64.json"],
] as const;

function callerMintedReceipt(): NodeJS.ProcessEnv {
  const fixture = candidateQualificationEnvironment();
  receipts.push(fixture.cleanup);
  return fixture.env;
}

afterEach(() => {
  while (receipts.length > 0) receipts.pop()?.();
});

describe("candidate agent gate", () => {
  it.each(CANDIDATE_MANAGED_IMAGE_AGENTS)(
    "treats the declared %s managed-image agent as a candidate (#7927)",
    (agent) => {
      expect(isCandidateAgent(agent)).toBe(true);
    },
  );

  it("keeps shipped agents outside the candidate classification (#7927)", () => {
    expect(isCandidateAgent("openclaw")).toBe(false);
    expect(isCandidateAgent("hermes")).toBe(false);
    expect(isCandidateAgent("langchain-deepagents-code")).toBe(false);
  });

  it.each(PUBLISHED_PI_RECEIPTS)(
    "publishes the exact Pi receipt for %s",
    (platform, relativePath) => {
      const receiptPath = path.join(ROOT, relativePath);

      expect(
        readCandidateQualificationReceipt("pi", {
          [CANDIDATE_AGENT_FEATURE_ENV]: "1",
          [CANDIDATE_QUALIFICATION_RECEIPT_ENV]: receiptPath,
        }),
      ).toMatchObject({ agent: "pi", platform });
    },
  );

  it("never activates a candidate from the protected flag alone (#7927)", () => {
    expect(isCandidateAgentSelectable("pi", { [CANDIDATE_AGENT_FEATURE_ENV]: "1" })).toBe(false);
    expect(() =>
      requireCandidateAgentSelectable("pi", { [CANDIDATE_AGENT_FEATURE_ENV]: "1" }),
    ).toThrow("is not selectable in this release");
  });

  it("stays closed for an ordinary environment without a receipt (#7927)", () => {
    expect(isCandidateAgentSelectable("pi", {})).toBe(false);
    expect(isCandidateAgentSelectable("pi", { [CANDIDATE_AGENT_FEATURE_ENV]: "0" })).toBe(false);
    expect(isCandidateAgentSelectable("pi", { [CANDIDATE_AGENT_FEATURE_ENV]: "true" })).toBe(false);
  });

  it("refuses a receipt that the caller wrote and hashed for itself (#7927)", () => {
    const env = callerMintedReceipt();

    expect(isCandidateAgentSelectable("pi", env)).toBe(false);
    expect(isCandidateQualificationEnabled("pi", env)).toBe(false);
    expect(() => readCandidateQualificationReceipt("pi", env)).toThrow(CandidateQualificationError);
    expect(() => readCandidateQualificationReceipt("pi", env)).toThrow(
      "the receipt is not a published qualification for that candidate",
    );
  });

  it("refuses a caller-supplied digest for a receipt it also wrote (#7927)", () => {
    const contract = candidateQualificationContract("pi");
    const contents = JSON.stringify(contract);
    const env = {
      ...callerMintedReceipt(),
      NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT_SHA256: createHash("sha256")
        .update(contents, "utf8")
        .digest("hex"),
    };

    expect(isCandidateAgentSelectable("pi", env)).toBe(false);
  });

  it("refuses a missing receipt at the selection boundary, not only at startup (#7927)", () => {
    const env = {
      [CANDIDATE_AGENT_FEATURE_ENV]: "1",
      [CANDIDATE_QUALIFICATION_RECEIPT_ENV]: "/nonexistent/candidate-qualification.json",
    };

    expect(isCandidateAgentSelectable("pi", env)).toBe(false);
    expect(() => requireCandidateAgentSelectable("pi", env)).toThrow(
      "is not selectable in this release",
    );
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"])(
    "never refuses the shipped %s agent through the candidate gate (#7927)",
    (agent) => {
      expect(() => requireCandidateAgentSelectable(agent, {})).not.toThrow();
      expect(() => requireCandidateQualificationEnabled(agent, {})).not.toThrow();
    },
  );

  it("refuses to start a candidate without qualification authority (#7927)", () => {
    expect(() => requireCandidateQualificationEnabled("pi", {})).toThrow(
      "is not selectable in this release",
    );
    expect(() => requireCandidateQualificationEnabled("pi", callerMintedReceipt())).toThrow(
      "is not selectable in this release",
    );
  });
});
