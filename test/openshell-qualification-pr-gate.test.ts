// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  qualificationAuthorityPaths,
  validateQualificationContract,
} from "../scripts/checks/openshell-qualification-core.mts";
import type {
  QualificationContract,
  QualificationGitHubReader,
} from "../scripts/checks/openshell-qualification-schema.mts";
import {
  authenticateQualificationGateAuthority,
  classifyQualificationGateFiles,
  contractExists,
  loadNewestProducerRun,
  planQualificationGate,
  retirementIncludesFinalContractInAuthority,
  validateEffectiveQualificationRules,
} from "../scripts/checks/verify-openshell-qualification-pr-gate.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const BASE_SHA = "b".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
const DYNAMIC_AUTHORITY_PATH = "custom/proofs/controller.mts";

function minimalAuthorityContract(
  overrides: Partial<QualificationContract> = {},
): QualificationContract {
  return {
    inventoryState: "frozen",
    lifecycle: "selector",
    repository: REPOSITORY,
    requiredWorkflowGate: {
      organizationRulesetId: 4242,
      repositoryId: 1182547092,
      sourcePath: ".github/workflows/openshell-0.0.101-pr-gate.yaml",
      sourceRef: "refs/heads/main",
    },
    requiredStatusRulesetId: 15735613,
    trustedProducerWorkflowPath: ".github/workflows/openshell-0.0.101-qualification.yaml",
    tests: [
      {
        mappings: {
          selector: {
            source: {
              authorityPaths: [DYNAMIC_AUTHORITY_PATH],
              workflowPath: ".github/workflows/custom-source.yaml",
            },
          },
        },
      },
    ],
    ...overrides,
  } as QualificationContract;
}

function treeReader(options: {
  authority: QualificationContract;
  changedMode?: boolean;
  changedSha?: boolean;
}): QualificationGitHubReader {
  const paths = qualificationAuthorityPaths(options.authority, true);
  const tree = (candidate: boolean) => ({
    truncated: false,
    tree: paths.map((entryPath) => ({
      mode:
        candidate && options.changedMode && entryPath === DYNAMIC_AUTHORITY_PATH
          ? "100755"
          : "100644",
      path: entryPath,
      sha:
        candidate && options.changedSha && entryPath === DYNAMIC_AUTHORITY_PATH
          ? "c".repeat(40)
          : "d".repeat(40),
      type: "blob",
    })),
  });
  const responses = new Map([
    [`repos/${REPOSITORY}/git/trees/${BASE_SHA}?recursive=1`, tree(false)],
    [`repos/${REPOSITORY}/git/trees/${CANDIDATE_SHA}?recursive=1`, tree(true)],
  ]);
  return {
    async getBytes() {
      return Buffer.alloc(0);
    },
    async getJson(apiPath) {
      return responses.get(apiPath) ?? Promise.reject(new Error(`unexpected API path: ${apiPath}`));
    },
  };
}

function effectiveRules() {
  return [
    {
      type: "required_status_checks",
      ruleset_source_type: "Repository",
      ruleset_source: REPOSITORY,
      ruleset_id: 15735613,
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: ["checks", "commit-lint", "dco-check", "check-hash", "changes"].map(
          (context) => ({ context, integration_id: 15368 }),
        ),
      },
    },
    {
      type: "workflows",
      ruleset_source_type: "Organization",
      ruleset_source: "NVIDIA",
      ruleset_id: 4242,
      parameters: {
        do_not_enforce_on_create: false,
        workflows: [
          {
            repository_id: 1182547092,
            path: ".github/workflows/openshell-0.0.101-pr-gate.yaml",
            ref: "refs/heads/main",
          },
        ],
      },
    },
  ];
}

function qualificationRun(id: number, conclusion: "failure" | "success") {
  return {
    id,
    run_attempt: 1,
    workflow_id: 71,
    display_title: `OpenShell 0.0.101 selector candidate ${CANDIDATE_SHA} base ${BASE_SHA}`,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: BASE_SHA,
    path: ".github/workflows/openshell-0.0.101-qualification.yaml",
    status: "completed",
    conclusion,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
    repository: { full_name: REPOSITORY },
  };
}

function producerRunsReader(
  runs: ReturnType<typeof qualificationRun>[],
): QualificationGitHubReader {
  return {
    async getBytes() {
      return Buffer.alloc(0);
    },
    async getJson() {
      return { total_count: runs.length, workflow_runs: runs };
    },
  };
}

describe("OpenShell qualification standalone PR gate", () => {
  it("fast-passes absent scope and valid draft staging without authority or receipts (#8600)", () => {
    expect(
      planQualificationGate({
        baseContract: null,
        baseVersion: "0.0.99",
        candidateContract: null,
        candidateVersion: "0.0.99",
        files: [{ filename: "scripts/install.sh", status: "modified" }],
      }),
    ).toEqual({
      authorityContract: null,
      authorityRequired: false,
      candidateContract: null,
      receiptContexts: [],
    });

    const draft = validateQualificationContract(
      JSON.parse(fs.readFileSync("ci/openshell-0.0.101-qualification-v1.json", "utf8")),
    );
    expect(
      planQualificationGate({
        baseContract: draft,
        baseVersion: "0.0.99",
        candidateContract: structuredClone(draft),
        candidateVersion: "0.0.99",
        files: [{ filename: "ci/openshell-0.0.101-qualification-v1.json", status: "modified" }],
      }),
    ).toMatchObject({ authorityRequired: false, receiptContexts: [] });
  });

  it("fails closed for an absent-to-broken-symlink contract transition (#8600)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-pr-gate-absent-"));
    const contractPath = path.join(root, "ci/openshell-0.0.101-qualification-v1.json");
    try {
      fs.mkdirSync(path.dirname(contractPath), { recursive: true });
      fs.symlinkSync("missing-contract.json", contractPath);
      expect(() => contractExists(root)).toThrow("regular file");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails closed rather than treating a broken contract symlink as teardown (#8600)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openshell-pr-gate-teardown-"));
    const contractPath = path.join(root, "ci/openshell-0.0.101-qualification-v1.json");
    try {
      fs.mkdirSync(path.dirname(contractPath), { recursive: true });
      fs.symlinkSync("removed-contract.json", contractPath);
      expect(() => contractExists(root)).toThrow("regular file");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("classifies dynamic mapped authority paths and either side of a rename (#8600)", () => {
    const contract = minimalAuthorityContract();
    expect(
      classifyQualificationGateFiles(
        [{ filename: DYNAMIC_AUTHORITY_PATH, status: "modified" }],
        contract,
      ),
    ).toEqual({ required: true, sensitivePaths: [DYNAMIC_AUTHORITY_PATH] });
    expect(
      classifyQualificationGateFiles(
        [
          {
            filename: "docs/moved-controller.md",
            previousFilename: DYNAMIC_AUTHORITY_PATH,
            status: "renamed",
          },
        ],
        contract,
      ),
    ).toEqual({ required: true, sensitivePaths: [DYNAMIC_AUTHORITY_PATH] });
    expect(
      classifyQualificationGateFiles(
        [{ filename: "docs/index.mdx", status: "modified" }],
        contract,
      ),
    ).toEqual({ required: false, sensitivePaths: [] });
  });

  it("requires complete frozen authority blob and mode parity (#8600)", async () => {
    const contract = minimalAuthorityContract();
    await expect(
      authenticateQualificationGateAuthority({
        api: treeReader({ authority: contract }),
        baseContract: contract,
        baseSha: BASE_SHA,
        candidateContract: structuredClone(contract),
        candidateSha: CANDIDATE_SHA,
        repository: REPOSITORY,
      }),
    ).resolves.toBeUndefined();
    await expect(
      authenticateQualificationGateAuthority({
        api: treeReader({ authority: contract, changedSha: true }),
        baseContract: contract,
        baseSha: BASE_SHA,
        candidateContract: structuredClone(contract),
        candidateSha: CANDIDATE_SHA,
        repository: REPOSITORY,
      }),
    ).rejects.toThrow(DYNAMIC_AUTHORITY_PATH);
    await expect(
      authenticateQualificationGateAuthority({
        api: treeReader({ authority: contract, changedMode: true }),
        baseContract: contract,
        baseSha: BASE_SHA,
        candidateContract: structuredClone(contract),
        candidateSha: CANDIDATE_SHA,
        repository: REPOSITORY,
      }),
    ).rejects.toThrow(DYNAMIC_AUTHORITY_PATH);
  });

  it("compares the candidate-declared authority closure during draft freeze (#8600)", async () => {
    const draft = minimalAuthorityContract({ inventoryState: "draft" });
    const frozen = minimalAuthorityContract();
    await expect(
      authenticateQualificationGateAuthority({
        api: treeReader({ authority: frozen, changedSha: true }),
        baseContract: draft,
        baseSha: BASE_SHA,
        candidateContract: frozen,
        candidateSha: CANDIDATE_SHA,
        repository: REPOSITORY,
      }),
    ).rejects.toThrow(DYNAMIC_AUTHORITY_PATH);
  });

  it("authenticates exact effective repository and organization rules (#8600)", () => {
    expect(() =>
      validateEffectiveQualificationRules(effectiveRules(), {
        organizationRulesetId: 4242,
        repository: REPOSITORY,
        requiredStatusRulesetId: 15735613,
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "non-strict status rule",
      (rules: ReturnType<typeof effectiveRules>) => {
        rules[0]!.parameters.strict_required_status_checks_policy = false;
      },
    ],
    [
      "wrong status App",
      (rules: ReturnType<typeof effectiveRules>) => {
        const status = rules[0] as {
          parameters: { required_status_checks: Array<{ integration_id: number }> };
        };
        status.parameters.required_status_checks[0]!.integration_id = 42;
      },
    ],
    [
      "repository-authored workflow",
      (rules: ReturnType<typeof effectiveRules>) => {
        rules[1]!.ruleset_source_type = "Repository";
      },
    ],
    [
      "wrong organization ruleset",
      (rules: ReturnType<typeof effectiveRules>) => {
        rules[1]!.ruleset_id = 4243;
      },
    ],
    [
      "wrong source repository",
      (rules: ReturnType<typeof effectiveRules>) => {
        const workflow = rules[1] as {
          parameters: { workflows: Array<{ repository_id: number }> };
        };
        workflow.parameters.workflows[0]!.repository_id = 1;
      },
    ],
    [
      "wrong workflow path",
      (rules: ReturnType<typeof effectiveRules>) => {
        const workflow = rules[1] as {
          parameters: { workflows: Array<{ path: string }> };
        };
        workflow.parameters.workflows[0]!.path = ".github/workflows/spoof.yaml";
      },
    ],
    [
      "wrong workflow ref",
      (rules: ReturnType<typeof effectiveRules>) => {
        const workflow = rules[1] as {
          parameters: { workflows: Array<{ ref: string }> };
        };
        workflow.parameters.workflows[0]!.ref = "refs/heads/attacker";
      },
    ],
    [
      "merge queue",
      (rules: ReturnType<typeof effectiveRules>) => {
        rules.push({ type: "merge_queue" } as never);
      },
    ],
  ])("rejects effective authority with %s (#8600)", (_label, mutate) => {
    const rules = effectiveRules();
    mutate(rules);
    expect(() =>
      validateEffectiveQualificationRules(rules, {
        organizationRulesetId: 4242,
        repository: REPOSITORY,
        requiredStatusRulesetId: 15735613,
      }),
    ).toThrow();
  });

  it("uses final contract bytes only for the final-to-retired authentication boundary (#8600)", () => {
    expect(retirementIncludesFinalContractInAuthority("final", "retired")).toBe(true);
    expect(retirementIncludesFinalContractInAuthority("retired", "retired")).toBe(false);
    expect(retirementIncludesFinalContractInAuthority("retired", null)).toBe(false);
    expect(() => retirementIncludesFinalContractInAuthority("selector", "retired")).toThrow();
  });

  it("accepts a newest successful exact run after an older exact failure (#8600)", async () => {
    const contract = minimalAuthorityContract();
    await expect(
      loadNewestProducerRun({
        api: producerRunsReader([qualificationRun(70, "failure"), qualificationRun(71, "success")]),
        contract,
        executionContext: "selector",
        identity: {
          baseSha: BASE_SHA,
          candidateRepository: REPOSITORY,
          candidateSha: CANDIDATE_SHA,
          number: 42,
          repository: REPOSITORY,
        },
        workflow: { id: 71, path: contract.trustedProducerWorkflowPath },
      }),
    ).resolves.toMatchObject({ id: 71, conclusion: "success" });
  });

  it("rejects a newest failed exact run even when an older exact run succeeded (#8600)", async () => {
    const contract = minimalAuthorityContract();
    await expect(
      loadNewestProducerRun({
        api: producerRunsReader([qualificationRun(70, "success"), qualificationRun(71, "failure")]),
        contract,
        executionContext: "selector",
        identity: {
          baseSha: BASE_SHA,
          candidateRepository: REPOSITORY,
          candidateSha: CANDIDATE_SHA,
          number: 42,
          repository: REPOSITORY,
        },
        workflow: { id: 71, path: contract.trustedProducerWorkflowPath },
      }),
    ).rejects.toThrow("newest exact selector producer run is stale or identity-mismatched");
  });
});
