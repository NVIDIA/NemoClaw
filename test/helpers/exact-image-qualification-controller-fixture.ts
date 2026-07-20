// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

import {
  type ExactImageDispatchIntent,
  type ExactImageQualificationRequest,
  MANIFEST_ARTIFACT_FILE,
  PRODUCER_REF,
  PRODUCER_REPOSITORY,
  PRODUCER_WORKFLOW_FILE,
  PRODUCER_WORKFLOW_PATH,
  type QualificationDependencies,
  startExactImageQualification,
} from "../../tools/e2e/exact-image-qualification-controller.mts";

export const WORKFLOW_SHA = "c".repeat(40);
export const CANDIDATE_SHA = WORKFLOW_SHA;
export const PRODUCER_SHA = "b".repeat(40);
export const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";
export const RUN_ID = "24680";
export const WORKFLOW_ID = 13579;
export const BASE_TIME = Date.UTC(2026, 0, 1);
export const API_RUN_URL = `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/runs/${RUN_ID}`;
export const HTML_RUN_URL = `https://github.com/${PRODUCER_REPOSITORY}/actions/runs/${RUN_ID}`;

export const REQUEST: ExactImageQualificationRequest = {
  actor: "maintainer",
  candidateSha: CANDIDATE_SHA,
  eventName: "workflow_dispatch",
  reason: "Qualify the current daily candidate before tagging",
  ref: "refs/heads/main",
  requesterRunAttempt: 2,
  requesterRunId: "97531",
  workflowSha: WORKFLOW_SHA,
};

export function dispatchIntent(): ExactImageDispatchIntent {
  return {
    schemaVersion: 1,
    kind: "nemoclaw-exact-image-dispatch-intent",
    requestStartedAt: new Date(BASE_TIME).toISOString(),
    request: {
      actor: REQUEST.actor,
      candidateSha: REQUEST.candidateSha,
      correlationId: CORRELATION_ID,
      reason: REQUEST.reason,
      requesterRunAttempt: REQUEST.requesterRunAttempt,
      requesterRunId: REQUEST.requesterRunId,
      workflowSha: REQUEST.workflowSha,
    },
    producer: {
      repository: PRODUCER_REPOSITORY,
      repositorySha: PRODUCER_SHA,
      ref: PRODUCER_REF,
      workflowId: String(WORKFLOW_ID),
      workflowPath: PRODUCER_WORKFLOW_PATH,
    },
  };
}

type ApiOptions = {
  artifacts?: unknown;
  dispatch?: unknown;
  permission?: string;
  roleName?: string;
  producerSha?: string;
  requesterSha?: string;
  run?: unknown;
  runs?: unknown;
  workflow?: unknown;
};

type ApiRouteHandler = (
  apiPath: string,
  token: string,
  requestOptions?: unknown,
) => unknown | Promise<unknown>;

type ApiRoute = {
  matches: (apiPath: string) => boolean;
  respond: ApiRouteHandler;
};

function mainRef(sha: string) {
  return { ref: "refs/heads/main", object: { type: "commit", sha } };
}

export function dispatchDetails() {
  return {
    workflow_run_id: Number(RUN_ID),
    run_url: API_RUN_URL,
    html_url: HTML_RUN_URL,
  };
}

export function workflowRun(overrides: Record<string, unknown> = {}) {
  return {
    id: Number(RUN_ID),
    workflow_id: WORKFLOW_ID,
    run_attempt: 1,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: PRODUCER_SHA,
    path: PRODUCER_WORKFLOW_PATH,
    display_title: `Qualify NemoClaw ${CANDIDATE_SHA} (${CORRELATION_ID})`,
    url: API_RUN_URL,
    html_url: HTML_RUN_URL,
    repository: { full_name: PRODUCER_REPOSITORY },
    head_repository: { full_name: PRODUCER_REPOSITORY },
    status: "queued",
    conclusion: null,
    created_at: new Date(BASE_TIME).toISOString(),
    ...overrides,
  };
}

export function createApi(options: ApiOptions = {}) {
  return vi.fn(async (apiPath: string, _token: string, requestOptions?: unknown) => {
    if (apiPath === "repos/NVIDIA/NemoClaw/git/ref/heads/main") {
      return mainRef(options.requesterSha ?? WORKFLOW_SHA);
    }
    if (apiPath === `repos/NVIDIA/NemoClaw/git/commits/${CANDIDATE_SHA}`) {
      return { sha: CANDIDATE_SHA };
    }
    if (apiPath.includes("/collaborators/")) {
      return {
        permission: options.permission ?? "write",
        role_name: options.roleName ?? "maintain",
      };
    }
    if (apiPath === `repos/${PRODUCER_REPOSITORY}/git/ref/heads/main`) {
      return mainRef(options.producerSha ?? PRODUCER_SHA);
    }
    if (apiPath === `repos/${PRODUCER_REPOSITORY}/actions/workflows/${PRODUCER_WORKFLOW_FILE}`) {
      return (
        options.workflow ?? {
          id: WORKFLOW_ID,
          path: PRODUCER_WORKFLOW_PATH,
          state: "active",
        }
      );
    }
    if (
      apiPath ===
      `repos/${PRODUCER_REPOSITORY}/actions/workflows/${PRODUCER_WORKFLOW_FILE}/dispatches`
    ) {
      return options.dispatch === undefined ? dispatchDetails() : options.dispatch;
    }
    if (apiPath === `repos/${PRODUCER_REPOSITORY}/actions/runs/${RUN_ID}`) {
      return options.run ?? workflowRun();
    }
    if (apiPath === `repos/${PRODUCER_REPOSITORY}/actions/runs/${RUN_ID}/cancel`) {
      return undefined;
    }
    if (
      apiPath.startsWith(
        `repos/${PRODUCER_REPOSITORY}/actions/workflows/${PRODUCER_WORKFLOW_FILE}/runs?`,
      )
    ) {
      return options.runs ?? { total_count: 0, workflow_runs: [] };
    }
    if (apiPath === `repos/${PRODUCER_REPOSITORY}/actions/runs/${RUN_ID}/artifacts?per_page=100`) {
      return options.artifacts;
    }
    throw new Error(`unexpected API call ${apiPath} ${JSON.stringify(requestOptions)}`);
  });
}

function route(matches: (apiPath: string) => boolean, respond: ApiRouteHandler): ApiRoute {
  return { matches, respond };
}

export const qualificationApiRoute = {
  dispatch: (respond: ApiRouteHandler): ApiRoute =>
    route(
      (apiPath) => apiPath.endsWith(`/workflows/${PRODUCER_WORKFLOW_FILE}/dispatches`),
      respond,
    ),
  workflowRuns: (respond: ApiRouteHandler): ApiRoute =>
    route((apiPath) => apiPath.includes(`/workflows/${PRODUCER_WORKFLOW_FILE}/runs?`), respond),
  run: (respond: ApiRouteHandler): ApiRoute =>
    route((apiPath) => apiPath === `repos/${PRODUCER_REPOSITORY}/actions/runs/${RUN_ID}`, respond),
  runAny: (respond: ApiRouteHandler): ApiRoute =>
    route(
      (apiPath) => /^repos\/brevdev\/nemoclaw-image\/actions\/runs\/[1-9][0-9]*$/u.test(apiPath),
      respond,
    ),
  cancelRun: (respond: ApiRouteHandler): ApiRoute =>
    route(
      (apiPath) => apiPath === `repos/${PRODUCER_REPOSITORY}/actions/runs/${RUN_ID}/cancel`,
      respond,
    ),
  cancelAnyRun: (respond: ApiRouteHandler): ApiRoute =>
    route((apiPath) => apiPath.endsWith("/cancel"), respond),
};

export function createRoutedApi(base: ReturnType<typeof createApi>, routes: readonly ApiRoute[]) {
  return vi.fn(async (apiPath: string, token: string, requestOptions?: unknown) => {
    for (const candidate of routes) {
      if (candidate.matches(apiPath)) {
        return candidate.respond(apiPath, token, requestOptions);
      }
    }
    return base(apiPath, token, requestOptions);
  });
}

export function dependencies(
  api: ReturnType<typeof createApi>,
  extra: QualificationDependencies = {},
) {
  return {
    now: () => BASE_TIME,
    ...extra,
    api: api as QualificationDependencies["api"],
    randomUuid: () => CORRELATION_ID,
  };
}

export function tempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-image-qualification-test-"));
}

export async function startedState(api = createApi()) {
  const workDir = tempDirectory();
  const state = await startExactImageQualification(
    {
      request: REQUEST,
      coreToken: "core-token",
      producerToken: "producer-token",
      workDir,
    },
    dependencies(api),
  );
  return { api, state, workDir };
}

export function artifactList(archive: Buffer, overrides: Record<string, unknown> = {}) {
  const artifactId = 86420;
  return {
    total_count: 1,
    artifacts: [
      {
        id: artifactId,
        name: `nemoclaw-image-handoff-v1-${RUN_ID}-1`,
        expired: false,
        digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
        size_in_bytes: archive.length,
        url: `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/artifacts/${artifactId}`,
        archive_download_url: `https://api.github.com/repos/${PRODUCER_REPOSITORY}/actions/artifacts/${artifactId}/zip`,
        workflow_run: { id: Number(RUN_ID), head_sha: PRODUCER_SHA },
        ...overrides,
      },
    ],
  };
}

export function createArchiveRunCommand(manifest: Buffer, onExtract: () => void = () => {}) {
  return (_command: string, args: readonly string[]) => {
    if (args[0] === "-Z1") {
      return {
        status: 0,
        stdout: Buffer.from(`${MANIFEST_ARTIFACT_FILE}\n`),
        stderr: Buffer.alloc(0),
      };
    }
    if (args[0] === "-Zl") {
      return {
        status: 0,
        stdout: Buffer.from(`-rw-r--r--  3.0 unx  20 tx 20 stor ${MANIFEST_ARTIFACT_FILE}\n`),
        stderr: Buffer.alloc(0),
      };
    }
    onExtract();
    return { status: 0, stdout: manifest, stderr: Buffer.alloc(0) };
  };
}
