// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parseControllerCommand } from "../tools/e2e/pr-e2e-gate.mts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "d".repeat(40);
const GATE_SCRIPT = fileURLToPath(new URL("../tools/e2e/pr-e2e-gate.mts", import.meta.url));

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

function withPrivateWorkDir(run: (workDir: string) => void) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-command-"));
  try {
    run(workDir);
  } finally {
    fs.chmodSync(workDir, 0o700);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

describe("PR E2E controller commands", () => {
  it("loads under the workflow's Node strip-types runtime", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", GATE_SCRIPT, "--mode", "invalid"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--mode must be seed, start, start-control-plane, finish");
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
  });

  it("parses a start command inside a private workspace", () => {
    withPrivateWorkDir((workDir) => {
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
    });
  });

  it("parses a cancel command", () => {
    expect(parseControllerCommand(["--mode", "cancel", "--pr", "42"])).toEqual({
      mode: "cancel",
      prNumber: 42,
    });
  });

  it("parses a seed command", () => {
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
  });

  it("parses a finish command", () => {
    withPrivateWorkDir((workDir) => {
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
    });
  });

  it("parses a fork credentialed E2E skip resolution", () => {
    expect(
      parseControllerCommand([
        "--mode",
        "record-fork-e2e-skip",
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
      mode: "record-fork-e2e-skip",
      prNumber: 42,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      workflowSha: WORKFLOW_SHA,
      maintainer: "maintainer",
      reason: "Reviewed exact fork revision",
      evidenceUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/123",
    });
  });

  it("parses an authorized control-plane run inside a private workspace", () => {
    withPrivateWorkDir((workDir) => {
      expect(
        parseControllerCommand([
          "--mode",
          "start-control-plane",
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
          "Reviewed exact credentialed control-plane execution",
          "--gate-run-id",
          "77",
          "--workflow-run-attempt",
          "1",
          "--work-dir",
          workDir,
        ]),
      ).toMatchObject({
        mode: "start-control-plane",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "Reviewed exact credentialed control-plane execution",
        gateRunId: 77,
        workflowRunAttempt: 1,
        planPath: path.join(workDir, "risk-plan.json"),
      });
    });
  });

  it("rejects the removed control-plane bypass mode", () => {
    expect(() => parseControllerCommand(["--mode", "resolve-control-plane"])).toThrow(
      /--mode must be/u,
    );
  });

  it("parses an abandon command", () => {
    expect(
      parseControllerCommand(["--mode", "abandon", "--check-id", "17", "--run-id", "23"]),
    ).toEqual({ mode: "abandon", checkRunId: 17, childRunId: 23 });
  });

  it("parses a wait command", () => {
    expect(parseControllerCommand(["--mode", "wait", "--run-id", "23"])).toEqual({
      mode: "wait",
      childRunId: 23,
    });
  });

  it("rejects a wait command without a positive run ID", () => {
    expect(() => parseControllerCommand(["--mode", "wait", "--run-id", "0"])).toThrow(
      /positive integer/u,
    );
  });

  it("parses a download command into the private evidence workspace", () => {
    withPrivateWorkDir((workDir) => {
      expect(
        parseControllerCommand(["--mode", "download", "--run-id", "23", "--work-dir", workDir]),
      ).toEqual({
        mode: "download",
        childRunId: 23,
        planPath: path.join(workDir, "risk-plan.json"),
        statePath: path.join(workDir, "controller-state.json"),
        evidencePath: path.join(workDir, "evidence"),
      });
    });
  });

  it("rejects a download workspace that is not private", () => {
    withPrivateWorkDir((workDir) => {
      fs.chmodSync(workDir, 0o755);
      expect(() =>
        parseControllerCommand(["--mode", "download", "--run-id", "23", "--work-dir", workDir]),
      ).toThrow(/owned private absolute directory/u);
    });
  });

  it("rejects an unsafe pull request number", () => {
    expect(() => parseControllerCommand(["--mode", "cancel", "--pr", "9007199254740992"])).toThrow(
      /safe integer range/u,
    );
  });

  it("accepts a start command without a pull request number", () => {
    withPrivateWorkDir((workDir) => {
      expect(parseStartCommand(workDir, "")).toMatchObject({ mode: "start", prNumber: undefined });
    });
  });

  it("rejects a finish workspace that is not private", () => {
    withPrivateWorkDir((workDir) => {
      fs.chmodSync(workDir, 0o755);
      expect(() => parseControllerCommand(["--mode", "finish", "--work-dir", workDir])).toThrow(
        /owned private absolute directory/u,
      );
    });
  });
});
