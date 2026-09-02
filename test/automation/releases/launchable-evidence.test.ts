// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  artifactDownloadArgs,
  inspectLaunchableEvidence,
  parseOptions,
  runCli,
  workflowJobsFromPages,
  workflowRunsApiArgs,
  workflowRunsFromPages,
  type ArtifactFiles,
  type EvidenceReader,
  type WorkflowJob,
  type WorkflowRun,
} from "../../../.agents/skills/nemoclaw-maintainer-e2e/scripts/inspect-launchable-evidence.ts";
const SHA = "a".repeat(40),
  IMAGE_SHA = "b".repeat(40);
const run = (
  id = 10,
  created_at = "2026-06-01T00:00:00Z",
  overrides: Partial<WorkflowRun> = {},
): WorkflowRun => ({
  id,
  run_attempt: 2,
  head_sha: SHA,
  head_branch: "main",
  event: "workflow_dispatch",
  path: ".github/workflows/e2e.yaml",
  status: "completed",
  conclusion: "success",
  html_url: `https://example.test/runs/${id}`,
  created_at,
  ...overrides,
});
const job = (id = 20, overrides: Partial<WorkflowJob> = {}): WorkflowJob => ({
  id,
  name: "Exact staging Brev Launchable",
  status: "completed",
  conclusion: "success",
  html_url: `https://example.test/jobs/${id}`,
  ...overrides,
});
const files = (overrides: Partial<ArtifactFiles> = {}): ArtifactFiles => ({
  "launchable-e2e.json": JSON.stringify({
    candidateSha: SHA,
    producer: { runId: "30", status: "success" },
    boot: {
      bootImage: "registry.test/image@sha256:123",
      schemaVersion: 1,
      sourceRepository: "NVIDIA/NemoClaw",
      sourcePath: "/opt/nemoclaw-image/NemoClaw",
      repoSha: SHA,
      provisionSha: SHA,
      imageRepositorySha: IMAGE_SHA,
      repoClean: true,
      runtimeOverrides: false,
    },
    workspace: { name: "workspace", id: "ws-1" },
    fullE2e: "passed",
  }),
  "full-e2e.log": "output\nNEMOCLAW_FULL_E2E_PASSED\n",
  "cleanup.json": JSON.stringify({
    workspaceName: "workspace",
    workspaceId: "ws-1",
    status: "ABSENT",
    verifiedAt: "2026-06-01T01:00:00Z",
  }),
  ...overrides,
});
const reader = (
  runs: WorkflowRun[] = [run()],
  jobs: Record<string, WorkflowJob[]> = { "10:2": [job()] },
  artifact: ArtifactFiles = files(),
): EvidenceReader => ({
  listRuns: () => runs,
  listJobs: (id, attempt) => jobs[`${id}:${attempt}`] ?? [],
  readArtifact: () => artifact,
});
describe("Launchable evidence inspection", () => {
  it("returns a versioned receipt from candidate-bound successful evidence (#10798)", () =>
    expect(inspectLaunchableEvidence({ candidate: SHA }, reader())).toMatchObject({
      version: 1,
      candidate: { sha: SHA },
      run: { id: 10, attempt: 2 },
      job: { id: 20 },
      artifact: { name: `staging-brev-launchable-${SHA}-10-2` },
      workspace: { name: "workspace", id: "ws-1" },
      fullE2e: { status: "passed" },
      cleanup: { status: "ABSENT" },
    }));
  it.each([
    ["wrong candidate", run(10, "2026-06-01T00:00:00Z", { head_sha: IMAGE_SHA })],
    ["wrong run", run(10, "2026-06-01T00:00:00Z", { path: ".github/workflows/ci.yaml" })],
  ])("rejects %s evidence (#10798)", (_label, value) =>
    expect(() => inspectLaunchableEvidence({ candidate: SHA }, reader([value]))).toThrow(
      "no successful",
    ),
  );
  it("returns recovery identity from a failed cleanup job (#10798)", () => {
    const artifact = files({
      "cleanup.json": JSON.stringify({
        workspaceName: "workspace",
        workspaceId: "ws-1",
        status: "PRESENT",
        checkedAt: "2026-06-01T01:00:00Z",
      }),
    });
    expect(() =>
      inspectLaunchableEvidence(
        { candidate: SHA },
        reader(
          [run(10, "2026-06-01T00:00:00Z", { conclusion: "failure" })],
          { "10:2": [job(20, { conclusion: "failure" })] },
          artifact,
        ),
      ),
    ).toThrow(
      `run=10 attempt=2 job=20 artifact=staging-brev-launchable-${SHA}-10-2 workspace=workspace id=ws-1 status=PRESENT checkedAt=2026-06-01T01:00:00Z`,
    );
  });
  it("rejects a mismatched workspace (#10798)", () =>
    expect(() =>
      inspectLaunchableEvidence(
        { candidate: SHA },
        reader(
          undefined,
          undefined,
          files({
            "cleanup.json": JSON.stringify({
              workspaceName: "other",
              workspaceId: "ws-1",
              status: "ABSENT",
              verifiedAt: "2026-06-01T01:00:00Z",
            }),
          }),
        ),
      ),
    ).toThrow("cleanup workspace"));
  it.each([
    ["missing sentinel", { "full-e2e.log": "NEMOCLAW_FULL_E2E_PASSED extra\n" }],
    ["missing file", { "cleanup.json": undefined }],
  ])("rejects %s (#10798)", (_label, change) =>
    expect(() =>
      inspectLaunchableEvidence({ candidate: SHA }, reader(undefined, undefined, files(change))),
    ).toThrow(),
  );
  it("bounds paginated workflow runs to the candidate (#10798)", () => {
    const runs = workflowRunsFromPages([
      { workflow_runs: [run(10, "2026-06-01T00:00:00Z")] },
      { workflow_runs: [run(11, "2026-07-01T00:00:00Z")] },
    ]);
    expect(workflowRunsApiArgs(SHA)).toEqual([
      "api",
      "--paginate",
      "--slurp",
      `repos/NVIDIA/NemoClaw/actions/workflows/e2e.yaml/runs?per_page=100&head_sha=${SHA}`,
    ]);
    expect(
      inspectLaunchableEvidence(
        { candidate: SHA },
        reader(runs, { "10:2": [job()], "11:2": [job()] }),
      ).run.id,
    ).toBe(11);
  });
  it("merges workflow-run pages before selecting evidence (#10798)", () => {
    const runs = workflowRunsFromPages([
      { workflow_runs: [run(9, "2026-07-01T00:00:00Z", { head_sha: IMAGE_SHA })] },
      { workflow_runs: [run()] },
    ]);
    expect(inspectLaunchableEvidence({ candidate: SHA }, reader(runs)).run.id).toBe(10);
  });
  it("merges workflow-job pages before selecting evidence (#10798)", () => {
    expect(
      workflowJobsFromPages([{ jobs: [job(19, { name: "another job" })] }, { jobs: [job()] }]),
    ).toEqual([job(19, { name: "another job" }), job()]);
    expect(
      workflowJobsFromPages([{ jobs: [job(19, { name: "another job" })] }, { jobs: [] }]),
    ).toEqual([job(19, { name: "another job" })]);
  });
  it("binds job selection to the workflow attempt (#10798)", () => {
    expect(() =>
      inspectLaunchableEvidence(
        { candidate: SHA },
        reader([run(10, "2026-06-01T00:00:00Z", { run_attempt: 3 })]),
      ),
    ).toThrow("no successful");
  });
  it("selects the newest successful job and exact artifact (#10798)", () => {
    const boundary = reader([run(10, "2026-01-01T00:00:00Z"), run(11, "2026-06-01T00:00:00Z")], {
      "10:2": [job(20)],
      "11:2": [job(21)],
    });
    boundary.readArtifact = vi.fn(() => files());
    expect(inspectLaunchableEvidence({ candidate: SHA }, boundary).run.id).toBe(11);
    expect(boundary.readArtifact).toHaveBeenCalledWith(11, `staging-brev-launchable-${SHA}-11-2`);
  });
  it("uses only supported gh run download options (#10798)", () => {
    const args = artifactDownloadArgs(10, "artifact", "/tmp/output"),
      options = new Map([args.slice(3, 5), args.slice(5, 7), args.slice(7, 9)] as [
        string,
        string,
      ][]);
    expect(args.slice(0, 3)).toEqual(["run", "download", "10"]);
    expect(options).toEqual(
      new Map([
        ["--name", "artifact"],
        ["--dir", "/tmp/output"],
        ["--repo", "NVIDIA/NemoClaw"],
      ]),
    );
  });

  it.each([
    [["--candidate", "bad"], "lowercase 40-character SHA"],
    [["--candidate", SHA, "--repo", "attacker/repo"], "unknown option: --repo"],
  ])("rejects invalid CLI input before reading GitHub (#10798)", (args, error) => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const boundary: EvidenceReader = {
      listRuns: vi.fn(() => []),
      listJobs: vi.fn(() => []),
      readArtifact: vi.fn(() => ({})),
    };
    expect(runCli(args, boundary)).toBe(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain(error);
    expect(String(stderr.mock.calls[0]?.[0]).length).toBeLessThan(600);
    expect(boundary.listRuns).not.toHaveBeenCalled();
    expect(boundary.listJobs).not.toHaveBeenCalled();
    expect(boundary.readArtifact).not.toHaveBeenCalled();
  });
  it.each([
    ["PRESENT", "2026-06-01T01:00:00Z", "2026-06-01T02:00:00Z", "2026-06-01T01:00:00Z"],
    ["UNKNOWN", "2026-06-01T01:00:00Z", "2026-06-01T02:00:00Z", "2026-06-01T01:00:00Z"],
    ["PRESENT", undefined, undefined, "<missing>"],
    ["UNKNOWN", undefined, undefined, "<missing>"],
  ])(
    "returns cleanup recovery identity for %s status (#10798)",
    (status, checkedAt, verifiedAt, expected) => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const artifact = files({
        "cleanup.json": JSON.stringify({
          workspaceName: "workspace",
          workspaceId: "ws-1",
          status,
          checkedAt,
          verifiedAt,
        }),
      });
      expect(runCli(["--candidate", SHA], reader(undefined, undefined, artifact))).toBe(1);
      const message = String(stderr.mock.calls.at(-1)?.[0]);
      expect(message).toContain(
        `run=10 attempt=2 job=20 artifact=staging-brev-launchable-${SHA}-10-2 workspace=workspace id=ws-1 status=${status} checkedAt=${expected}`,
      );
      expect(message).not.toContain(`checkedAt=${verifiedAt ?? "undefined"}`);
    },
  );
  it("preserves recovery identity when ABSENT lacks verifiedAt (#10798)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const artifact = files({
      "cleanup.json": JSON.stringify({
        workspaceName: "workspace",
        workspaceId: "ws-1",
        status: "ABSENT",
        checkedAt: "2026-06-01T01:00:00Z",
      }),
    });
    expect(runCli(["--candidate", SHA], reader(undefined, undefined, artifact))).toBe(1);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain(
      `run=10 attempt=2 job=20 artifact=staging-brev-launchable-${SHA}-10-2 workspace=workspace id=ws-1 status=ABSENT checkedAt=2026-06-01T01:00:00Z`,
    );
  });
  it.each([
    [undefined, "record is missing or malformed"],
    ["not json", "record is missing or malformed"],
  ])("preserves workspace identity when cleanup data is %s (#10798)", (cleanup, reason) => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(
      runCli(
        ["--candidate", SHA],
        reader(undefined, undefined, files({ "cleanup.json": cleanup })),
      ),
    ).toBe(1);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain(
      `cleanup ${reason}: run=10 attempt=2 job=20 artifact=staging-brev-launchable-${SHA}-10-2 workspace=workspace id=ws-1 status=<missing> checkedAt=<missing>`,
    );
  });
});
