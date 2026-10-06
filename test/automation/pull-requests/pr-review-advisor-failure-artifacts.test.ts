// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import {
  recordAdvisorJobFailure,
  redactAdvisorDiagnostic,
} from "../../../tools/pr-review-advisor/failure-artifacts.mts";
import { preserveSpecialistRun } from "../../../tools/pr-review-advisor/run-specialist.mts";
import {
  runAdvisorSpecialist,
  type AdvisorSpecialistLifecycle,
} from "../../../tools/pr-review-advisor/specialist-lifecycle.mts";
import type { RunAdvisorResult } from "../../../tools/advisors/session.mts";

function temporaryDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-failure-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function advisorEnvironment(): NodeJS.ProcessEnv {
  return {
    GITHUB_WORKSPACE: temporaryDirectory(),
    PR_REVIEW_ADVISOR_ARTIFACT_DIR: "specialist",
    PR_REVIEW_ADVISOR_INTEREST: "architecture-standard-work",
  };
}
function failedRun(sessionFile: string): RunAdvisorResult {
  return {
    text: "partial analysis token=private-value",
    raw: "",
    turnTexts: [],
    turnErrors: ["missing E2E receipt"],
    turnCallbackErrors: [],
    sessionFile,
  };
}

it.each([
  { field: "password", value: "private-password" },
  { field: "token", value: "private-token" },
  { field: "authorization", value: "Basic private-authorization" },
])("redacts quoted JSON $field values from failure diagnostics", ({ field, value }) => {
  const redacted = redactAdvisorDiagnostic(JSON.stringify({ [field]: value }));
  expect(redacted).toContain("[REDACTED]");
  expect(redacted).not.toContain(value);
});

it.each(["superseded", "failed"])(
  "retains a host failure receipt for %s setup without step output secrets",
  (classification) => {
    const env = advisorEnvironment();
    env.ADVISOR_PREPARATION_CLASSIFICATION = classification;
    env.ADVISOR_PREPARATION_OUTCOME = "failure";
    env.ADVISOR_ANALYSIS_OUTCOME = "skipped";
    env.PR_REVIEW_ADVISOR_API_KEY = "private-output";
    recordAdvisorJobFailure(env);
    const file = path.join(
      env.GITHUB_WORKSPACE!,
      "artifacts",
      env.PR_REVIEW_ADVISOR_ARTIFACT_DIR!,
      "job-failure.json",
    );
    const text = fs.readFileSync(file, "utf8");
    expect(JSON.parse(text)).toMatchObject({
      status: "failed",
      classification,
      steps: { preparation: "failure", analysis: "skipped" },
    });
    expect(text).not.toContain("private-output");
  },
);

it("rejects a failure artifact path outside its workspace", () => {
  expect(() =>
    recordAdvisorJobFailure({
      ...advisorEnvironment(),
      PR_REVIEW_ADVISOR_ARTIFACT_DIR: "../outside",
    }),
  ).toThrow("simple artifact directory");
});

it.each(["artifacts", "artifacts/specialist"])(
  "rejects a recovered directory link at %s without writing outside the workspace",
  (relative) => {
    const env = advisorEnvironment();
    const outside = temporaryDirectory();
    const sentinel = path.join(outside, "sentinel");
    fs.writeFileSync(sentinel, "keep");
    const link = path.join(env.GITHUB_WORKSPACE!, relative);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link);
    expect(() => recordAdvisorJobFailure(env)).toThrow("must be a real directory");
    expect(fs.readdirSync(outside)).toEqual(["sentinel"]);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  },
);

it("rejects a recovered receipt link without changing its target", () => {
  const env = advisorEnvironment();
  const outside = path.join(temporaryDirectory(), "sentinel");
  fs.writeFileSync(outside, "keep");
  const directory = path.join(env.GITHUB_WORKSPACE!, "artifacts", "specialist");
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(outside, path.join(directory, "job-failure.json"));
  expect(() => recordAdvisorJobFailure(env)).toThrow();
  expect(fs.readFileSync(outside, "utf8")).toBe("keep");
});

it("retains partial native sessions and redacted failure evidence without a complete review", () => {
  const directory = temporaryDirectory();
  const session = path.join(directory, "input.jsonl");
  const content = '{"type":"message","text":"partial investigation"}\n';
  fs.writeFileSync(session, content);
  expect(() =>
    preserveSpecialistRun(directory, "architecture-standard-work", failedRun(session)),
  ).toThrow("missing E2E receipt");
  expect(
    fs.readFileSync(
      path.join(directory, "pr-review-architecture-standard-work-session.jsonl"),
      "utf8",
    ),
  ).toBe(content);
  expect(fs.readFileSync(path.join(directory, "failure.json"), "utf8")).toContain(
    "missing E2E receipt",
  );
  expect(fs.readFileSync(path.join(directory, "failed-analysis.txt"), "utf8")).not.toContain(
    "private-value",
  );
  expect(
    fs.existsSync(path.join(directory, "pr-review-architecture-standard-work-summary.md")),
  ).toBe(false);
});

it.each([
  { name: "missing", prepare: (_file: string) => undefined },
  {
    name: "symlink",
    prepare: (file: string) => {
      fs.writeFileSync(file + ".target", "outside");
      fs.symlinkSync(file + ".target", file);
    },
  },
])("preserves the review error when its session is $name", ({ prepare }) => {
  const directory = temporaryDirectory();
  const session = path.join(directory, "input.jsonl");
  prepare(session);
  expect(() =>
    preserveSpecialistRun(directory, "architecture-standard-work", failedRun(session)),
  ).toThrow("missing E2E receipt");
  expect(
    fs.existsSync(path.join(directory, "pr-review-architecture-standard-work-session.jsonl")),
  ).toBe(false);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "failure.json"), "utf8"));
  expect(receipt.errors).toEqual(
    expect.arrayContaining([
      expect.stringContaining("missing E2E receipt"),
      expect.stringContaining("Session preservation failed:"),
    ]),
  );
});

it.each([
  { name: "succeeds", download: () => undefined, error: "missing E2E receipt" },
  {
    name: "fails",
    download: () => {
      throw new Error("transfer failed");
    },
    error: "missing E2E receipt; artifact recovery also failed: transfer failed",
  },
])("recovers failed analysis before cleanup when download $name", async ({ download, error }) => {
  const calls: string[] = [];
  const lifecycle: AdvisorSpecialistLifecycle = {
    prepare: async () => undefined,
    startGateway: () => undefined,
    create: () => undefined,
    run: () => ({
      cancel: () => undefined,
      completion: Promise.reject(new Error("missing E2E receipt")),
    }),
    download: () => {
      calls.push("download");
      download();
    },
    remove: () => {
      calls.push("remove");
    },
  };
  await expect(runAdvisorSpecialist({ env: {}, lifecycle })).rejects.toThrow(error);
  expect(calls).toEqual(["download", "remove"]);
});
