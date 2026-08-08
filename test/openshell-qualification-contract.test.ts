// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  activeQualificationTests,
  authenticateFinalQualificationReceipt,
  authenticateQualificationRetirement,
  createQualificationReceipt,
  loadQualificationContract,
  loadQualificationReceipt,
  parseBoundedJson,
  produceQualificationReceipt,
  QUALIFICATION_CONTRACT_PATH,
  QUALIFICATION_MAX_ARTIFACT_BYTES,
  QUALIFICATION_NEMOCLAW_REPOSITORY_BASELINE_SHA,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_COMMIT_SHA,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG_OBJECT_SHA,
  QUALIFICATION_PUBLIC_USER_BASELINE_COMMIT_SHA,
  QUALIFICATION_REPOSITORY_BASELINE_COMMIT_SHA,
  QUALIFICATION_SOURCE_RECEIPT_FILE,
  QUALIFICATION_TARGET_COMMIT_SHA,
  type QualificationArtifactReader,
  type QualificationContract,
  type QualificationExecutionContext,
  type QualificationGitHubReader,
  type QualificationPhase,
  type QualificationReceipt,
  readQualificationReceiptArchive,
  requireActiveQualificationTests,
  requiredQualificationTests,
  validateQualificationContract,
  validateQualificationLifecycleTransition,
  validateQualificationReceipt,
} from "../scripts/checks/openshell-qualification-contract.mts";
import {
  qualificationAuthorityPaths,
  renderQualificationRetirementTagMessage,
} from "../scripts/checks/openshell-qualification-core.mts";
import type { QualificationMatrix } from "../scripts/checks/openshell-qualification-matrix.mts";
import { artifactZip } from "./helpers/artifact-zip";
import {
  artifactProvenance,
  BASE_SHA,
  CANDIDATE_SHA,
  clone,
  contractValue,
  defaultExecutionContext,
  descriptor,
  expectation,
  PR_NUMBER,
  PRODUCER_WORKFLOW,
  qualificationCells,
  REPOSITORY,
  receiptInput,
  receiptRun,
  SOURCE_CONTROLLER,
  SOURCE_WORKFLOW,
  SOURCE_WORKFLOW_ID,
  source,
  validReceipt,
} from "./helpers/openshell-qualification-contract-fixture";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("OpenShell 0.0.101 qualification contract", () => {
  it("loads the initial bootstrap contract with exact identities and every mapping pending", () => {
    const contract = loadQualificationContract(
      path.join(import.meta.dirname, "..", QUALIFICATION_CONTRACT_PATH),
    );

    expect(contract).toMatchObject({
      lifecycle: "bootstrap",
      nemoclawRepositoryBaselineSha: QUALIFICATION_NEMOCLAW_REPOSITORY_BASELINE_SHA,
      nemoclawUserBaselineTag: QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG,
      nemoclawUserBaselineTagObjectSha: QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG_OBJECT_SHA,
      nemoclawUserBaselineCommitSha: QUALIFICATION_NEMOCLAW_USER_BASELINE_COMMIT_SHA,
      openshellRepositoryBaselineVersion: "0.0.99",
      openshellRepositoryBaselineTag: "v0.0.99",
      openshellRepositoryBaselineCommitSha: QUALIFICATION_REPOSITORY_BASELINE_COMMIT_SHA,
      openshellBaselineVersion: "0.0.85",
      openshellBaselineTag: "v0.0.85",
      openshellBaselineCommitSha: QUALIFICATION_PUBLIC_USER_BASELINE_COMMIT_SHA,
      openshellTargetVersion: "0.0.101",
      openshellTargetTag: "v0.0.101",
      openshellTargetCommitSha: QUALIFICATION_TARGET_COMMIT_SHA,
    });
    expect(requiredQualificationTests(contract, "selector")).toHaveLength(14);
    expect(requiredQualificationTests(contract, "final")).toHaveLength(11);
    expect(activeQualificationTests(contract, "selector")).toEqual([]);
    expect(activeQualificationTests(contract, "final")).toEqual([]);
    expect(
      contract.tests.flatMap((test) =>
        Object.values(test.mappings).map((mapping) => mapping?.status),
      ),
    ).toEqual(Array(28).fill("pending"));
  });

  it("rejects every receipt while the bootstrap inventory is draft", () => {
    const draft = contractValue("bootstrap", {
      tests: [descriptor({ final: "pending", selector: "pending" })],
    });
    expect(() =>
      createQualificationReceipt(draft, {
        ...receiptInput("selector"),
        tests: [],
      }),
    ).toThrow("draft inventory");
  });

  it("permits staged required-workflow authority only in draft and requires it before freeze", () => {
    const draft = contractValue("bootstrap", {
      requiredWorkflowGate: null,
      tests: [
        descriptor({
          final: "pending",
          finalPendingSource: true,
          selector: "pending",
          selectorPendingSource: true,
        }),
      ],
    });
    expect(() => validateQualificationContract(draft)).not.toThrow();

    const frozen = clone(draft);
    frozen.inventoryState = "frozen";
    expect(() => validateQualificationContract(frozen)).toThrow(
      "requires organization required-workflow authority",
    );
  });

  it("requires every selector mapping in selector lifecycle and every final mapping in final lifecycle", () => {
    expect(() =>
      validateQualificationContract(
        contractValue("selector", { tests: [descriptor({ selector: "pending" })] }),
      ),
    ).toThrow("no staged selector source");
    expect(() =>
      validateQualificationContract(
        contractValue("final", {
          tests: [descriptor({ final: "pending", finalPendingSource: true })],
        }),
      ),
    ).toThrow("pending source mappings");
    expect(
      requireActiveQualificationTests(validateQualificationContract(contractValue()), "selector"),
    ).toHaveLength(1);
    expect(() =>
      createQualificationReceipt(contractValue("retired"), receiptInput("final")),
    ).toThrow("require final lifecycle");
  });

  it("requires the exact repository-baseline known-failure control beside keepalive target-pass coverage", () => {
    const targetOnly = descriptor({ id: "openshell-00101-keepalive" });
    expect(() =>
      validateQualificationContract(contractValue("selector", { tests: [targetOnly] })),
    ).toThrow("known-failure control lane");

    const controlled = clone(targetOnly) as Omit<typeof targetOnly, "matrix"> & {
      matrix: QualificationMatrix;
    };
    controlled.matrix.lanes.push({
      agents: ["openclaw"],
      artifactComponents: ["cli"],
      behaviors: ["real-runtime"],
      expectedOutcome: "known-failure",
      id: "repository-baseline-control",
      paths: ["keepalive"],
      platforms: [
        {
          accelerator: "cpu",
          architecture: "amd64",
          id: "ubuntu-amd64-cpu",
          operatingSystem: "ubuntu",
        },
      ],
      runtimes: ["docker"],
      runtimeVersions: [
        {
          commitSha: QUALIFICATION_REPOSITORY_BASELINE_COMMIT_SHA,
          version: "0.0.99",
        },
      ],
    });
    expect(() =>
      validateQualificationContract(contractValue("selector", { tests: [controlled] })),
    ).not.toThrow();
  });

  it("accepts the largest aggregate cell inventory and rejects one cell over", () => {
    const largest = descriptor({ id: "largest-proof" });
    largest.matrix.lanes[0]!.runtimes = Array.from(
      { length: 32 },
      (_entry, index) => `runtime-${index}`,
    );
    largest.matrix.lanes[0]!.paths = Array.from({ length: 32 }, (_entry, index) => `path-${index}`);
    expect(() =>
      validateQualificationContract(contractValue("selector", { tests: [largest] })),
    ).not.toThrow();
    expect(() =>
      validateQualificationContract(
        contractValue("selector", {
          tests: [largest, descriptor({ id: "one-more-proof" })],
        }),
      ),
    ).toThrow("aggregate receipt cell budget");
  });

  it("allows draft correction, freezes only with a state-only flip, then permits monotonic lifecycle changes", () => {
    const draft = contractValue("bootstrap", {
      tests: [
        descriptor({
          final: "pending",
          finalPendingSource: true,
          selector: "pending",
          selectorPendingSource: true,
        }),
      ],
    });
    const correctedDraft = clone(draft);
    correctedDraft.requiredStatusRulesetId += 1;
    correctedDraft.trustedProducerWorkflowPath = ".github/workflows/replacement-producer.yaml";
    correctedDraft.artifacts = correctedDraft.artifacts.slice(0, 1);
    correctedDraft.tests = [
      descriptor({
        final: "pending",
        finalPendingSource: true,
        id: "replacement-proof",
        selector: "pending",
        selectorPendingSource: true,
      }),
    ];
    expect(
      validateQualificationLifecycleTransition(draft, correctedDraft, {
        baselineVersion: "0.0.99",
        targetVersion: "0.0.99",
      }),
    ).toEqual(validateQualificationContract(correctedDraft));

    const frozen = clone(draft);
    frozen.inventoryState = "frozen";
    expect(
      validateQualificationLifecycleTransition(draft, frozen, {
        baselineVersion: "0.0.99",
        targetVersion: "0.0.99",
      }).inventoryState,
    ).toBe("frozen");
    const changedDuringFreeze = clone(frozen);
    changedDuringFreeze.artifacts[0]!.name = "changed-during-freeze";
    expect(() =>
      validateQualificationLifecycleTransition(draft, changedDuringFreeze, {
        baselineVersion: "0.0.99",
        targetVersion: "0.0.99",
      }),
    ).toThrow("state-only");
    const returnedToDraft = clone(frozen);
    returnedToDraft.inventoryState = "draft";
    expect(() =>
      validateQualificationLifecycleTransition(frozen, returnedToDraft, {
        baselineVersion: "0.0.99",
        targetVersion: "0.0.99",
      }),
    ).toThrow("cannot return to draft");

    const selector = contractValue("selector", {
      tests: [descriptor({ final: "pending", finalPendingSource: true })],
    });
    const final = contractValue("final");
    const retired = contractValue("retired");

    expect(
      validateQualificationLifecycleTransition(frozen, selector, {
        baselineVersion: "0.0.99",
        targetVersion: "0.0.99",
      }).lifecycle,
    ).toBe("selector");
    expect(
      validateQualificationLifecycleTransition(selector, selector, {
        baselineVersion: "0.0.99",
        targetVersion: "0.0.101",
      }).lifecycle,
    ).toBe("selector");
    expect(
      validateQualificationLifecycleTransition(selector, final, {
        baselineVersion: "0.0.101",
        targetVersion: "0.0.101",
      }).lifecycle,
    ).toBe("final");
    expect(
      validateQualificationLifecycleTransition(final, retired, {
        baselineVersion: "0.0.101",
        targetVersion: "0.0.101",
      }).lifecycle,
    ).toBe("retired");
    expect(() =>
      validateQualificationLifecycleTransition(frozen, final, {
        baselineVersion: "0.0.99",
        targetVersion: "0.0.99",
      }),
    ).toThrow("bootstrap -> final");
    const changed = clone(selector);
    changed.tests[0]!.mappings.selector = { source: null, status: "pending" };
    expect(() =>
      validateQualificationLifecycleTransition(selector, changed, {
        baselineVersion: "0.0.99",
        targetVersion: "0.0.99",
      }),
    ).toThrow("no staged selector source");
  });

  it("requires a source before freezing and exact base-owned pending sources before activation", () => {
    const incompleteDraft = contractValue("bootstrap", {
      tests: [descriptor({ final: "pending", selector: "pending" })],
    });
    const incompleteFreeze = clone(incompleteDraft);
    incompleteFreeze.inventoryState = "frozen";
    expect(() => validateQualificationContract(incompleteFreeze)).toThrow(
      "no staged selector source",
    );
    incompleteFreeze.tests[0]!.mappings.selector = {
      source: source("selector"),
      status: "pending",
    };
    expect(() => validateQualificationContract(incompleteFreeze)).toThrow("no staged final source");

    const stagedDraft = contractValue("bootstrap", {
      tests: [
        descriptor({
          final: "pending",
          finalPendingSource: true,
          selector: "pending",
          selectorPendingSource: true,
        }),
      ],
    });
    const frozen = clone(stagedDraft);
    frozen.inventoryState = "frozen";
    const selector = contractValue("selector", {
      tests: [descriptor({ final: "pending", finalPendingSource: true })],
    });
    expect(
      validateQualificationLifecycleTransition(frozen, selector, {
        baselineVersion: "0.0.99",
        targetVersion: "0.0.99",
      }).lifecycle,
    ).toBe("selector");

    const changedAtPromotion = clone(selector);
    changedAtPromotion.tests[0]!.mappings.selector = {
      source: { ...source("selector"), workflowId: 100 },
      status: "active",
    };
    expect(() =>
      validateQualificationLifecycleTransition(frozen, changedAtPromotion, {
        baselineVersion: "0.0.99",
        targetVersion: "0.0.99",
      }),
    ).toThrow("base-owned");

    const selectorWithBadFinal = clone(selector);
    const badFinalSource = source("final");
    badFinalSource.workflowId = 101;
    selectorWithBadFinal.tests[0]!.mappings.final = {
      source: badFinalSource,
      status: "pending",
    };
    const selectorWithCorrectedFinal = clone(selectorWithBadFinal);
    selectorWithCorrectedFinal.tests[0]!.mappings.final = {
      source: source("final"),
      status: "pending",
    };
    expect(() =>
      validateQualificationLifecycleTransition(selectorWithBadFinal, selectorWithCorrectedFinal, {
        baselineVersion: "0.0.99",
        targetVersion: "0.0.99",
      }),
    ).toThrow("changed frozen pending");
    expect(() =>
      validateQualificationLifecycleTransition(selectorWithBadFinal, selectorWithCorrectedFinal, {
        baselineVersion: "0.0.101",
        targetVersion: "0.0.101",
      }),
    ).toThrow("changed frozen pending");
    expect(
      validateQualificationLifecycleTransition(selectorWithCorrectedFinal, contractValue("final"), {
        baselineVersion: "0.0.101",
        targetVersion: "0.0.101",
      }).lifecycle,
    ).toBe("final");
  });

  it.each([
    ["NemoClaw repository baseline", { nemoclawRepositoryBaselineSha: "c".repeat(40) }],
    ["NemoClaw user baseline tag", { nemoclawUserBaselineTag: "v0.0.103" }],
    ["NemoClaw user baseline tag object", { nemoclawUserBaselineTagObjectSha: "c".repeat(40) }],
    ["NemoClaw user baseline commit", { nemoclawUserBaselineCommitSha: "c".repeat(40) }],
    ["repository baseline version", { openshellRepositoryBaselineVersion: "0.0.98" }],
    ["repository baseline tag", { openshellRepositoryBaselineTag: "v0.0.98" }],
    ["repository baseline commit", { openshellRepositoryBaselineCommitSha: "c".repeat(40) }],
    ["public-user baseline commit", { openshellBaselineCommitSha: "c".repeat(40) }],
    ["target version", { openshellTargetVersion: "0.0.100" }],
    ["target commit", { openshellTargetCommitSha: "c".repeat(40) }],
  ])("rejects an unapproved %s identity", (_label, overrides) => {
    expect(() => validateQualificationContract(contractValue("selector", overrides))).toThrow(
      /identity/u,
    );
  });
});

describe("qualification receipt fail-closed validation", () => {
  it("accepts exact selector, final-promotion, and release receipts", () => {
    expect(
      validateQualificationReceipt(validReceipt("selector"), contractValue(), expectation()),
    ).toEqual(validReceipt("selector"));
    expect(
      validateQualificationReceipt(
        validReceipt("final", "final-promotion"),
        contractValue("final"),
        expectation("final", "final-promotion"),
      ),
    ).toEqual(validReceipt("final", "final-promotion"));
    expect(
      validateQualificationReceipt(
        validReceipt("final"),
        contractValue("final"),
        expectation("final"),
      ),
    ).toEqual(validReceipt("final"));
  });

  it("rejects an unknown selector receipt schema (#8600)", () => {
    const receipt = clone(validReceipt("selector"));
    (receipt as unknown as Record<string, unknown>).schemaVersion = 2;

    expect(() => validateQualificationReceipt(receipt, contractValue(), expectation())).toThrow(
      "schemaVersion is unsupported",
    );
  });

  it("rejects phase/context crossings and candidate-controlled promotion receipts", () => {
    const crossed = clone(validReceipt());
    crossed.executionContext = "final-promotion";
    expect(() => validateQualificationReceipt(crossed, contractValue(), expectation())).toThrow(
      "phase and execution context",
    );

    const promotion = clone(validReceipt("final", "final-promotion"));
    promotion.trustedProducerWorkflowSha = CANDIDATE_SHA;
    expect(() =>
      validateQualificationReceipt(
        promotion,
        contractValue("final"),
        expectation("final", "final-promotion"),
      ),
    ).toThrow("producer workflow identity");
  });

  it.each([
    ["phase", "phase", "final"],
    ["event", "event", "push"],
    ["pull request", "prNumber", 8601],
    ["base", "baseSha", "c".repeat(40)],
    ["candidate", "candidateSha", "c".repeat(40)],
    ["controller", "controllerSha", "c".repeat(40)],
    ["workflow ID", "workflowId", 88],
    ["workflow path", "workflowPath", ".github/workflows/other.yaml"],
    ["target version", "openshellVersion", "0.0.100"],
    ["target commit", "openshellCommitSha", "c".repeat(40)],
    ["authority paths", "authorityPaths", [SOURCE_WORKFLOW]],
    ["required cases", "requiredCases", ["real-runtime"]],
    ["required dimensions", "requiredDimensions", ["cpu"]],
  ])("rejects mismatched source %s evidence", (_label, key, value) => {
    const receipt = clone(validReceipt());
    (receipt.tests[0]!.runs[0] as unknown as Record<string, unknown>)[key] = value;
    expect(() => validateQualificationReceipt(receipt, contractValue(), expectation())).toThrow();
  });

  it.each([
    "failure",
    "skipped",
    "cancelled",
    "canceled",
  ])("rejects %s at the test, run, or job boundary", (result) => {
    for (const location of ["test", "run", "job"] as const) {
      const receipt = clone(validReceipt());
      if (location === "test") receipt.tests[0]!.result = result as "failure";
      if (location === "run") receipt.tests[0]!.runs[0]!.result = result as "failure";
      if (location === "job") receipt.tests[0]!.runs[0]!.jobs[0]!.result = result as "failure";
      expect(() => validateQualificationReceipt(receipt, contractValue(), expectation())).toThrow(
        "not successful",
      );
    }
  });

  it("rejects missing, extra, stale, and cross-phase test evidence", () => {
    const missing = clone(validReceipt());
    missing.tests.pop();
    expect(() => validateQualificationReceipt(missing, contractValue(), expectation())).toThrow(
      "required test set",
    );
    const extra = clone(validReceipt());
    extra.tests.push({ id: "extra-proof", result: "success", runs: [receiptRun("selector")] });
    expect(() => validateQualificationReceipt(extra, contractValue(), expectation())).toThrow(
      "no active source mapping",
    );
    const oldBase = clone(validReceipt());
    oldBase.tests[0]!.runs[0]!.baseSha = "c".repeat(40);
    expect(() => validateQualificationReceipt(oldBase, contractValue(), expectation())).toThrow();
    const selectorAsFinal = clone(validReceipt());
    expect(() =>
      validateQualificationReceipt(selectorAsFinal, contractValue("final"), expectation("final")),
    ).toThrow();
  });

  it("rejects missing, linked, duplicate-key, and oversized receipt files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-qualification-files-"));
    tempRoots.push(root);
    const contractPath = path.join(root, "contract.json");
    const receiptPath = path.join(root, "receipt.json");
    fs.writeFileSync(contractPath, `${JSON.stringify(contractValue())}\n`);
    fs.writeFileSync(receiptPath, `${JSON.stringify(validReceipt())}\n`);
    const contract = loadQualificationContract(contractPath);

    expect(loadQualificationReceipt(receiptPath, contract, expectation())).toMatchObject({
      candidateSha: CANDIDATE_SHA,
    });
    expect(() =>
      loadQualificationReceipt(path.join(root, "missing.json"), contract, expectation()),
    ).toThrow("missing");
    fs.symlinkSync(receiptPath, path.join(root, "linked.json"));
    expect(() =>
      loadQualificationReceipt(path.join(root, "linked.json"), contract, expectation()),
    ).toThrow("non-link");
    expect(() => parseBoundedJson('{"schemaVersion":1,"schemaVersion":2}', "receipt")).toThrow(
      "duplicate object key",
    );
    expect(() =>
      parseBoundedJson(`{"padding":"${"x".repeat(2 * 1024 * 1024)}"}`, "receipt"),
    ).toThrow("oversized");
  });

  it("accepts one exact receipt archive and rejects duplicate, unsafe, and oversized archives", () => {
    const contract = validateQualificationContract(contractValue());
    const sourceJson = JSON.stringify(validReceipt());
    expect(
      readQualificationReceiptArchive(
        artifactZip([{ name: "qualification.json", contents: sourceJson }]),
        contract,
        expectation(),
      ),
    ).toMatchObject({ candidateSha: CANDIDATE_SHA });
    for (const archive of [
      artifactZip([
        { name: "qualification.json", contents: sourceJson },
        { name: "qualification.json", contents: sourceJson },
      ]),
      artifactZip([
        { name: "../qualification.json", contents: sourceJson },
        { name: "qualification.json", contents: sourceJson },
      ]),
      Buffer.alloc(QUALIFICATION_MAX_ARTIFACT_BYTES + 1),
    ]) {
      expect(() => readQualificationReceiptArchive(archive, contract, expectation())).toThrow();
    }
  });
});

function finalArtifactApi(
  archivedReceipt: QualificationReceipt,
  overrides: {
    ancestor?: boolean;
    newerRun?: { conclusion: string | null; status: string };
    runAttempt?: number;
  } = {},
): QualificationArtifactReader {
  const runAttempt = overrides.runAttempt ?? 1;
  const fallback = producerApi({ executionContext: "release", phase: "final" });
  return {
    async getBytes(apiPath) {
      return apiPath === `repos/${REPOSITORY}/actions/artifacts/901/zip`
        ? artifactZip([{ name: "qualification.json", contents: JSON.stringify(archivedReceipt) }])
        : fallback.getBytes(apiPath);
    },
    async getJson(apiPath) {
      if (apiPath.endsWith("/actions/workflows/openshell-0.0.101-qualification.yaml")) {
        return { id: 44, path: PRODUCER_WORKFLOW, state: "active" };
      }
      if (apiPath.includes("/actions/workflows/openshell-0.0.101-qualification.yaml/runs?")) {
        const workflowRuns: Array<Record<string, unknown>> = [
          {
            conclusion: "success",
            display_title: `OpenShell 0.0.101 release candidate ${CANDIDATE_SHA} base ${BASE_SHA}`,
            event: "workflow_dispatch",
            head_branch: "main",
            head_sha: CANDIDATE_SHA,
            html_url: `https://github.com/${REPOSITORY}/actions/runs/900`,
            id: 900,
            path: PRODUCER_WORKFLOW,
            repository: { full_name: REPOSITORY },
            run_attempt: runAttempt,
            status: "completed",
            workflow_id: 44,
          },
        ];
        if (overrides.newerRun) {
          workflowRuns.push({
            ...workflowRuns[0]!,
            conclusion: overrides.newerRun.conclusion,
            html_url: `https://github.com/${REPOSITORY}/actions/runs/901`,
            id: 901,
            status: overrides.newerRun.status,
          });
        }
        return { total_count: workflowRuns.length, workflow_runs: workflowRuns };
      }
      if (apiPath === `repos/${REPOSITORY}/actions/runs/900/artifacts?per_page=100&page=1`) {
        return {
          artifacts: [
            {
              archive_download_url: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/901/zip`,
              expired: false,
              id: 901,
              name: `openshell-0.0.101-qualification-release-900-${runAttempt}`,
              workflow_run: { head_sha: CANDIDATE_SHA, id: 900 },
            },
          ],
          total_count: 1,
        };
      }
      return fallback.getJson(apiPath);
    },
  };
}

const RETIREMENT_AUTHORITY_SHA = "d".repeat(40);
const RELEASE_TAG_OBJECT_SHA = "e".repeat(40);

function sha256(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

function retirementAuthenticationFixture(
  overrides: {
    ancestor?: boolean;
    authorityDriftPath?: string;
    currentMainSha?: string;
    finalContractSha256?: string;
    finalReceiptSha256?: string;
    releaseBaseSha?: string;
    releaseCandidateSha?: string;
    signedMessageSuffix?: string;
    signedPayloadSuffix?: string;
    signatureKind?: "pgp" | "ssh";
    tagObjectSha?: string;
    tagVerified?: boolean;
  } = {},
) {
  const finalContract = validateQualificationContract(contractValue("final"));
  const finalContractSource = `${JSON.stringify(finalContract, null, 2)}\n`;
  const receipt = validReceipt("final");
  const finalReceiptSource = JSON.stringify(receipt);
  const metadata = {
    finalContractSha256: overrides.finalContractSha256 ?? sha256(finalContractSource),
    finalReceiptSha256: overrides.finalReceiptSha256 ?? sha256(finalReceiptSource),
    releaseBaseSha: overrides.releaseBaseSha ?? BASE_SHA,
    releaseCandidateSha: overrides.releaseCandidateSha ?? CANDIDATE_SHA,
    releaseTag: "v0.0.2",
    schemaVersion: 1 as const,
    scope: "NVIDIA/NemoClaw#8590" as const,
    trustedProducerRunAttempt: 1,
    trustedProducerRunId: "900",
    trustedProducerWorkflowSha: CANDIDATE_SHA,
  };
  const retirementContract = validateQualificationContract({
    ...finalContract,
    lifecycle: "retired",
    retirementEvidence: {
      ...metadata,
      releaseTagObjectSha: overrides.tagObjectSha ?? RELEASE_TAG_OBJECT_SHA,
    },
  });
  const fallback = finalArtifactApi(receipt);
  const authorityPaths = qualificationAuthorityPaths(finalContract, true);
  const blobForPath = (entryPath: string): string => {
    if (entryPath === SOURCE_WORKFLOW) return "1".repeat(40);
    if (entryPath === SOURCE_CONTROLLER) return "2".repeat(40);
    return createHash("sha1").update(entryPath).digest("hex");
  };
  const tree = (authoritySha: string) => ({
    tree: authorityPaths.map((entryPath) => ({
      mode: entryPath === SOURCE_CONTROLLER ? "100755" : "100644",
      path: entryPath,
      sha:
        authoritySha === RETIREMENT_AUTHORITY_SHA && entryPath === overrides.authorityDriftPath
          ? "f".repeat(40)
          : blobForPath(entryPath),
      type: "blob",
    })),
    truncated: false,
  });
  const api: QualificationArtifactReader = {
    getBytes: fallback.getBytes,
    async getJson(apiPath) {
      if (
        apiPath ===
        `repos/${REPOSITORY}/contents/${QUALIFICATION_CONTRACT_PATH}?ref=${CANDIDATE_SHA}`
      ) {
        return {
          content: Buffer.from(finalContractSource, "utf8").toString("base64"),
          encoding: "base64",
          sha: "a".repeat(40),
          size: Buffer.byteLength(finalContractSource, "utf8"),
          type: "file",
        };
      }
      if (apiPath === `repos/${REPOSITORY}/git/ref/tags/v0.0.2`) {
        return {
          object: {
            sha: RELEASE_TAG_OBJECT_SHA,
            type: "tag",
          },
          ref: "refs/tags/v0.0.2",
        };
      }
      if (apiPath === `repos/${REPOSITORY}/git/tags/${RELEASE_TAG_OBJECT_SHA}`) {
        const tagMessage = renderQualificationRetirementTagMessage(metadata);
        const signature =
          overrides.signatureKind === "pgp"
            ? "-----BEGIN PGP SIGNATURE-----\nmock-pgp-signature\n-----END PGP SIGNATURE-----\n"
            : "-----BEGIN SSH SIGNATURE-----\nmock-ssh-signature\n-----END SSH SIGNATURE-----\n";
        const payload = [
          `object ${CANDIDATE_SHA}`,
          "type commit",
          "tag v0.0.2",
          "tagger Release Signer <release@example.test> 1786071728 +0000",
          "",
          `${tagMessage}\n${overrides.signedPayloadSuffix ?? ""}`,
        ].join("\n");
        return {
          message: `${tagMessage}\n${signature}${overrides.signedMessageSuffix ?? ""}`,
          object: { sha: CANDIDATE_SHA, type: "commit" },
          sha: RELEASE_TAG_OBJECT_SHA,
          tag: "v0.0.2",
          tagger: {
            date: "2026-08-07T03:02:08Z",
            email: "release@example.test",
            name: "Release Signer",
          },
          verification: {
            payload,
            reason: overrides.tagVerified === false ? "unknown_key" : "valid",
            signature,
            verified: overrides.tagVerified !== false,
          },
        };
      }
      if (apiPath === `repos/${REPOSITORY}/commits/${CANDIDATE_SHA}`) {
        return { parents: [{ sha: BASE_SHA }], sha: CANDIDATE_SHA };
      }
      if (
        apiPath === `repos/${REPOSITORY}/compare/${CANDIDATE_SHA}...${RETIREMENT_AUTHORITY_SHA}`
      ) {
        if (overrides.ancestor === false) {
          return {
            base_commit: { sha: CANDIDATE_SHA },
            head_commit: { sha: RETIREMENT_AUTHORITY_SHA },
            merge_base_commit: { sha: BASE_SHA },
            status: "diverged",
          };
        }
        return {
          base_commit: { sha: CANDIDATE_SHA },
          head_commit: { sha: RETIREMENT_AUTHORITY_SHA },
          merge_base_commit: { sha: CANDIDATE_SHA },
          status: "ahead",
        };
      }
      if (apiPath === `repos/${REPOSITORY}/git/ref/heads/main`) {
        return { object: { sha: overrides.currentMainSha ?? RETIREMENT_AUTHORITY_SHA } };
      }
      if (apiPath === `repos/${REPOSITORY}/git/trees/${CANDIDATE_SHA}?recursive=1`) {
        return tree(CANDIDATE_SHA);
      }
      if (apiPath === `repos/${REPOSITORY}/git/trees/${RETIREMENT_AUTHORITY_SHA}?recursive=1`) {
        return tree(RETIREMENT_AUTHORITY_SHA);
      }
      return fallback.getJson(apiPath);
    },
  };
  return { api, finalContract, retirementContract };
}

describe("final qualification receipt authentication", () => {
  it("accepts receipt bytes from the newest exact final producer attempt", async () => {
    const receipt = validReceipt("final");
    await expect(
      authenticateFinalQualificationReceipt(
        receipt,
        contractValue("final"),
        expectation("final"),
        finalArtifactApi(receipt),
      ),
    ).resolves.toEqual(receipt);
  });

  it("binds release metadata to the exact authenticated artifact bytes", async () => {
    const receipt = validReceipt("final");
    const artifactBytes = Buffer.from(JSON.stringify(receipt), "utf8");
    await expect(
      authenticateFinalQualificationReceipt(
        receipt,
        contractValue("final"),
        expectation("final"),
        finalArtifactApi(receipt),
        { expectedReceiptBytes: artifactBytes },
      ),
    ).resolves.toEqual(receipt);

    await expect(
      authenticateFinalQualificationReceipt(
        receipt,
        contractValue("final"),
        expectation("final"),
        finalArtifactApi(receipt),
        {
          expectedReceiptBytes: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"),
        },
      ),
    ).rejects.toThrow("receipt bytes do not match");
  });

  it("rejects a newer failed producer run and mismatched run attempts", async () => {
    const receipt = validReceipt("final");
    await expect(
      authenticateFinalQualificationReceipt(
        receipt,
        contractValue("final"),
        expectation("final"),
        finalArtifactApi(receipt, { newerRun: { conclusion: "failure", status: "completed" } }),
      ),
    ).rejects.toThrow("workflow run");
    await expect(
      authenticateFinalQualificationReceipt(
        receipt,
        contractValue("final"),
        expectation("final"),
        finalArtifactApi(receipt, { runAttempt: 2 }),
      ),
    ).rejects.toThrow("workflow run");
  });

  it("rejects a PR-time final-promotion receipt at the post-merge release boundary", async () => {
    const promotion = validReceipt("final", "final-promotion");
    await expect(
      authenticateFinalQualificationReceipt(
        promotion,
        contractValue("final"),
        expectation("final", "final-promotion"),
        finalArtifactApi(promotion),
      ),
    ).rejects.toThrow("requires a release receipt");
  });
});

describe("qualification retirement authentication", () => {
  it.each([
    "ssh",
    "pgp",
  ] as const)("reauthenticates a %s-signed tagged final receipt against a later exact main authority", async (signatureKind) => {
    const fixture = retirementAuthenticationFixture({ signatureKind });

    await expect(
      authenticateQualificationRetirement(
        fixture.retirementContract,
        {
          authoritySha: RETIREMENT_AUTHORITY_SHA,
          includeFinalContractInAuthority: true,
          repository: REPOSITORY,
        },
        fixture.api,
      ),
    ).resolves.toEqual(fixture.retirementContract.retirementEvidence);
  });

  it.each([
    ["unverified tag object", { tagVerified: false }, "tag object is unverified"],
    [
      "signed message suffix",
      { signedMessageSuffix: "unverified suffix" },
      "tag object is unverified",
    ],
    [
      "signed payload suffix",
      { signedPayloadSuffix: "unverified suffix" },
      "tag object is unverified",
    ],
    ["moved tag object", { tagObjectSha: "f".repeat(40) }, "tag ref is missing, moved"],
    ["moved current authority", { currentMainSha: "f".repeat(40) }, "current main commit"],
    ["non-ancestor release candidate", { ancestor: false }, "not an ancestor"],
    ["wrong release first parent", { releaseBaseSha: "f".repeat(40) }, "first-parent identity"],
    ["changed frozen authority", { authorityDriftPath: SOURCE_CONTROLLER }, "authority path"],
    [
      "changed frozen release skill",
      {
        authorityDriftPath: ".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md",
      },
      "authority path",
    ],
    [
      "wrong final contract digest",
      { finalContractSha256: "f".repeat(64) },
      "final contract digest",
    ],
    ["wrong final receipt digest", { finalReceiptSha256: "f".repeat(64) }, "final receipt digest"],
  ])("rejects retirement evidence with a %s", async (_label, overrides, message) => {
    const fixture = retirementAuthenticationFixture(overrides);

    await expect(
      authenticateQualificationRetirement(
        fixture.retirementContract,
        {
          authoritySha: RETIREMENT_AUTHORITY_SHA,
          includeFinalContractInAuthority: true,
          repository: REPOSITORY,
        },
        fixture.api,
      ),
    ).rejects.toThrow(message);
  });
});

function sourceReceipt(
  phase: QualificationPhase,
  runId: number,
  runAttempt: number,
  testIds: string[] = ["shared-proof"],
  overrides: Record<string, unknown> = {},
  executionContext: QualificationExecutionContext = defaultExecutionContext(phase),
) {
  return {
    artifacts: artifactProvenance(),
    schemaVersion: 1,
    scope: "NVIDIA/NemoClaw#8590",
    repository: REPOSITORY,
    phase,
    executionContext,
    event: phase === "selector" ? "workflow_dispatch" : "push",
    prNumber: executionContext === "release" ? null : PR_NUMBER,
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    controllerSha: executionContext === "release" ? CANDIDATE_SHA : BASE_SHA,
    workflowId: SOURCE_WORKFLOW_ID,
    workflowPath: SOURCE_WORKFLOW,
    runId: String(runId),
    runAttempt,
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}`,
    authorityPaths: [SOURCE_WORKFLOW, SOURCE_CONTROLLER],
    openshellVersion: "0.0.101",
    openshellCommitSha: QUALIFICATION_TARGET_COMMIT_SHA,
    result: "success",
    tests: testIds.map((id) => ({
      cells: qualificationCells(runId),
      id,
      jobs: [
        {
          name: "Source proof",
          result: "success",
          url: `https://github.com/${REPOSITORY}/actions/runs/${runId}/job/501`,
        },
      ],
      requiredCases: ["exact-candidate-base", "real-runtime"],
      requiredDimensions: ["all-registered-agents", "cpu"],
      result: "success",
    })),
    ...overrides,
  };
}

function producerApi(
  options: {
    authorityDrift?: boolean;
    mutateSource?: Record<string, unknown>;
    sourceHeadBranch?: string;
    newerRun?: { conclusion: string | null; status: string };
    recheckAttempt?: number;
    recheckAtLookup?: number;
    sourceTestIds?: string[];
    executionContext?: QualificationExecutionContext;
    phase?: QualificationPhase;
    pullRequest?: {
      baseRef?: string;
      baseSha?: string;
      candidateRepository?: string;
      candidateSha?: string;
      number?: number;
      state?: string;
    };
  } = {},
): QualificationGitHubReader {
  let sourceRunLookups = 0;
  const phase = options.phase ?? "selector";
  const executionContext = options.executionContext ?? defaultExecutionContext(phase);
  const sourceEvent = phase === "selector" ? "workflow_dispatch" : "push";
  const runHeadSha =
    executionContext !== "release" && sourceEvent === "workflow_dispatch"
      ? BASE_SHA
      : CANDIDATE_SHA;
  return {
    async getBytes(apiPath) {
      expect(apiPath).toBe(`repos/${REPOSITORY}/actions/artifacts/601/zip`);
      const receipt = sourceReceipt(
        phase,
        101,
        1,
        options.sourceTestIds,
        options.mutateSource,
        executionContext,
      );
      return artifactZip([
        { name: QUALIFICATION_SOURCE_RECEIPT_FILE, contents: JSON.stringify(receipt) },
      ]);
    },
    async getJson(apiPath) {
      if (apiPath === `repos/${REPOSITORY}/pulls/${PR_NUMBER}`) {
        return {
          number: options.pullRequest?.number ?? PR_NUMBER,
          state: options.pullRequest?.state ?? "open",
          head: {
            sha: options.pullRequest?.candidateSha ?? CANDIDATE_SHA,
            repo: { full_name: options.pullRequest?.candidateRepository ?? REPOSITORY },
          },
          base: {
            ref: options.pullRequest?.baseRef ?? "main",
            sha: options.pullRequest?.baseSha ?? BASE_SHA,
            repo: { full_name: REPOSITORY },
          },
        };
      }
      if (apiPath === `repos/${REPOSITORY}/git/ref/heads/main`) {
        return { object: { sha: CANDIDATE_SHA } };
      }
      if (apiPath === `repos/${REPOSITORY}/commits/${CANDIDATE_SHA}`) {
        return { parents: [{ sha: BASE_SHA }] };
      }
      if (apiPath === `repos/${REPOSITORY}/git/trees/${BASE_SHA}?recursive=1`) {
        return {
          truncated: false,
          tree: [
            { mode: "100644", path: SOURCE_WORKFLOW, sha: "1".repeat(40), type: "blob" },
            { mode: "100755", path: SOURCE_CONTROLLER, sha: "2".repeat(40), type: "blob" },
          ],
        };
      }
      if (apiPath === `repos/${REPOSITORY}/git/trees/${CANDIDATE_SHA}?recursive=1`) {
        return {
          truncated: false,
          tree: [
            { mode: "100644", path: SOURCE_WORKFLOW, sha: "1".repeat(40), type: "blob" },
            {
              mode: "100755",
              path: SOURCE_CONTROLLER,
              sha: options.authorityDrift ? "3".repeat(40) : "2".repeat(40),
              type: "blob",
            },
          ],
        };
      }
      if (apiPath === `repos/${REPOSITORY}/actions/workflows/${SOURCE_WORKFLOW_ID}`) {
        return { id: SOURCE_WORKFLOW_ID, path: SOURCE_WORKFLOW, state: "active" };
      }
      if (apiPath.includes(`/actions/workflows/${SOURCE_WORKFLOW_ID}/runs?`)) {
        sourceRunLookups += 1;
        const runAttempt =
          sourceRunLookups >= (options.recheckAtLookup ?? 2) ? (options.recheckAttempt ?? 1) : 1;
        const runs: Array<Record<string, unknown>> = [
          {
            conclusion: "success",
            display_title: `OpenShell 0.0.101 ${executionContext} source candidate ${CANDIDATE_SHA} base ${BASE_SHA}`,
            event: sourceEvent,
            head_branch: options.sourceHeadBranch ?? "main",
            head_sha: runHeadSha,
            html_url: `https://github.com/${REPOSITORY}/actions/runs/101`,
            id: 101,
            path: SOURCE_WORKFLOW,
            pull_requests: [],
            repository: { full_name: REPOSITORY },
            run_attempt: runAttempt,
            status: "completed",
            workflow_id: SOURCE_WORKFLOW_ID,
          },
        ];
        if (options.newerRun) {
          runs.push({
            ...runs[0]!,
            conclusion: options.newerRun.conclusion,
            html_url: `https://github.com/${REPOSITORY}/actions/runs/102`,
            id: 102,
            status: options.newerRun.status,
          });
        }
        return { workflow_runs: runs };
      }
      if (apiPath.includes("/actions/runs/101/jobs?")) {
        return {
          jobs: [
            {
              conclusion: "success",
              head_sha: runHeadSha,
              html_url: `https://github.com/${REPOSITORY}/actions/runs/101/job/501`,
              id: 501,
              name: "Source proof",
              run_attempt: 1,
              run_id: 101,
              status: "completed",
            },
          ],
        };
      }
      if (apiPath === `repos/${REPOSITORY}/actions/runs/101/artifacts?per_page=100&page=1`) {
        return {
          artifacts: [
            {
              archive_download_url: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/601/zip`,
              expired: false,
              id: 601,
              name: `openshell-0.0.101-qualification-source-${executionContext}-101-1`,
              workflow_run: { head_sha: runHeadSha, id: 101 },
            },
          ],
          total_count: 1,
        };
      }
      throw new Error(`unexpected API path: ${apiPath}`);
    },
  };
}

describe("qualification receipt producer", () => {
  it("rejects a frozen bootstrap receipt unless the candidate activates selector", async () => {
    const frozenBootstrap = contractValue("bootstrap", {
      tests: [
        descriptor({
          final: "pending",
          finalPendingSource: true,
          selector: "pending",
          selectorPendingSource: true,
        }),
      ],
    });
    frozenBootstrap.inventoryState = "frozen";
    await expect(
      produceQualificationReceipt(
        frozenBootstrap,
        {
          ...receiptInput("selector"),
          candidateContract: frozenBootstrap,
          prNumber: PR_NUMBER,
        },
        producerApi(),
      ),
    ).rejects.toThrow("requires exact selector activation");
  });

  it("authenticates an exact qualification source receipt and copies its bindings", async () => {
    const receipt = await produceQualificationReceipt(
      contractValue(),
      {
        ...receiptInput("selector"),
        candidateContract: contractValue(),
        prNumber: PR_NUMBER,
      },
      producerApi(),
    );

    expect(receipt.tests[0]?.runs[0]).toMatchObject({
      baseSha: BASE_SHA,
      candidateSha: CANDIDATE_SHA,
      controllerSha: BASE_SHA,
      event: "workflow_dispatch",
      openshellCommitSha: QUALIFICATION_TARGET_COMMIT_SHA,
      phase: "selector",
      prNumber: PR_NUMBER,
      workflowId: SOURCE_WORKFLOW_ID,
    });
    expect(validateQualificationReceipt(receipt, contractValue(), expectation())).toEqual(receipt);
  });

  it("produces complete proof for base-owned selector and final lifecycle promotions", async () => {
    const bootstrap = contractValue("bootstrap", {
      tests: [
        descriptor({
          final: "pending",
          finalPendingSource: true,
          selector: "pending",
          selectorPendingSource: true,
        }),
      ],
    });
    bootstrap.inventoryState = "frozen";
    const selector = contractValue("selector", {
      tests: [descriptor({ final: "pending", finalPendingSource: true })],
    });
    const selectorReceipt = await produceQualificationReceipt(
      bootstrap,
      {
        ...receiptInput("selector"),
        candidateContract: selector,
        prNumber: PR_NUMBER,
      },
      producerApi(),
    );
    expect(selectorReceipt.tests.map((test) => test.id)).toEqual(["shared-proof"]);

    const stagedFinal = contractValue("selector", {
      tests: [descriptor({ final: "pending", finalPendingSource: true })],
    });
    const final = contractValue("final");
    const promotionReceipt = await produceQualificationReceipt(
      stagedFinal,
      {
        ...receiptInput("final", "final-promotion"),
        candidateContract: final,
        prNumber: PR_NUMBER,
      },
      producerApi({ executionContext: "final-promotion", phase: "final" }),
    );
    expect(
      validateQualificationReceipt(
        promotionReceipt,
        final,
        expectation("final", "final-promotion"),
      ),
    ).toEqual(promotionReceipt);
    expect(promotionReceipt.tests.map((test) => test.id)).toEqual(["shared-proof"]);
  });

  it("rejects receipt production before a draft inventory has frozen", async () => {
    const draft = contractValue("bootstrap", {
      tests: [descriptor({ final: "pending", selector: "pending" })],
    });
    const candidate = contractValue("selector", {
      tests: [descriptor({ final: "pending" })],
    });
    const input = {
      ...receiptInput("selector"),
      candidateContract: candidate,
      prNumber: PR_NUMBER,
    };
    await expect(produceQualificationReceipt(draft, input, producerApi())).rejects.toThrow(
      "draft inventory",
    );
  });

  it("binds final-promotion production to the live PR head, base, number, and base controller", async () => {
    const stagedFinal = contractValue("selector", {
      tests: [descriptor({ final: "pending", finalPendingSource: true })],
    });
    const final = contractValue("final");
    const input = {
      ...receiptInput("final", "final-promotion"),
      candidateContract: final,
      prNumber: PR_NUMBER,
    };
    for (const pullRequest of [
      { candidateSha: "c".repeat(40) },
      { baseSha: "c".repeat(40) },
      { baseRef: "release" },
      { candidateRepository: "fork/NemoClaw" },
      { number: PR_NUMBER + 1 },
      { state: "closed" },
    ]) {
      await expect(
        produceQualificationReceipt(
          stagedFinal,
          input,
          producerApi({ executionContext: "final-promotion", phase: "final", pullRequest }),
        ),
      ).rejects.toThrow("pull-request identity");
    }
    await expect(
      produceQualificationReceipt(
        stagedFinal,
        input,
        producerApi({
          executionContext: "final-promotion",
          mutateSource: { controllerSha: CANDIDATE_SHA },
          phase: "final",
        }),
      ),
    ).rejects.toThrow("identity-mismatched");
    await expect(
      produceQualificationReceipt(
        stagedFinal,
        { ...input, trustedProducerWorkflowSha: CANDIDATE_SHA },
        producerApi({ executionContext: "final-promotion", phase: "final" }),
      ),
    ).rejects.toThrow("producer workflow identity");
  });

  it("rejects otherwise-matching dispatch and push source runs from a non-main branch", async () => {
    await expect(
      produceQualificationReceipt(
        contractValue(),
        {
          ...receiptInput("selector"),
          candidateContract: contractValue(),
          prNumber: PR_NUMBER,
        },
        producerApi({ sourceHeadBranch: "feature/off-main" }),
      ),
    ).rejects.toThrow("source run 101 identity is mismatched");

    const stagedFinal = contractValue("selector", {
      tests: [descriptor({ final: "pending", finalPendingSource: true })],
    });
    await expect(
      produceQualificationReceipt(
        stagedFinal,
        {
          ...receiptInput("final", "final-promotion"),
          candidateContract: contractValue("final"),
          prNumber: PR_NUMBER,
        },
        producerApi({
          executionContext: "final-promotion",
          phase: "final",
          sourceHeadBranch: "release/off-main",
        }),
      ),
    ).rejects.toThrow("source run 101 identity is mismatched");
  });

  it("rejects bootstrap draft receipt production without loading source evidence", async () => {
    const bootstrap = contractValue("bootstrap", {
      tests: [descriptor({ final: "pending", selector: "pending" })],
    });
    await expect(
      produceQualificationReceipt(
        bootstrap,
        {
          ...receiptInput("selector"),
          candidateContract: bootstrap,
          prNumber: PR_NUMBER,
          tests: undefined,
        } as never,
        {
          async getBytes() {
            throw new Error("source artifact must not be loaded");
          },
          async getJson() {
            throw new Error("source metadata must not be loaded");
          },
        },
      ),
    ).rejects.toThrow("draft inventory");
  });

  it("rejects changed authority, stale semantics, superseding runs, and attempt changes", async () => {
    const input = {
      ...receiptInput("selector"),
      candidateContract: contractValue(),
      prNumber: PR_NUMBER,
    };
    await expect(
      produceQualificationReceipt(contractValue(), input, producerApi({ authorityDrift: true })),
    ).rejects.toThrow("authority path");
    await expect(
      produceQualificationReceipt(
        contractValue(),
        input,
        producerApi({ mutateSource: { baseSha: "c".repeat(40) } }),
      ),
    ).rejects.toThrow("identity-mismatched");
    await expect(
      produceQualificationReceipt(
        contractValue(),
        input,
        producerApi({ newerRun: { conclusion: "failure", status: "completed" } }),
      ),
    ).rejects.toThrow("newest qualification source run");
    await expect(
      produceQualificationReceipt(contractValue(), input, producerApi({ recheckAttempt: 2 })),
    ).rejects.toThrow("changed during authentication");
  });

  it("rechecks every selected source globally after all descriptors are aggregated", async () => {
    const testIds = ["first-proof", "second-proof"];
    const contract = contractValue("selector", {
      tests: testIds.map((id) => descriptor({ id })),
    });

    await expect(
      produceQualificationReceipt(
        contract,
        {
          ...receiptInput("selector"),
          candidateContract: contract,
          prNumber: PR_NUMBER,
        },
        producerApi({
          recheckAttempt: 2,
          recheckAtLookup: 3,
          sourceTestIds: testIds,
        }),
      ),
    ).rejects.toThrow("first-proof changed during authentication");
  });
});
