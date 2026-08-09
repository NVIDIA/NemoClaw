// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  QUALIFICATION_TARGET_COMMIT_SHA,
  type QualificationContract,
  readQualificationReceiptArchive,
  requireActiveQualificationTests,
  requiredQualificationTests,
  validateQualificationContract,
  validateQualificationLifecycleTransition,
  validateQualificationReceipt,
} from "../scripts/checks/openshell-qualification-contract.mts";
import type { QualificationMatrix } from "../scripts/checks/openshell-qualification-matrix.mts";
import { artifactZip } from "./helpers/artifact-zip";
import {
  BASE_SHA,
  CANDIDATE_SHA,
  clone,
  contractValue,
  descriptor,
  expectation,
  PR_NUMBER,
  REPOSITORY,
  receiptInput,
  receiptRun,
  SOURCE_CONTROLLER,
  SOURCE_WORKFLOW,
  SOURCE_WORKFLOW_ID,
  source,
  validReceipt,
} from "./helpers/openshell-qualification-contract-fixture";
import {
  finalArtifactApi,
  producerApi,
  RETIREMENT_AUTHORITY_SHA,
  retirementAuthenticationFixture,
  setReceiptBoundaryResult,
} from "./helpers/openshell-qualification-contract-test-support";

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
      setReceiptBoundaryResult(receipt, location, result);
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
