// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateBrevImageEvidence,
  validateFullE2eEvidence,
} from "../.agents/skills/nemoclaw-maintainer-e2e/scripts/validate-full-e2e-evidence.mts";

const candidateSha = "a".repeat(40);
const imageRepositorySha = "d".repeat(40);
const workflowSha = "b".repeat(40);

function validEvidence() {
  return {
    candidateSha,
    cleanup: {
      status: "ABSENT",
      verifiedAt: "2026-07-24T12:00:00Z",
      workspaceId: "workspace-123",
      workspaceName: "nclaw-e2e-100-2",
    },
    dispatch: {
      allowDgxSparkRunnerQueue: false,
      allowJetsonDispatch: false,
      allowJetsonRunnerQueue: false,
      candidateSha,
      emptySelectors: true,
      eventName: "workflow_dispatch",
      includeStagingBrevLaunchable: true,
      jobs: "",
      kind: "nemoclaw-e2e-dispatch-v1",
      targets: "",
      workflowRunAttempt: 2,
      workflowRunId: "100",
    },
    jobs: {
      jobs: [
        {
          completed_at: "2026-07-24T11:30:00Z",
          conclusion: "success",
          html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/100/job/200",
          name: "Exact staging Brev Launchable",
          run_attempt: 2,
          run_id: 100,
          status: "completed",
        },
      ],
    },
    launchableE2e: {
      boot: {
        bootImage: "projects/brevdevprod/global/images/nemoclaw-test-image",
        imageRepositorySha,
        provisionSha: candidateSha,
        repoClean: true,
        repoSha: candidateSha,
      },
      candidateSha,
      fullE2e: "passed",
      image: {
        imageCreationTimestamp: "2026-07-24T09:30:00Z",
        imageId: "5831758261704356816",
        imageName: "nemoclaw-test-image",
        imageOriginWorkflowRunAttempt: 1,
        imageOriginWorkflowRunId: "99",
        imageRepositorySha,
        imageSelfLink:
          "https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/nemoclaw-test-image",
        observedFamily: "nemoclaw-brev-staging-cpu",
        project: "brevdevprod",
        result: "built",
      },
      producer: { runId: "99", status: "success" },
      workspace: { id: "workspace-123", name: "nclaw-e2e-100-2" },
    },
    run: {
      conclusion: "success",
      created_at: "2026-07-24T10:00:00Z",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: candidateSha,
      html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/100",
      id: 100,
      path: ".github/workflows/e2e.yaml",
      run_attempt: 2,
      status: "completed",
    },
  };
}

function validV2Evidence() {
  const evidence = validEvidence();
  return {
    ...evidence,
    dispatch: {
      ...evidence.dispatch,
      baseSha: "c".repeat(40),
      candidateRepository: "NVIDIA/NemoClaw",
      kind: "nemoclaw-e2e-dispatch-v2",
      prNumber: 8583,
      repository: "NVIDIA/NemoClaw",
      workflowSha,
    },
    run: {
      ...evidence.run,
      head_sha: workflowSha,
    },
  };
}

function validDirectMainV2Evidence() {
  const evidence = validV2Evidence();
  return {
    ...evidence,
    dispatch: {
      ...evidence.dispatch,
      baseSha: candidateSha,
      candidateRepository: "NVIDIA/NemoClaw",
      prNumber: null,
      workflowSha: candidateSha,
    },
    run: {
      ...evidence.run,
      head_sha: candidateSha,
    },
  };
}

describe("nemoclaw-maintainer-e2e evidence validation", () => {
  it("returns exact-candidate job, Launchable E2E, and cleanup evidence (#7487)", () => {
    expect(validateFullE2eEvidence(validEvidence())).toEqual({
      attempt: 2,
      candidateSha,
      cleanup: {
        status: "ABSENT",
        verifiedAt: "2026-07-24T12:00:00Z",
        workspaceId: "workspace-123",
        workspaceName: "nclaw-e2e-100-2",
      },
      dispatch: {
        allowDgxSparkRunnerQueue: false,
        allowJetsonDispatch: false,
        allowJetsonRunnerQueue: false,
        emptySelectors: true,
        includeStagingBrevLaunchable: true,
      },
      evidenceMode: "full",
      jobCompletedAt: "2026-07-24T11:30:00Z",
      jobUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/100/job/200",
      launchableE2e: {
        fullE2e: "passed",
        image: {
          imageCreationTimestamp: "2026-07-24T09:30:00Z",
          imageId: "5831758261704356816",
          imageName: "nemoclaw-test-image",
          imageOriginWorkflowRunAttempt: 1,
          imageOriginWorkflowRunId: "99",
          imageRepositorySha,
          imageSelfLink:
            "https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/nemoclaw-test-image",
          observedFamily: "nemoclaw-brev-staging-cpu",
          project: "brevdevprod",
          result: "built",
        },
        producerRunId: "99",
        provisionSha: candidateSha,
        repoClean: true,
        repoSha: candidateSha,
      },
      runCreatedAt: "2026-07-24T10:00:00Z",
      runId: 100,
      runUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/100",
    });
  });

  it("accepts a v2 receipt bound to the candidate and trusted workflow SHAs (#8497)", () => {
    expect(validateFullE2eEvidence(validV2Evidence())).toMatchObject({
      attempt: 2,
      candidateSha,
      runUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/100",
    });
  });

  it("accepts a direct-main v2 receipt with identical repository and SHA identities (#8497)", () => {
    expect(validateFullE2eEvidence(validDirectMainV2Evidence())).toMatchObject({
      candidateSha,
      runUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/100",
    });
  });

  it("accepts image evidence from direct main full, selective, and push runs (#7487)", () => {
    const full = validDirectMainV2Evidence();
    expect(validateBrevImageEvidence(full, "full")).toMatchObject({
      evidenceMode: "full",
      jobCompletedAt: "2026-07-24T11:30:00Z",
    });

    const launchable = validEvidence();
    launchable.dispatch.emptySelectors = false;
    launchable.dispatch.includeStagingBrevLaunchable = false;
    launchable.dispatch.jobs = "staging-brev-launchable";
    expect(validateBrevImageEvidence(launchable, "launchable")).toMatchObject({
      dispatch: { emptySelectors: false, includeStagingBrevLaunchable: false },
      evidenceMode: "launchable",
    });

    const push = validEvidence();
    push.dispatch.eventName = "push";
    push.dispatch.includeStagingBrevLaunchable = false;
    push.run.event = "push";
    expect(validateBrevImageEvidence(push, "push")).toMatchObject({
      dispatch: { emptySelectors: true, includeStagingBrevLaunchable: false },
      evidenceMode: "push",
    });

    const reused = validEvidence();
    reused.launchableE2e.image.result = "reused";
    reused.launchableE2e.image.imageOriginWorkflowRunId = "77";
    reused.launchableE2e.image.imageOriginWorkflowRunAttempt = 3;
    expect(validateBrevImageEvidence(reused, "full")).toMatchObject({
      launchableE2e: {
        image: {
          imageOriginWorkflowRunAttempt: 3,
          imageOriginWorkflowRunId: "77",
          result: "reused",
        },
      },
    });
  });

  it("rejects PR-shaped release image evidence (#7487)", () => {
    expect(() => validateBrevImageEvidence(validV2Evidence(), "full")).toThrow(
      "dispatch.prNumber must be null",
    );
  });

  it.each([
    ["candidateRepository", "contributor/NemoClaw", "dispatch.candidateRepository"],
    ["baseSha", "c".repeat(40), "dispatch.baseSha"],
    ["workflowSha", workflowSha, "dispatch.workflowSha"],
  ])("rejects a direct-main v2 receipt with a mismatched %s identity (#8497)", (field, value, message) => {
    const evidence = validDirectMainV2Evidence();
    (evidence.dispatch as Record<string, unknown>)[field] = value;

    expect(() => validateFullE2eEvidence(evidence)).toThrow(message);
  });

  it.each([
    ["repository", "other/NemoClaw", "dispatch.repository"],
    ["prNumber", 0, "dispatch.prNumber"],
    ["candidateRepository", "not-a-repository", "dispatch.candidateRepository"],
    ["candidateSha", "d".repeat(40), "dispatch.candidateSha"],
    ["baseSha", "short", "dispatch.baseSha"],
    ["workflowSha", "short", "dispatch.workflowSha"],
  ])("rejects a v2 receipt with a mismatched %s (#8497)", (field, value, message) => {
    const evidence = validV2Evidence();
    (evidence.dispatch as Record<string, unknown>)[field] = value;

    expect(() => validateFullE2eEvidence(evidence)).toThrow(message);
  });

  it("rejects a v2 run whose head is the candidate instead of the trusted workflow (#8497)", () => {
    const evidence = validV2Evidence();
    evidence.run.head_sha = candidateSha;

    expect(() => validateFullE2eEvidence(evidence)).toThrow("run.head_sha");
  });

  it("accepts successful Launchable evidence from an earlier attempt of the same run (#7487)", () => {
    const evidence = validEvidence();
    evidence.dispatch.workflowRunAttempt = 1;
    evidence.jobs.jobs[0]!.run_attempt = 1;

    expect(validateFullE2eEvidence({ ...evidence, jobs: [evidence.jobs] })).toMatchObject({
      attempt: 1,
      jobUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/100/job/200",
    });
  });

  it("rejects a Launchable artifact from a different successful attempt (#7487)", () => {
    const evidence = validEvidence();
    evidence.dispatch.workflowRunAttempt = 1;

    expect(() => validateFullE2eEvidence({ ...evidence, jobs: [evidence.jobs] })).toThrow(
      "jobs response must contain a completed successful Exact staging Brev Launchable job",
    );
  });

  it.each([
    [
      "a run for another SHA",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.run.head_sha = "b".repeat(40);
      },
      "run.head_sha",
    ],
    [
      "a selective Launchable E2E dispatch",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.dispatch.emptySelectors = false;
        evidence.dispatch.includeStagingBrevLaunchable = false;
        evidence.dispatch.jobs = "staging-brev-launchable";
      },
      "dispatch.jobs",
    ],
    [
      "a full dispatch that opts into Colossus Jetson execution",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.dispatch.allowJetsonDispatch = true;
      },
      "dispatch.allowJetsonDispatch",
    ],
    [
      "a full dispatch that enables the retired Jetson runner receipt field",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.dispatch.allowJetsonRunnerQueue = true;
      },
      "dispatch.allowJetsonRunnerQueue",
    ],
    [
      "a full dispatch that opts into the DGX Spark runner queue",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.dispatch.allowDgxSparkRunnerQueue = true;
      },
      "dispatch.allowDgxSparkRunnerQueue",
    ],
    [
      "a skipped Launchable E2E job",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.jobs.jobs[0]!.conclusion = "skipped";
      },
      "jobs response must contain a completed successful Exact staging Brev Launchable job",
    ],
    [
      "a Launchable E2E receipt for another SHA",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.launchableE2e.boot.repoSha = "b".repeat(40);
      },
      "launchableE2e.boot.repoSha",
    ],
    [
      "a boot URI that does not identify the producer image",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.launchableE2e.boot.bootImage = "projects/brevdevprod/global/images/another-image";
      },
      "launchableE2e.boot.bootImage",
    ],
    [
      "an image ID that is not decimal",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.launchableE2e.image.imageId = "not-an-id";
      },
      "launchableE2e.image.imageId",
    ],
    [
      "an image outside the trusted GCP project",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.launchableE2e.image.project = "other-project";
      },
      "launchableE2e.image.project",
    ],
    [
      "a malformed image creation timestamp",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.launchableE2e.image.imageCreationTimestamp = "not-a-timestamp";
      },
      "launchableE2e.image.imageCreationTimestamp",
    ],
    [
      "a built image whose origin does not match the producer",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.launchableE2e.image.imageOriginWorkflowRunId = "98";
      },
      "launchableE2e.image.imageOriginWorkflowRunId",
    ],
    [
      "an image self-link that does not identify the producer image",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.launchableE2e.image.imageSelfLink =
          "https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/another-image";
      },
      "launchableE2e.image.imageSelfLink",
    ],
    [
      "an image-repository SHA that does not match the boot receipt",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.launchableE2e.boot.imageRepositorySha = "e".repeat(40);
      },
      "launchableE2e.boot.imageRepositorySha",
    ],
    [
      "a malformed workflow timestamp",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.run.created_at = "not-a-timestamp";
      },
      "run.created_at",
    ],
    [
      "a malformed selected-job timestamp",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.jobs.jobs[0]!.completed_at = "not-a-timestamp";
      },
      "Exact staging Brev Launchable.completed_at",
    ],
    [
      "a cleanup receipt without verified absence",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.cleanup.status = "PRESENT";
      },
      "cleanup.status",
    ],
    [
      "a job from another workflow run",
      (evidence: ReturnType<typeof validEvidence>) => {
        evidence.jobs.jobs[0]!.run_id = 101;
      },
      "jobs response must contain a completed successful Exact staging Brev Launchable job",
    ],
  ])("rejects %s (#7487)", (_name, mutate, message) => {
    const evidence = validEvidence();
    mutate(evidence);

    expect(() => validateFullE2eEvidence(evidence)).toThrow(message);
  });

  it.each([
    [
      "a missing cleanup receipt",
      (evidence: ReturnType<typeof validEvidence>) => ({ ...evidence, cleanup: undefined }),
      "cleanup must be an object",
    ],
    [
      "a non-object dispatch receipt",
      (evidence: ReturnType<typeof validEvidence>) => ({ ...evidence, dispatch: "invalid" }),
      "dispatch must be an object",
    ],
    [
      "an empty jobs response",
      (evidence: ReturnType<typeof validEvidence>) => ({ ...evidence, jobs: [] }),
      "jobs response must contain a completed successful Exact staging Brev Launchable job",
    ],
  ])("rejects %s (#7487)", (_name, malformedEvidence, message) => {
    expect(() => validateFullE2eEvidence(malformedEvidence(validEvidence()))).toThrow(message);
  });
});

describe("nemoclaw-maintainer-e2e workflow routing", () => {
  const skill = fs.readFileSync(
    path.join(process.cwd(), ".agents", "skills", "nemoclaw-maintainer-e2e", "SKILL.md"),
    "utf8",
  );

  it("keeps ordinary and billable full requests distinct (#7487)", () => {
    expect(skill).toContain("Run the E2E suite");
    expect(skill).toContain("include_staging_brev_launchable=false");
    expect(skill).toContain("Run the full E2E suite");
    expect(skill).toContain("include_staging_brev_launchable=true");
    expect(skill).toContain("deploy pre-release full E2E");
    expect(skill).toContain("run pre-tag full E2E");
    expect(skill).toContain("run release-candidate E2E");
    expect(skill).toContain("must not authorize the Brev Launchable path");
    expect(skill).toContain(
      "Pre-tag release-ledger evidence uses ordinary `workflow_dispatch` mode",
    );
    expect(skill).toContain(
      "an authorized environment reviewer must approve it before qualification starts",
    );
    expect(skill).toContain(
      "repository `maintain` or `admin` permission before the Launchable path's source",
    );
    expect(skill).not.toMatch(/variable (?:set|delete) NEMOCLAW_BREV_LAUNCHABLE_E2E_ENABLED/u);
  });

  it("binds dispatch, evidence, invalidation, and release handoff to one SHA (#7487)", () => {
    expect(skill).toContain("git rev-parse origin/main");
    expect(skill).toContain("correlation_id=${CORRELATION_ID}");
    expect(skill).toContain("head_sha");
    expect(skill).toContain("Exact staging Brev Launchable");
    expect(skill).toContain("launchable-e2e.json");
    expect(skill).toContain("cleanup.json");
    expect(skill).toContain("dispatch.json");
    expect(skill).toContain("validate-full-e2e-evidence.mts");
    expect(skill).toContain('>"$FULL_E2E_DIR/validated.json"');
    expect(skill).toContain(
      "workflow run ID, creation timestamp, and selected job completion timestamp",
    );
    expect(skill).toContain("exact GCP image and Launchable E2E identity");
    expect(skill).toMatch(/provisional\s+release-ledger evidence/u);
    expect(skill).toContain("If the release candidate SHA changes");
    expect(skill).toContain("nemoclaw-maintainer-cut-release-tag");
  });

  it("selects only direct main, historically validated release image evidence (#7487)", () => {
    expect(skill).toContain("## Select Release Image Evidence");
    expect(skill).toContain("trusted `main` push");
    expect(skill).toContain("jobs=staging-brev-launchable");
    expect(skill).toContain("include_staging_brev_launchable=true");
    expect(skill).toContain("rejects PR-shaped evidence");
    expect(skill).toContain("An itemized release-ledger exception is not image evidence");
    expect(skill).toContain("sorted by `jobCompletedAt` newest first");
    expect(skill).toContain("The selector contract is mode-specific");
    expect(skill).toContain("A Launchable-mode run is not release-ledger evidence");
  });
});
