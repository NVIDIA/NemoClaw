// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type AuthorizationStep = {
  deniedMessage: string;
  mismatchMessage: string;
  name: string;
};

type PermissionScenario =
  | "denied"
  | "malformed-success"
  | "mismatched-actor"
  | "terminal-http"
  | "transient-then-success"
  | "transport-exhaustion";

const AUTHORIZATION_STEPS: AuthorizationStep[] = [
  {
    deniedMessage: "Manual PR E2E requires a repository maintainer or administrator",
    mismatchMessage: "Manual PR E2E permission response did not match the actor",
    name: "Authenticate manual PR dispatch",
  },
  {
    deniedMessage: "Launchable E2E requires a repository maintainer or administrator",
    mismatchMessage: "Launchable E2E permission response did not match the actor",
    name: "Authorize Launchable E2E maintainer dispatch",
  },
];

function authorizationScript(stepName: string): string {
  const workflow = readWorkflow() as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const step = workflow.jobs["generate-matrix"]!.steps!.find(
    (candidate) => candidate.name === stepName,
  );
  expect(step?.run).toEqual(expect.any(String));
  return step!.run!;
}

function lines(path: string): string[] {
  const value = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  return value === "" ? [] : value.split("\n");
}

function runAuthorization(
  stepName: string,
  scenario: PermissionScenario,
  options: { actor?: string; status?: string } = {},
) {
  const fixture = mkdtempSync(join(tmpdir(), "nemoclaw-collaborator-permission-"));
  const attemptFile = join(fixture, "attempts");
  const curlLog = join(fixture, "curl.log");
  const sleepLog = join(fixture, "sleep.log");
  const curlPath = join(fixture, "curl");
  const sleepPath = join(fixture, "sleep");
  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
output_file=""
write_out=""
url="\${!#}"
while (( $# > 0 )); do
  case "$1" in
    --output) output_file="$2"; shift 2 ;;
    --write-out) write_out="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ "$url" == *"/collaborators/"*"/permission" ]]; then
  actor="\${url%/permission}"
  actor="\${actor##*/}"
  attempt="$(cat "$PERMISSION_ATTEMPT_FILE" 2>/dev/null || printf '0')"
  attempt=$((attempt + 1))
  printf '%s\n' "$attempt" >"$PERMISSION_ATTEMPT_FILE"
  printf '%s\n' "permission" >>"$CURL_LOG"
  status=200
  curl_exit=0
  printf -v body '{"user":{"login":"%s"},"role_name":"admin"}' "$actor"
  case "$PERMISSION_SCENARIO" in
    transient-then-success)
      if (( attempt == 1 )); then status="$PERMISSION_TEST_STATUS"; body="private-response-body"; fi
      ;;
    transport-exhaustion) status=000; curl_exit=7; body="" ;;
    terminal-http) status="$PERMISSION_TEST_STATUS"; body="private-response-body" ;;
    malformed-success) body="private-response-body" ;;
    mismatched-actor) body='{"user":{"login":"different-user"},"role_name":"admin"}' ;;
    denied) printf -v body '{"user":{"login":"%s"},"role_name":"write"}' "$actor" ;;
  esac
  if [[ -n "$output_file" ]]; then printf '%s' "$body" >"$output_file"; else printf '%s' "$body"; fi
  if [[ -n "$write_out" ]]; then printf '%s' "$status"; fi
  exit "$curl_exit"
fi

if [[ "$url" == *"/pulls/42" ]]; then
  printf '%s\n' "pull" >>"$CURL_LOG"
  printf '%s' '{"state":"open","head":{"repo":{"full_name":"contributor/NemoClaw"},"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"base":{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}'
  exit 0
fi

exit 2
`,
  );
  writeFileSync(
    sleepPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >>"$SLEEP_LOG"
`,
  );
  chmodSync(curlPath, 0o755);
  chmodSync(sleepPath, 0o755);

  const workflowSha = "c".repeat(40);
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", authorizationScript(stepName)], {
    encoding: "utf8",
    env: {
      ...process.env,
      ACTOR: options.actor ?? "dispatch-admin",
      ALLOW_DGX_SPARK_RUNNER_QUEUE: "false",
      ALLOW_JETSON_DISPATCH: "false",
      BASE_SHA: "b".repeat(40),
      CHECKOUT_REPOSITORY: "contributor/NemoClaw",
      CHECKOUT_SHA: stepName === "Authenticate manual PR dispatch" ? "a".repeat(40) : "",
      CURL_LOG: curlLog,
      EXPECTED_WORKFLOW_SHA: workflowSha,
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      GITHUB_TOKEN: "private-test-token",
      INCLUDE_LAUNCHABLE: stepName === "Authenticate manual PR dispatch" ? "false" : "true",
      JOBS: "",
      PATH: `${fixture}:${process.env.PATH ?? ""}`,
      PERMISSION_ATTEMPT_FILE: attemptFile,
      PERMISSION_SCENARIO: scenario,
      PERMISSION_TEST_STATUS: options.status ?? "503",
      PR_NUMBER: "42",
      REVIEW_REASON: "Reviewed latest PR commit",
      RUN_ATTEMPT: "1",
      RUNNER_TEMP: fixture,
      SLEEP_LOG: sleepLog,
      TARGETS: "",
      TRIGGERING_ACTOR: "dispatch-admin",
      WORKFLOW_EVENT: "workflow_dispatch",
      WORKFLOW_REF: "refs/heads/main",
      WORKFLOW_SHA: workflowSha,
    },
  });
  const permissionAttempts = existsSync(attemptFile)
    ? Number.parseInt(readFileSync(attemptFile, "utf8"), 10)
    : 0;
  const curlOperations = lines(curlLog);
  const sleeps = lines(sleepLog);
  rmSync(fixture, { force: true, recursive: true });
  return { ...result, curlOperations, permissionAttempts, sleeps };
}

describe.each(AUTHORIZATION_STEPS)(
  "$name collaborator permission read",
  ({ deniedMessage, mismatchMessage, name }) => {
    it.each(["408", "429", "503"])(
      "retries HTTP %s once before authorization succeeds (#9337)",
      (status) => {
        const result = runAuthorization(name, "transient-then-success", { status });

        expect(result.status, result.stderr).toBe(0);
        expect(result.permissionAttempts).toBe(2);
        expect(result.sleeps).toEqual(["1"]);
        expect(result.stderr).toContain(
          `Collaborator permission read attempt 1/3 failed: HTTP ${status}; retrying`,
        );
        expect(result.stderr).toContain(
          "Collaborator permission read passed after retry on attempt 2/3",
        );
        expect(result.stderr).not.toContain("private-response-body");
        expect(result.stderr).not.toContain("private-test-token");
      },
    );

    it("stops after three transient transport failures (#9337)", () => {
      const result = runAuthorization(name, "transport-exhaustion");

      expect(result.status).not.toBe(0);
      expect(result.permissionAttempts).toBe(3);
      expect(result.sleeps).toEqual(["1", "2"]);
      expect(result.curlOperations).toEqual(["permission", "permission", "permission"]);
      expect(result.stderr).toContain(
        "Collaborator permission read exhausted after attempt 3/3: transport",
      );
    });

    it.each(["401", "403", "404", "422"])("does not retry HTTP %s (#9337)", (status) => {
      const result = runAuthorization(name, "terminal-http", { status });

      expect(result.status).not.toBe(0);
      expect(result.permissionAttempts).toBe(1);
      expect(result.sleeps).toEqual([]);
      expect(result.curlOperations).toEqual(["permission"]);
      expect(result.stderr).toContain(
        `Collaborator permission read attempt 1/3 failed: HTTP ${status}`,
      );
      expect(result.stderr).not.toContain("private-response-body");
    });

    it("does not retry a malformed HTTP 200 response (#9337)", () => {
      const result = runAuthorization(name, "malformed-success");

      expect(result.status).not.toBe(0);
      expect(result.permissionAttempts).toBe(1);
      expect(result.sleeps).toEqual([]);
      expect(result.curlOperations).toEqual(["permission"]);
      expect(result.stderr).toContain(
        "Collaborator permission read attempt 1/3 failed: malformed response",
      );
      expect(result.stderr).not.toContain("private-response-body");
    });

    it("does not retry a valid response with an unauthorized role (#9337)", () => {
      const result = runAuthorization(name, "denied");

      expect(result.status).not.toBe(0);
      expect(result.permissionAttempts).toBe(1);
      expect(result.sleeps).toEqual([]);
      expect(result.curlOperations).toEqual(["permission"]);
      expect(result.stderr).toContain(deniedMessage);
    });

    it("does not retry a permission response for a different actor (#9337)", () => {
      const result = runAuthorization(name, "mismatched-actor");

      expect(result.status).not.toBe(0);
      expect(result.permissionAttempts).toBe(1);
      expect(result.sleeps).toEqual([]);
      expect(result.curlOperations).toEqual(["permission"]);
      expect(result.stderr).toContain(mismatchMessage);
    });

    it("rejects an invalid actor before the permission read (#9337)", () => {
      const result = runAuthorization(name, "transient-then-success", { actor: "invalid actor" });

      expect(result.status).not.toBe(0);
      expect(result.permissionAttempts).toBe(0);
      expect(result.curlOperations).toEqual([]);
      expect(result.sleeps).toEqual([]);
      expect(result.stderr).toContain("actor is invalid");
    });
  },
);
