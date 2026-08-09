// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { expect } from "vitest";

import {
  QUALIFICATION_CONTRACT_PATH,
  QUALIFICATION_SOURCE_RECEIPT_FILE,
  QUALIFICATION_TARGET_COMMIT_SHA,
  type QualificationArtifactReader,
  type QualificationExecutionContext,
  type QualificationGitHubReader,
  type QualificationPhase,
  type QualificationReceipt,
  validateQualificationContract,
} from "../../scripts/checks/openshell-qualification-contract.mts";
import {
  qualificationAuthorityPaths,
  renderQualificationRetirementTagMessage,
} from "../../scripts/checks/openshell-qualification-core.mts";
import { artifactZip } from "./artifact-zip";
import {
  artifactProvenance,
  BASE_SHA,
  CANDIDATE_SHA,
  contractValue,
  defaultExecutionContext,
  PR_NUMBER,
  PRODUCER_WORKFLOW,
  qualificationCells,
  REPOSITORY,
  SOURCE_CONTROLLER,
  SOURCE_WORKFLOW,
  SOURCE_WORKFLOW_ID,
  validReceipt,
} from "./openshell-qualification-contract-fixture";

export function setReceiptBoundaryResult(
  receipt: QualificationReceipt,
  location: "job" | "run" | "test",
  result: string,
): void {
  if (location === "test") receipt.tests[0]!.result = result as "failure";
  if (location === "run") receipt.tests[0]!.runs[0]!.result = result as "failure";
  if (location === "job") receipt.tests[0]!.runs[0]!.jobs[0]!.result = result as "failure";
}

export function finalArtifactApi(
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

export const RETIREMENT_AUTHORITY_SHA = "d".repeat(40);
const RELEASE_TAG_OBJECT_SHA = "e".repeat(40);

function sha256(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

export function retirementAuthenticationFixture(
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

export function producerApi(
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
