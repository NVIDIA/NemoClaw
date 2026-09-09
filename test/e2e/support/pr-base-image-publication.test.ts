// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  main,
  type PrBaseImagePublicationInput,
  resolvePrBaseImagePublication,
  validatePrPublicationInputReuse,
} from "../../../tools/e2e/pr-base-image-publication.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const BASE = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const PRODUCER = "a".repeat(40);
const RUN_ID = 34311130620;
const WORKFLOW_ID = 123;
const PR_NUMBER = 11163;
const BRANCH = "feature/mcp";
const WORKFLOW_NAME = "Images / Publish Base and Managed Images";
const WORKFLOW_PATH = ".github/workflows/base-image.yaml";
const PR_PATH = `/repos/${REPOSITORY}/pulls/${PR_NUMBER}`;
const RUN_PATH = `/repos/${REPOSITORY}/actions/runs/${RUN_ID}`;
const WORKFLOW_SOURCE = `on:
  push:
    branches: [main]
    paths:
      - ".github/workflows/base-image.yaml"
      - "Dockerfile.base"
      - "agents/**"
      - "scripts/**"
      - "src/lib/onboard/**"
  workflow_dispatch:
jobs: {}
`;

function input(): PrBaseImagePublicationInput {
  return {
    baseSha: BASE,
    candidateRepository: REPOSITORY,
    candidateSha: CANDIDATE,
    prNumber: PR_NUMBER,
    publicationRevision: PRODUCER,
    publicationRunId: RUN_ID,
    workflowRef: `refs/heads/${BRANCH}`,
    workflowSha: CANDIDATE,
  };
}

function gitReader(
  options: {
    ancestor?: boolean;
    changed?: string[];
    checkout?: string;
    producerWorkflow?: string;
  } = {},
) {
  const handlers = new Map<string, (args: string[]) => string>([
    ["rev-parse", () => options.checkout ?? CANDIDATE],
    [
      "merge-base",
      options.ancestor === false
        ? () => {
            throw new Error("not an ancestor");
          }
        : () => "",
    ],
    [
      "show",
      (args) =>
        args[1] === `${PRODUCER}:${WORKFLOW_PATH}`
          ? (options.producerWorkflow ?? WORKFLOW_SOURCE)
          : WORKFLOW_SOURCE,
    ],
    ["diff", () => (options.changed ?? []).join("\0")],
  ]);
  return vi.fn((args: string[]): string =>
    (
      handlers.get(args[0] ?? "") ??
      (() => {
        throw new Error("unexpected Git read");
      })
    )(args),
  );
}

function pullRequest() {
  return {
    number: PR_NUMBER,
    state: "open",
    base: { sha: BASE, ref: "main", repo: { full_name: REPOSITORY } },
    head: {
      sha: CANDIDATE,
      ref: BRANCH,
      repo: { full_name: REPOSITORY, owner: { login: "NVIDIA", type: "Organization" } },
    },
  };
}

function workflowRun() {
  return {
    id: RUN_ID,
    run_attempt: 1,
    workflow_id: WORKFLOW_ID,
    name: WORKFLOW_NAME,
    path: WORKFLOW_PATH,
    event: "workflow_dispatch",
    head_sha: PRODUCER,
    head_branch: BRANCH,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`,
    status: "completed",
    conclusion: "success",
  };
}

function publisherJobs() {
  const jobs = ["OpenClaw", "Hermes", "Deep Agents Code"].map((agent, index) => ({
    id: index + 1,
    run_id: RUN_ID,
    run_attempt: 1,
    head_sha: PRODUCER,
    name: `Build and push ${agent} base image`,
    status: "completed",
    conclusion: "success",
  }));
  return { jobs, total_count: jobs.length };
}

function fixture() {
  const pr = pullRequest();
  const run = workflowRun();
  const attempt = workflowRun();
  const jobs = publisherJobs();
  const responses = new Map<string, unknown>([
    [PR_PATH, pr],
    [
      `/repos/${REPOSITORY}/actions/workflows/base-image.yaml`,
      {
        id: WORKFLOW_ID,
        name: WORKFLOW_NAME,
        path: WORKFLOW_PATH,
        state: "active",
        html_url: `https://github.com/${REPOSITORY}/blob/main/${WORKFLOW_PATH}`,
        url: `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_ID}`,
      },
    ],
    [RUN_PATH, run],
    [`${RUN_PATH}/attempts/1`, attempt],
    [`${RUN_PATH}/attempts/1/jobs?per_page=100&page=1`, jobs],
  ]);
  const request = vi.fn(async (apiPath: string): Promise<unknown> => {
    const value = responses.get(apiPath) ?? Promise.reject(new Error("unexpected GitHub read"));
    return typeof value === "function" ? value() : value;
  });
  return { pr, run, attempt, jobs, request, responses };
}

describe("exact PR branch base publication", () => {
  it("selects the successful exact attempt without replacing base or image provenance", async () => {
    const state = fixture();
    const result = await resolvePrBaseImagePublication(input(), state.request, gitReader());

    expect(result).toEqual({
      id: RUN_ID,
      attempt: 1,
      workflowId: WORKFLOW_ID,
      headSha: PRODUCER,
      status: "completed",
      conclusion: "success",
      url: state.run.html_url,
    });
    expect(state.request.mock.calls.filter(([apiPath]) => apiPath === PR_PATH)).toHaveLength(2);
  });

  it.each([
    [
      "closed PR",
      (pr: ReturnType<typeof pullRequest>) => {
        pr.state = "closed";
      },
    ],
    [
      "another PR",
      (pr: ReturnType<typeof pullRequest>) => {
        pr.number += 1;
      },
    ],
    [
      "another target branch",
      (pr: ReturnType<typeof pullRequest>) => {
        pr.base.ref = "release";
      },
    ],
    [
      "another base repository",
      (pr: ReturnType<typeof pullRequest>) => {
        pr.base.repo.full_name = "other/repo";
      },
    ],
    [
      "changed base",
      (pr: ReturnType<typeof pullRequest>) => {
        pr.base.sha = "d".repeat(40);
      },
    ],
    [
      "changed head",
      (pr: ReturnType<typeof pullRequest>) => {
        pr.head.sha = "d".repeat(40);
      },
    ],
    [
      "another source branch",
      (pr: ReturnType<typeof pullRequest>) => {
        pr.head.ref = "other";
      },
    ],
    [
      "another source repository",
      (pr: ReturnType<typeof pullRequest>) => {
        pr.head.repo.full_name = "other/repo";
      },
    ],
    [
      "another owner",
      (pr: ReturnType<typeof pullRequest>) => {
        pr.head.repo.owner.login = "other";
      },
    ],
    [
      "non-organization owner",
      (pr: ReturnType<typeof pullRequest>) => {
        pr.head.repo.owner.type = "User";
      },
    ],
  ])("rejects %s before inspecting producer evidence", async (_label, mutate) => {
    const state = fixture();
    mutate(state.pr);

    await expect(
      resolvePrBaseImagePublication(input(), state.request, gitReader()),
    ).rejects.toThrow();
    expect(state.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["id", RUN_ID + 1],
    ["run_attempt", 0],
    ["workflow_id", WORKFLOW_ID + 1],
    ["name", "Another workflow"],
    ["path", ".github/workflows/other.yaml"],
    ["event", "push"],
    ["head_sha", CANDIDATE],
    ["head_branch", "main"],
    ["repository", { full_name: "other/repo" }],
    ["head_repository", { full_name: "other/repo" }],
    ["html_url", "https://example.test/substituted-run"],
    ["status", "in_progress"],
    ["conclusion", "failure"],
  ])("rejects a substituted or incomplete producer %s", async (key, value) => {
    const state = fixture();
    Object.assign(state.run, { [key]: value });

    await expect(
      resolvePrBaseImagePublication(input(), state.request, gitReader()),
    ).rejects.toThrow();
  });

  it("rejects an attempt that differs from the selected run", async () => {
    const state = fixture();
    state.attempt.run_attempt = 2;

    await expect(
      resolvePrBaseImagePublication(input(), state.request, gitReader()),
    ).rejects.toThrow(/attempt/);
  });

  it.each(["failure", "cancelled", "skipped"])(
    "rejects a %s required publisher",
    async (conclusion) => {
      const state = fixture();
      state.jobs.jobs[1]!.conclusion = conclusion;

      await expect(
        resolvePrBaseImagePublication(input(), state.request, gitReader()),
      ).rejects.toThrow(/did not complete successfully/);
    },
  );

  it("rejects a missing required publisher", async () => {
    const state = fixture();
    state.jobs.jobs.pop();
    state.jobs.total_count = 2;

    await expect(
      resolvePrBaseImagePublication(input(), state.request, gitReader()),
    ).rejects.toThrow(/missing required/);
  });

  it("rejects mixed job-attempt provenance", async () => {
    const state = fixture();
    state.jobs.jobs[0]!.run_attempt = 2;

    await expect(
      resolvePrBaseImagePublication(input(), state.request, gitReader()),
    ).rejects.toThrow(/provenance/);
  });

  it("rejects duplicated required publishers", async () => {
    const state = fixture();
    state.jobs.jobs.push({ ...state.jobs.jobs[0]!, id: 4 });
    state.jobs.total_count = 4;

    await expect(
      resolvePrBaseImagePublication(input(), state.request, gitReader()),
    ).rejects.toThrow(/duplicated/);
  });

  it("rejects a run that starts a new attempt during verification", async () => {
    const state = fixture();
    state.responses.set(
      RUN_PATH,
      vi
        .fn()
        .mockReturnValueOnce(state.run)
        .mockReturnValue({ ...state.run, run_attempt: 2 }),
    );

    await expect(
      resolvePrBaseImagePublication(input(), state.request, gitReader()),
    ).rejects.toThrow(/attempt/);
  });

  it("rejects a PR that advances while publisher evidence is checked", async () => {
    const state = fixture();
    state.responses.set(
      PR_PATH,
      vi
        .fn()
        .mockReturnValueOnce(state.pr)
        .mockReturnValue({ ...state.pr, head: { ...state.pr.head, sha: "d".repeat(40) } }),
    );

    await expect(
      resolvePrBaseImagePublication(input(), state.request, gitReader()),
    ).rejects.toThrow(/live PR head/);
  });
});

describe("PR base publication input reuse", () => {
  it("accepts CI-only changes after the producer revision", () => {
    expect(() =>
      validatePrPublicationInputReuse(
        input(),
        gitReader({
          changed: [
            ".github/workflows/e2e.yaml",
            "tools/e2e/pr-base-image-publication.mts",
            "test/e2e/support/pr-base-image-publication.test.ts",
          ],
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    "package.json",
    "package-lock.json",
    "Dockerfile.base",
    "agents/hermes/Dockerfile.base",
    "agents/langchain-deepagents-code/requirements.lock",
    "scripts/security/build-native-security-packages.sh",
    "src/lib/onboard/managed-startup/image-runtime.ts",
    ".github/workflows/base-image.yaml",
  ])("rejects changed image or root audit input %s", (changedPath) => {
    expect(() =>
      validatePrPublicationInputReuse(input(), gitReader({ changed: [changedPath] })),
    ).toThrow(/reviewed image inputs changed/);
  });

  it("retains producer-side input paths if the candidate declaration removes one", () => {
    const producerWorkflow = WORKFLOW_SOURCE.replace(
      '      - "Dockerfile.base"',
      '      - "retired-build-input.json"',
    );
    expect(() =>
      validatePrPublicationInputReuse(
        input(),
        gitReader({
          changed: ["retired-build-input.json"],
          producerWorkflow,
        }),
      ),
    ).toThrow(/reviewed image inputs changed/);
  });

  it("rejects a producer outside candidate ancestry", () => {
    expect(() => validatePrPublicationInputReuse(input(), gitReader({ ancestor: false }))).toThrow(
      /ancestor/,
    );
  });

  it("rejects a checkout outside the exact controller", () => {
    expect(() =>
      validatePrPublicationInputReuse(input(), gitReader({ checkout: PRODUCER })),
    ).toThrow(/checkout/);
  });

  it("rejects exact-base replay and mismatched controller identities", () => {
    expect(() =>
      validatePrPublicationInputReuse({ ...input(), baseSha: CANDIDATE }, gitReader()),
    ).toThrow(/exact-base replay/);
    expect(() =>
      validatePrPublicationInputReuse({ ...input(), workflowSha: PRODUCER }, gitReader()),
    ).toThrow(/controller commit/);
  });
});

describe("PR base publication CLI admission", () => {
  const environment = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: CANDIDATE,
    GITHUB_REF: `refs/heads/${BRANCH}`,
    GITHUB_TOKEN: "fixture-token",
    REQUIRE_MANAGED_IMAGE_PUBLICATION: "0",
    BASE_SHA: BASE,
    CANDIDATE_REPOSITORY: REPOSITORY,
    CANDIDATE_SHA: CANDIDATE,
    MANAGED_IMAGE_SHA: PRODUCER,
    WORKFLOW_SHA: CANDIDATE,
    PR_NUMBER: String(PR_NUMBER),
    BASE_IMAGE_PUBLICATION_RUN_ID: String(RUN_ID),
  };

  it.each([
    ["GITHUB_REPOSITORY", "other/repo"],
    ["GITHUB_EVENT_NAME", "push"],
    ["GITHUB_SHA", PRODUCER],
    ["REQUIRE_MANAGED_IMAGE_PUBLICATION", "1"],
    ["GITHUB_TOKEN", ""],
    ["GITHUB_OUTPUT", ""],
    ["PR_NUMBER", "1e3"],
    ["BASE_IMAGE_PUBLICATION_RUN_ID", "1e3"],
    ["BASE_IMAGE_PUBLICATION_RUN_ID", ""],
  ])("rejects invalid %s before reading producer evidence", async (key, value) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-publication-test-"));
    const output = path.join(directory, "output");
    const request = vi.fn();
    try {
      await expect(
        main(
          { ...environment, GITHUB_OUTPUT: output, [key]: value },
          { request, git: gitReader() },
        ),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes exact producer outputs only after every validation succeeds", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-publication-test-"));
    const output = path.join(directory, "output");
    const state = fixture();
    try {
      await main(
        { ...environment, GITHUB_OUTPUT: output },
        { request: state.request, git: gitReader() },
      );
      expect(fs.readFileSync(output, "utf8")).toBe(
        `run_id=${RUN_ID}\nrun_attempt=1\nhead_sha=${PRODUCER}\n`,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves outputs absent when required publisher evidence is rejected", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-publication-test-"));
    const output = path.join(directory, "output");
    const state = fixture();
    state.jobs.jobs[0]!.conclusion = "failure";
    try {
      await expect(
        main(
          { ...environment, GITHUB_OUTPUT: output },
          { request: state.request, git: gitReader() },
        ),
      ).rejects.toThrow(/did not complete successfully/);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
