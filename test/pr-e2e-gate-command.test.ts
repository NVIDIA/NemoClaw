// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parseControllerCommand } from "../tools/e2e/pr-e2e-gate.mts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "d".repeat(40);

function parseStartCommand(workDir: string, prNumber = "42") {
  return parseControllerCommand([
    "--mode",
    "start",
    "--head",
    HEAD_SHA,
    "--head-repo",
    "NVIDIA/NemoClaw",
    "--head-branch",
    "feature/pr-e2e-gate",
    "--workflow-sha",
    WORKFLOW_SHA,
    "--ci-conclusion",
    "success",
    "--ci-display-title",
    `CI PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
    "--ci-run-attempt",
    "3",
    "--ci-run-id",
    "99",
    "--gate-run-id",
    "77",
    "--pr",
    prNumber,
    "--work-dir",
    workDir,
  ]);
}

describe("PR E2E controller commands", () => {
  it("parses one lifecycle command set inside a private workspace", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-command-"));
    try {
      expect(parseStartCommand(workDir)).toMatchObject({
        mode: "start",
        ciRunAttempt: 3,
        ciRunId: 99,
        gateRunId: 77,
        prNumber: 42,
        planPath: path.join(workDir, "risk-plan.json"),
        statePath: path.join(workDir, "controller-state.json"),
        evidencePath: path.join(workDir, "evidence"),
      });
      expect(parseControllerCommand(["--mode", "cancel", "--pr", "42"])).toEqual({
        mode: "cancel",
        prNumber: 42,
      });
      expect(
        parseControllerCommand([
          "--mode",
          "seed",
          "--pr",
          "42",
          "--head",
          HEAD_SHA,
          "--base",
          BASE_SHA,
        ]),
      ).toEqual({
        mode: "seed",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
      });
      expect(
        parseControllerCommand([
          "--mode",
          "finish",
          "--work-dir",
          workDir,
          "--check-id",
          "17",
          "--run-id",
          "23",
          "--state-hash",
          "a".repeat(64),
          "--evidence-outcome",
          "failure",
        ]),
      ).toMatchObject({
        mode: "finish",
        checkRunId: 17,
        childRunId: 23,
        evidenceOutcome: "failure",
      });
      expect(
        parseControllerCommand([
          "--mode",
          "resolve-fork",
          "--pr",
          "42",
          "--head",
          HEAD_SHA,
          "--base",
          BASE_SHA,
          "--workflow-sha",
          WORKFLOW_SHA,
          "--maintainer",
          "maintainer",
          "--reason",
          "Reviewed exact fork revision",
          "--evidence-url",
          "https://github.com/NVIDIA/NemoClaw/actions/runs/123",
        ]),
      ).toEqual({
        mode: "resolve-fork",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "Reviewed exact fork revision",
        evidenceUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/123",
      });
      expect(
        parseControllerCommand([
          "--mode",
          "resolve-control-plane",
          "--pr",
          "42",
          "--head",
          HEAD_SHA,
          "--base",
          BASE_SHA,
          "--workflow-sha",
          WORKFLOW_SHA,
          "--maintainer",
          "maintainer",
          "--reason",
          "Reviewed exact control-plane revision",
        ]),
      ).toEqual({
        mode: "resolve-control-plane",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "Reviewed exact control-plane revision",
      });
      expect(
        parseControllerCommand(["--mode", "abandon", "--check-id", "17", "--run-id", "23"]),
      ).toEqual({ mode: "abandon", checkRunId: 17, childRunId: 23 });
      expect(() =>
        parseControllerCommand(["--mode", "cancel", "--pr", "9007199254740992"]),
      ).toThrow(/safe integer range/u);
      expect(parseStartCommand(workDir, "")).toMatchObject({ mode: "start", prNumber: undefined });

      fs.chmodSync(workDir, 0o755);
      expect(() => parseControllerCommand(["--mode", "finish", "--work-dir", workDir])).toThrow(
        /owned private absolute directory/u,
      );
    } finally {
      fs.chmodSync(workDir, 0o700);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
