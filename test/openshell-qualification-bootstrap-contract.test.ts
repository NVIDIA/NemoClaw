// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  QUALIFICATION_REQUIRED_WORKFLOW_PATH,
  QUALIFICATION_REQUIRED_WORKFLOW_REF,
  QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID,
  validateBootstrapDraftTransition,
  validateBootstrapQualificationContract,
} from "../scripts/checks/openshell-qualification-bootstrap-contract.mts";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = path.join(REPO_ROOT, "ci/openshell-0.0.101-qualification-v1.json");
const VERSIONS = { baseVersion: "0.0.99", candidateVersion: "0.0.99" };
const VALID_CONTRACT = validateBootstrapQualificationContract(
  JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8")) as unknown,
);

function contract(): Record<string, unknown> {
  return structuredClone(VALID_CONTRACT) as unknown as Record<string, unknown>;
}

describe("OpenShell qualification draft bootstrap contract", () => {
  it("ships a full inert draft inventory without workflow authority (#8590)", () => {
    const parsed = validateBootstrapQualificationContract(contract());

    expect(parsed.lifecycle).toBe("bootstrap");
    expect(parsed.inventoryState).toBe("draft");
    expect(parsed.requiredWorkflowGate).toBeNull();
    expect(parsed.retirementEvidence).toBeNull();
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.tests).toHaveLength(14);
    expect(
      parsed.tests.every(
        (test) =>
          test.approvedExceptions.length === 0 &&
          test.matrix.lanes.length === 0 &&
          test.mappings.selector.status === "pending" &&
          test.mappings.selector.source === null &&
          test.mappings.final.status === "pending" &&
          test.mappings.final.source === null,
      ),
    ).toBe(true);
  });

  it("accepts trusted-base draft staging and later exact workflow authority (#8590)", () => {
    const base = contract();
    const unchangedCandidate = contract();
    const governedCandidate = contract();
    governedCandidate.requiredWorkflowGate = {
      organizationRulesetId: 24680,
      repositoryId: QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID,
      sourcePath: QUALIFICATION_REQUIRED_WORKFLOW_PATH,
      sourceRef: QUALIFICATION_REQUIRED_WORKFLOW_REF,
    };

    expect(validateBootstrapDraftTransition(base, unchangedCandidate, VERSIONS)).toBeTruthy();
    expect(validateBootstrapDraftTransition(base, governedCandidate, VERSIONS)).toMatchObject({
      requiredWorkflowGate: {
        organizationRulesetId: 24680,
        repositoryId: QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID,
        sourcePath: QUALIFICATION_REQUIRED_WORKFLOW_PATH,
        sourceRef: QUALIFICATION_REQUIRED_WORKFLOW_REF,
      },
    });
  });

  it("rejects candidate authority when the trusted base has no contract (#8590)", () => {
    expect(() => validateBootstrapDraftTransition(null, contract(), VERSIONS)).toThrow(
      "absent from the trusted base",
    );
  });

  it("rejects draft removal, version movement, and an authority rewrite (#8590)", () => {
    const governedBase = contract();
    governedBase.requiredWorkflowGate = {
      organizationRulesetId: 24680,
      repositoryId: QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID,
      sourcePath: QUALIFICATION_REQUIRED_WORKFLOW_PATH,
      sourceRef: QUALIFICATION_REQUIRED_WORKFLOW_REF,
    };
    const rewritten = structuredClone(governedBase);
    (rewritten.requiredWorkflowGate as { organizationRulesetId: number }).organizationRulesetId =
      13579;

    expect(() => validateBootstrapDraftTransition(contract(), null, VERSIONS)).toThrow(
      "cannot be removed",
    );
    expect(() =>
      validateBootstrapDraftTransition(contract(), contract(), {
        baseVersion: "0.0.99",
        candidateVersion: "0.0.101",
      }),
    ).toThrow("cannot change the pinned OpenShell version");
    expect(() => validateBootstrapDraftTransition(governedBase, rewritten, VERSIONS)).toThrow(
      "cannot change",
    );
  });

  it.each([
    ["a frozen inventory", { inventoryState: "frozen" }],
    ["a release lifecycle", { lifecycle: "final" }],
    ["an artifact", { artifacts: [{ name: "receipt" }] }],
    ["retirement evidence", { retirementEvidence: { releaseTag: "v0.0.101" } }],
    ["receipt acceptance", { qualificationReceipt: { result: "success" } }],
  ])("rejects %s in the bootstrap contract (#8590)", (_label, replacement) => {
    expect(() =>
      validateBootstrapQualificationContract({ ...contract(), ...replacement }),
    ).toThrow();
  });

  it("rejects active mappings, matrix lanes, and draft exceptions (#8590)", () => {
    const active = contract();
    const lane = contract();
    const exception = contract();
    const activeTests = active.tests as Array<Record<string, unknown>>;
    const laneTests = lane.tests as Array<Record<string, unknown>>;
    const exceptionTests = exception.tests as Array<Record<string, unknown>>;
    activeTests[0].mappings = {
      final: { source: null, status: "pending" },
      selector: { source: { workflowId: 1 }, status: "active" },
    };
    laneTests[0].matrix = { lanes: [{ id: "live" }] };
    exceptionTests[0].approvedExceptions = [{ reason: "skip" }];

    expect(() => validateBootstrapQualificationContract(active)).toThrow("must remain pending");
    expect(() => validateBootstrapQualificationContract(lane)).toThrow("must remain empty");
    expect(() => validateBootstrapQualificationContract(exception)).toThrow("must remain empty");
  });
});
