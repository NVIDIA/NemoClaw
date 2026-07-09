// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRiskPlan, RISK_RULES } from "../tools/advisors/risk-plan.mts";
import {
  assertTrustedMainPush,
  changedFilesBetween,
  classifyRiskEvidence,
  dispatchRiskWorkflow,
  expectedRiskSignalShards,
  findSignalFiles,
  finishRiskGate,
  parseControllerCommand,
  type RiskGateState,
  validateRiskGateState,
  validateRiskPlan,
  validateSignal,
  validateWorkflowDispatchDetails,
} from "../tools/e2e-advisor/post-merge-risk-gate.mts";
import type { E2eRiskSignal } from "../tools/e2e-advisor/risk-signal.ts";

const HEAD_SHA = "a".repeat(40);
const ALLOWED = new Set(["onboard-repair", "onboard-resume"]);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function state(): RiskGateState {
  return {
    version: 1,
    commitSha: HEAD_SHA,
    planHash: buildRiskPlan({ headSha: HEAD_SHA, changedFiles: ["src/lib/onboard.ts"] }).planHash,
    correlationId: "12345678-1234-4123-8123-123456789abc",
    expectedJobs: ["onboard-repair", "onboard-resume"],
    expectedShards: {
      "onboard-repair": ["default"],
      "onboard-resume": ["default"],
    },
    requiresManualExpansion: false,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function signal(jobId: string, overrides: Partial<E2eRiskSignal> = {}): E2eRiskSignal {
  const gate = state();
  return {
    version: 1,
    jobId,
    shardId: "default",
    expectedSha: gate.commitSha,
    testedSha: gate.commitSha,
    planHash: gate.planHash,
    correlationId: gate.correlationId,
    passed: 1,
    failed: 0,
    skipped: 0,
    pending: 0,
    unhandledErrors: 0,
    runReason: "passed",
    ...overrides,
  };
}

describe("post-merge E2E risk gate", () => {
  it("accepts only the exact trusted main-push context", () => {
    const trusted = {
      eventName: "push",
      ref: "refs/heads/main",
      sha: HEAD_SHA,
      commitSha: HEAD_SHA,
    };

    expect(() => assertTrustedMainPush(trusted)).not.toThrow();
    expect(() => assertTrustedMainPush({ ...trusted, eventName: "pull_request" })).toThrow(
      /exact trusted main push/u,
    );
    expect(() => assertTrustedMainPush({ ...trusted, ref: "refs/heads/feature" })).toThrow(
      /exact trusted main push/u,
    );
    expect(() => assertTrustedMainPush({ ...trusted, sha: "b".repeat(40) })).toThrow(
      /exact trusted main push/u,
    );
  });

  it("requires a private controller workspace and parses the abandon check id", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-controller-"));
    try {
      expect(
        parseControllerCommand([
          "--mode",
          "start",
          "--base",
          "b".repeat(40),
          "--commit",
          HEAD_SHA,
          "--work-dir",
          workDir,
        ]),
      ).toMatchObject({
        mode: "start",
        planPath: path.join(workDir, "post-merge-risk-plan.json"),
        statePath: path.join(workDir, "e2e-risk-gate-state.json"),
        evidencePath: path.join(workDir, "evidence"),
      });
      expect(parseControllerCommand(["--mode", "abandon", "--check-id", "17"])).toEqual({
        mode: "abandon",
        checkRunId: 17,
      });
      expect(
        parseControllerCommand([
          "--mode",
          "finish",
          "--work-dir",
          workDir,
          "--state-hash",
          "b".repeat(64),
          "--check-id",
          "17",
          "--run-id",
          "23",
        ]),
      ).toMatchObject({
        mode: "finish",
        checkRunId: 17,
        childRunId: 23,
        stateHash: "b".repeat(64),
      });
      expect(() =>
        parseControllerCommand(["--mode", "abandon", "--check-id", "9007199254740992"]),
      ).toThrow(/safe integer range/u);
      expect(() =>
        parseControllerCommand([
          "--mode",
          "finish",
          "--work-dir",
          workDir,
          "--state-hash",
          "unsafe",
          "--check-id",
          "17",
          "--run-id",
          "23",
        ]),
      ).toThrow(/state-hash must be a lowercase SHA-256 hash/u);
      expect(() => parseControllerCommand(["--mode", "finish"])).toThrow(/--work-dir/u);

      fs.chmodSync(workDir, 0o755);
      expect(() => parseControllerCommand(["--mode", "finish", "--work-dir", workDir])).toThrow(
        /owned private absolute directory/u,
      );
    } finally {
      fs.chmodSync(workDir, 0o700);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("derives changed files from an exact checked-out commit range", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    try {
      git("init", "--quiet");
      git("config", "user.name", "Risk Gate Test");
      git("config", "user.email", "risk-gate@example.invalid");
      fs.writeFileSync(path.join(directory, "README.md"), "base\n");
      fs.mkdirSync(path.join(directory, "src", "lib", "credentials"), { recursive: true });
      fs.writeFileSync(path.join(directory, "src", "lib", "credentials", "token.ts"), "base\n");
      git("add", "README.md", "src/lib/credentials/token.ts");
      git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base");
      const base = git("rev-parse", "HEAD");
      fs.mkdirSync(path.join(directory, "docs"));
      git("mv", "src/lib/credentials/token.ts", "docs/token.ts");
      fs.writeFileSync(path.join(directory, "src", "feature.ts"), "export {};\n");
      git("add", "docs/token.ts", "src/feature.ts");
      git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "feature");
      const head = git("rev-parse", "HEAD");

      expect(changedFilesBetween(base, head, directory)).toEqual([
        "docs/token.ts",
        "src/feature.ts",
        "src/lib/credentials/token.ts",
      ]);
      expect(() => changedFilesBetween(head, base, directory)).toThrow(/does not match/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts only the deterministic plan for the tested commit", () => {
    const plan = buildRiskPlan({ headSha: HEAD_SHA, changedFiles: ["src/lib/onboard.ts"] });

    expect(validateRiskPlan(plan, ALLOWED)).toEqual(plan);
    expect(() => validateRiskPlan({ ...plan, planHash: "b".repeat(64) }, ALLOWED)).toThrow(
      /deterministic hash/u,
    );
    expect(() => validateRiskPlan(plan, new Set())).toThrow(/unknown E2E job/u);
  });

  it("accepts only bounded gate state for the exact commit and evidence policy", () => {
    const gate = state();

    expect(validateRiskGateState(gate)).toEqual(gate);
    expect(() => validateRiskGateState({ ...gate, commitSha: "unsafe" })).toThrow(/commit SHA/u);
    expect(() => validateRiskGateState({ ...gate, expectedJobs: ["../unsafe"] })).toThrow(
      /expected jobs/u,
    );
    expect(() => validateRiskGateState({ ...gate, expectedShards: {} })).toThrow(/shard jobs/u);
  });

  it("uses the workflow run identity returned by the exact dispatch request", async () => {
    const gate = state();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          workflow_run_id: 23,
          run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/23",
          html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
        }),
    } as Response);

    const runId = await dispatchRiskWorkflow({
      repository: "NVIDIA/NemoClaw",
      token: "token",
      jobs: ["onboard-repair"],
      commitSha: gate.commitSha,
      planHash: gate.planHash,
      correlationId: gate.correlationId,
    });

    expect(runId).toBe(23);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/NVIDIA/NemoClaw/actions/workflows/e2e.yaml/dispatches",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      ref: "main",
      return_run_details: true,
      inputs: {
        jobs: "onboard-repair",
        checkout_sha: gate.commitSha,
        risk_plan_hash: gate.planHash,
        risk_correlation: gate.correlationId,
        risk_shadow: "true",
      },
    });
    expect(() =>
      validateWorkflowDispatchDetails(
        {
          workflow_run_id: 23,
          run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/24",
          html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23",
        },
        "NVIDIA/NemoClaw",
      ),
    ).toThrow(/mismatched workflow dispatch URLs/u);
  });

  it("finish reports the directly dispatched child failure when main advances", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-finish-"));
    const statePath = path.join(workDir, "e2e-risk-gate-state.json");
    const gate = state();
    const serializedState = `${JSON.stringify(gate)}\n`;
    const childRunId = 23;
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    fs.writeFileSync(statePath, serializedState, { mode: 0o600 });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            id: childRunId,
            name: "E2E",
            event: "workflow_dispatch",
            head_sha: "b".repeat(40),
            status: "completed",
            conclusion: "failure",
            created_at: "2026-07-08T00:00:00.000Z",
            display_title: `E2E risk ${gate.correlationId}`,
            html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${childRunId}`,
          }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" } as Response);

    try {
      await finishRiskGate({
        statePath,
        stateHash: sha256(serializedState),
        evidencePath: path.join(workDir, "evidence"),
        checkRunId: 17,
        childRunId,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain("check-runs/17");
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: { title: "Selected E2E workflow failed" },
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects changed controller state before classifying downloaded evidence", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-state-"));
    const statePath = path.join(workDir, "e2e-risk-gate-state.json");
    const originalState = `${JSON.stringify(state())}\n`;
    const changedState = `${JSON.stringify({ ...state(), requiresManualExpansion: true })}\n`;
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    fs.writeFileSync(statePath, changedState, { mode: 0o600 });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, text: async () => "{}" } as Response);

    try {
      await expect(
        finishRiskGate({
          statePath,
          stateHash: sha256(originalState),
          evidencePath: path.join(workDir, "evidence"),
          checkRunId: 17,
          childRunId: 23,
        }),
      ).rejects.toThrow(/controller state changed after E2E dispatch/u);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("check-runs/17");
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        status: "completed",
        conclusion: "neutral",
        output: { title: "Risk-selected E2E evidence could not be verified" },
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("bounds downloaded risk-evidence traversal by entries, depth, and signals", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-risk-evidence-"));
    const rootLink = `${directory}-link`;
    const nested = path.join(directory, "artifact", "live", "job");
    try {
      fs.mkdirSync(nested, { recursive: true });
      const signalFile = path.join(nested, "risk-signal.json");
      fs.writeFileSync(signalFile, "{}\n");

      expect(findSignalFiles(directory)).toEqual([signalFile]);
      expect(() =>
        findSignalFiles(directory, { maxDepth: 2, maxEntries: 10, maxSignalFiles: 2 }),
      ).toThrow(/depth limit/u);
      expect(() =>
        findSignalFiles(directory, { maxDepth: 8, maxEntries: 2, maxSignalFiles: 2 }),
      ).toThrow(/entry limit/u);
      const second = path.join(directory, "artifact-2");
      fs.mkdirSync(second);
      fs.writeFileSync(path.join(second, "risk-signal.json"), "{}\n");
      expect(() =>
        findSignalFiles(directory, { maxDepth: 8, maxEntries: 10, maxSignalFiles: 1 }),
      ).toThrow(/signal-file limit/u);
      expect(() =>
        findSignalFiles(directory, { maxDepth: 8, maxEntries: 10, maxSignalFiles: 0 }),
      ).toThrow(/limits are invalid/u);
      fs.symlinkSync(directory, rootLink, "dir");
      expect(() => findSignalFiles(rootLink)).toThrow(/root must be a directory, not a symlink/u);
    } finally {
      fs.rmSync(rootLink, { force: true });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts only signals bound to the expected job, SHA, plan, and correlation", () => {
    const gate = state();

    expect(validateSignal(signal("onboard-resume"), gate).jobId).toBe("onboard-resume");
    expect(() =>
      validateSignal(signal("onboard-resume", { expectedSha: "b".repeat(40) }), gate),
    ).toThrow(/SHA mismatch/u);
    expect(() => validateSignal(signal("other"), gate)).toThrow(/unexpected/u);
    expect(() => validateSignal(signal("onboard-resume", { shardId: "unexpected" }), gate)).toThrow(
      /shard/u,
    );
  });

  it("derives expected evidence shards from the trusted E2E workflow", () => {
    const jobIds = [...new Set(RISK_RULES.flatMap((rule) => rule.requiredJobs))];
    const shards = expectedRiskSignalShards(jobIds);

    expect(Object.keys(shards).sort()).toEqual(jobIds.sort());
    expect(shards["onboard-resume"]).toEqual(["default"]);
    expect(shards["security-posture"]).toEqual(["openclaw", "hermes"]);
    expect(shards["channels-stop-start"]).toEqual(["openclaw", "hermes"]);
  });

  it("reports success only for complete unskipped evidence", () => {
    const verdict = classifyRiskEvidence({
      workflowConclusion: "success",
      expectedJobs: ["onboard-repair", "onboard-resume"],
      expectedShards: state().expectedShards,
      signals: [signal("onboard-repair"), signal("onboard-resume")],
      requiresManualExpansion: false,
    });

    expect(verdict.conclusion).toBe("success");
    expect(verdict.summary).not.toContain("onboard-repair");
  });

  it.each([
    {
      label: "missing signal",
      signals: [signal("onboard-repair")],
      manual: false,
    },
    {
      label: "skipped test",
      signals: [signal("onboard-repair"), signal("onboard-resume", { skipped: 1 })],
      manual: false,
    },
    {
      label: "manual expansion",
      signals: [signal("onboard-repair"), signal("onboard-resume")],
      manual: true,
    },
    {
      label: "duplicate signal",
      signals: [signal("onboard-repair"), signal("onboard-repair"), signal("onboard-resume")],
      manual: false,
    },
  ])("reports neutral for $label", ({ signals, manual }) => {
    const verdict = classifyRiskEvidence({
      workflowConclusion: "success",
      expectedJobs: ["onboard-repair", "onboard-resume"],
      expectedShards: state().expectedShards,
      signals,
      requiresManualExpansion: manual,
    });

    expect(verdict.conclusion).toBe("neutral");
    expect(verdict.summary).not.toContain("onboard-repair");
  });

  it("reports a product workflow failure as failure", () => {
    const verdict = classifyRiskEvidence({
      workflowConclusion: "failure",
      expectedJobs: ["onboard-repair"],
      expectedShards: { "onboard-repair": ["default"] },
      signals: [],
      requiresManualExpansion: false,
    });

    expect(verdict.conclusion).toBe("failure");
    expect(verdict.summary).not.toContain("onboard-repair");
  });

  it("reports failed test evidence as failure even when the workflow is green", () => {
    const verdict = classifyRiskEvidence({
      workflowConclusion: "success",
      expectedJobs: ["onboard-repair"],
      expectedShards: { "onboard-repair": ["default"] },
      signals: [signal("onboard-repair", { failed: 1, runReason: "failed" })],
      requiresManualExpansion: false,
    });

    expect(verdict.conclusion).toBe("failure");
    expect(verdict.summary).not.toContain("onboard-repair");
  });

  it("requires every expected matrix shard to pass", () => {
    const complete = classifyRiskEvidence({
      workflowConclusion: "success",
      expectedJobs: ["security-posture"],
      expectedShards: { "security-posture": ["openclaw", "hermes"] },
      signals: [
        signal("security-posture", { shardId: "openclaw" }),
        signal("security-posture", { shardId: "hermes" }),
      ],
      requiresManualExpansion: false,
    });
    const missingShard = classifyRiskEvidence({
      workflowConclusion: "success",
      expectedJobs: ["security-posture"],
      expectedShards: { "security-posture": ["openclaw", "hermes"] },
      signals: [signal("security-posture", { shardId: "openclaw" })],
      requiresManualExpansion: false,
    });

    expect(complete.conclusion).toBe("success");
    expect(missingShard.conclusion).toBe("neutral");
    expect(missingShard.summary).not.toContain("security-posture");
  });
});
