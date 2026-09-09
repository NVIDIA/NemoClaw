// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => ({ digests: [] as string[] }));

vi.mock("./candidate-authority", () => ({
  CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS: { pi: authority.digests },
  acceptedCandidateReceiptDigests: () => authority.digests,
}));

import {
  CANDIDATE_AGENT_FEATURE_ENV,
  CANDIDATE_QUALIFICATION_RECEIPT_ENV,
  CandidateQualificationError,
  isCandidateAgentSelectable,
  readCandidateQualificationReceipt,
  requireCandidateQualificationEnabled,
} from "./candidate";
import {
  candidateQualificationContract,
  type CandidateQualificationFixture,
  candidateQualificationEnvironment,
} from "./candidate-test-fixture";

let fixture: CandidateQualificationFixture | null = null;
const COMMITTED_PI_RECEIPTS = [
  ["linux/amd64", "ci/pi-agent-qualification-v1-linux-amd64.json"],
  ["linux/arm64", "ci/pi-agent-qualification-v1-linux-arm64.json"],
] as const;

function qualified(
  options: Parameters<typeof candidateQualificationEnvironment>[0] = {},
): NodeJS.ProcessEnv {
  fixture = candidateQualificationEnvironment(options);
  authority.digests.splice(0, authority.digests.length, fixture.receiptDigest);
  return fixture.env;
}

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
  authority.digests.splice(0, authority.digests.length);
});

describe("published candidate qualification authority", () => {
  it.each(COMMITTED_PI_RECEIPTS)(
    "accepts the committed %s Pi receipt through the published authority (#7927)",
    async (platform, relativePath) => {
      const published =
        await vi.importActual<typeof import("./candidate-authority")>("./candidate-authority");
      const receiptPath = path.resolve(import.meta.dirname, "../../..", relativePath);
      const digest = createHash("sha256").update(fs.readFileSync(receiptPath)).digest("hex");
      const publishedDigests = published.CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS.pi;

      expect(publishedDigests).toHaveLength(COMMITTED_PI_RECEIPTS.length);
      expect(publishedDigests).toContain(digest);
      authority.digests.splice(0, authority.digests.length, ...publishedDigests);
      const contract = readCandidateQualificationReceipt("pi", {
        [CANDIDATE_AGENT_FEATURE_ENV]: "1",
        [CANDIDATE_QUALIFICATION_RECEIPT_ENV]: receiptPath,
      });
      expect(contract.platform).toBe(platform);
    },
  );

  it("selects a candidate whose receipt digest the repository publishes (#7927)", () => {
    const env = qualified();

    expect(isCandidateAgentSelectable("pi", env)).toBe(true);
    expect(() => requireCandidateQualificationEnabled("pi", env)).not.toThrow();
  });

  it("returns the exact accepted image identity from the receipt (#7927)", () => {
    const contract = readCandidateQualificationReceipt("pi", qualified());

    expect(contract).toMatchObject({ agent: "pi", image: "ghcr.io/nvidia/nemoclaw/pi-sandbox" });
    expect(contract.reference).toBe(`${contract.image}@${contract.digest}`);
  });

  it("refuses a receipt whose contents change after publication (#7927)", () => {
    const env = qualified();
    fs.writeFileSync(
      String(env.NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT),
      `${JSON.stringify(candidateQualificationContract("pi"))} `,
    );

    expect(isCandidateAgentSelectable("pi", env)).toBe(false);
    expect(() => readCandidateQualificationReceipt("pi", env)).toThrow(
      "not a published qualification for that candidate",
    );
  });

  it("refuses a published receipt that claims a shipped agent (#7927)", () => {
    const contract = { ...candidateQualificationContract("pi"), agent: "hermes" as const };
    const env = qualified({ contract: contract as never });

    expect(() => readCandidateQualificationReceipt("pi", env)).toThrow(CandidateQualificationError);
    expect(() => readCandidateQualificationReceipt("pi", env)).toThrow(
      "failed closed contract validation",
    );
  });
});
