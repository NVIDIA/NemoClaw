// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, type TestContext, vi } from "vitest";

import { readWorkflow } from "../../helpers/e2e-workflow-contract";
import {
  runSupervisedProcess,
  type SupervisedProcessResult,
} from "../../helpers/supervised-process";

type AuthorizationStep = {
  deniedMessage: string;
  mismatchMessage: string;
  name: string;
};

type PermissionScenario =
  | "blocking"
  | "denied"
  | "malformed-success"
  | "mismatched-actor"
  | "terminal-http"
  | "transient-then-success"
  | "transport-exhaustion";

const AUTHORIZATION_STEPS: AuthorizationStep[] = [
  {
    deniedMessage: "Launchable E2E requires a repository maintainer or administrator",
    mismatchMessage: "Launchable E2E permission response did not match the actor",
    name: "Authorize Launchable E2E maintainer dispatch",
  },
];

const MAX_PROCESS_OUTPUT_BYTES = 10 * 1024 * 1024;

function runProcess(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  owner: Pick<TestContext, "onTestFinished" | "signal">,
  maxOutputBytes = MAX_PROCESS_OUTPUT_BYTES,
) {
  return runSupervisedProcess(file, args, {
    env,
    maxOutputBytesPerStream: maxOutputBytes,
    owner,
    timeoutMs: 10_000,
  });
}

vi.setConfig({ maxConcurrency: 8 });

function authorizationScript(stepName: string): string {
  const workflow = readWorkflow() as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const step = workflow.jobs["generate-matrix"]!.steps!.find(
    (candidate) => candidate.name === stepName,
  );
  assert.equal(typeof step?.run, "string", `${stepName} script is missing`);
  return step!.run!;
}

function lines(path: string): string[] {
  const value = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  return value === "" ? [] : value.split("\n");
}

async function runAuthorization(
  owner: Pick<TestContext, "onTestFinished" | "signal">,
  stepName: string,
  scenario: PermissionScenario,
  options: {
    actor?: string;
    onFixtureCreated?: (fixture: string) => void;
    status?: string;
  } = {},
) {
  const fixture = mkdtempSync(join(tmpdir(), "nemoclaw-collaborator-permission-"));
  options.onFixtureCreated?.(fixture);
  const attemptFile = join(fixture, "attempts");
  const curlLog = join(fixture, "curl.log");
  const permissionProcessFile = join(fixture, "permission-process");
  const permissionReadyFile = join(fixture, "permission-ready");
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
    blocking)
      printf '%s\n' "$$" >"$PERMISSION_PROCESS_FILE"
      : >"$PERMISSION_READY_FILE"
      exec /bin/sleep 60
      ;;
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

  try {
    const workflowSha = "c".repeat(40);
    const result = await runProcess(
      "bash",
      ["--noprofile", "--norc", "-c", authorizationScript(stepName)],
      {
        ...process.env,
        ACTOR: options.actor ?? "dispatch-admin",
        ALLOW_JETSON_DISPATCH: "false",
        BASE_SHA: "b".repeat(40),
        CHECKOUT_REPOSITORY: "contributor/NemoClaw",
        CHECKOUT_SHA: "",
        CURL_LOG: curlLog,
        EXPECTED_WORKFLOW_SHA: workflowSha,
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        GITHUB_TOKEN: "private-test-token",
        INCLUDE_LAUNCHABLE: "true",
        JOBS: "",
        PATH: `${fixture}:${process.env.PATH ?? ""}`,
        PERMISSION_ATTEMPT_FILE: attemptFile,
        PERMISSION_PROCESS_FILE: permissionProcessFile,
        PERMISSION_READY_FILE: permissionReadyFile,
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
      owner,
    );
    const permissionAttempts = existsSync(attemptFile)
      ? Number.parseInt(readFileSync(attemptFile, "utf8"), 10)
      : 0;
    const permissionPid = existsSync(permissionProcessFile)
      ? Number.parseInt(readFileSync(permissionProcessFile, "utf8"), 10)
      : undefined;
    let permissionProcessRunning = false;
    try {
      process.kill(permissionPid ?? Number.NaN, 0);
      permissionProcessRunning = true;
    } catch {
      // No permission process was started, or the cancelled process is gone as required.
    }
    return {
      ...result,
      curlOperations: lines(curlLog),
      permissionAttempts,
      permissionProcessRunning,
      sleeps: lines(sleepLog),
    };
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
}

describe.concurrent.each(AUTHORIZATION_STEPS)(
  "$name collaborator permission read",
  ({ deniedMessage, mismatchMessage, name }) => {
    it.for(["408", "429", "503"])(
      "retries HTTP %s once before authorization succeeds (#9337)",
      async (status, context) => {
        const { expect } = context;
        const result = await runAuthorization(context, name, "transient-then-success", { status });

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

    it("stops after three transient transport failures (#9337)", async (context) => {
      const { expect } = context;
      const result = await runAuthorization(context, name, "transport-exhaustion");

      expect(result.status).not.toBe(0);
      expect(result.permissionAttempts).toBe(3);
      expect(result.sleeps).toEqual(["1", "2"]);
      expect(result.curlOperations).toEqual(["permission", "permission", "permission"]);
      expect(result.stderr).toContain(
        "Collaborator permission read exhausted after attempt 3/3: transport",
      );
    });

    it.for(["401", "403", "404", "422"])(
      "does not retry HTTP %s (#9337)",
      async (status, context) => {
        const { expect } = context;
        const result = await runAuthorization(context, name, "terminal-http", { status });

        expect(result.status).not.toBe(0);
        expect(result.permissionAttempts).toBe(1);
        expect(result.sleeps).toEqual([]);
        expect(result.curlOperations).toEqual(["permission"]);
        expect(result.stderr).toContain(
          `Collaborator permission read attempt 1/3 failed: HTTP ${status}`,
        );
        expect(result.stderr).not.toContain("private-response-body");
      },
    );

    it("does not retry a malformed HTTP 200 response (#9337)", async (context) => {
      const { expect } = context;
      const result = await runAuthorization(context, name, "malformed-success");

      expect(result.status).not.toBe(0);
      expect(result.permissionAttempts).toBe(1);
      expect(result.sleeps).toEqual([]);
      expect(result.curlOperations).toEqual(["permission"]);
      expect(result.stderr).toContain(
        "Collaborator permission read attempt 1/3 failed: malformed response",
      );
      expect(result.stderr).not.toContain("private-response-body");
    });

    it("does not retry a valid response with an unauthorized role (#9337)", async (context) => {
      const { expect } = context;
      const result = await runAuthorization(context, name, "denied");

      expect(result.status).not.toBe(0);
      expect(result.permissionAttempts).toBe(1);
      expect(result.sleeps).toEqual([]);
      expect(result.curlOperations).toEqual(["permission"]);
      expect(result.stderr).toContain(deniedMessage);
    });

    it("does not retry a permission response for a different actor (#9337)", async (context) => {
      const { expect } = context;
      const result = await runAuthorization(context, name, "mismatched-actor");

      expect(result.status).not.toBe(0);
      expect(result.permissionAttempts).toBe(1);
      expect(result.sleeps).toEqual([]);
      expect(result.curlOperations).toEqual(["permission"]);
      expect(result.stderr).toContain(mismatchMessage);
    });

    it("rejects an invalid actor before the permission read (#9337)", async (context) => {
      const { expect } = context;
      const result = await runAuthorization(context, name, "transient-then-success", {
        actor: "invalid actor",
      });

      expect(result.status).not.toBe(0);
      expect(result.permissionAttempts).toBe(0);
      expect(result.curlOperations).toEqual([]);
      expect(result.sleeps).toEqual([]);
      expect(result.stderr).toContain("actor is invalid");
    });

    it("kills a blocked permission read and removes its fixture when cancelled", async (context) => {
      const deadline = new AbortController();
      let fixture = "";
      const resultPromise = runAuthorization(
        {
          onTestFinished: (handler) => context.onTestFinished(handler),
          signal: AbortSignal.any([context.signal, deadline.signal]),
        },
        name,
        "blocking",
        {
          onFixtureCreated: (createdFixture) => {
            fixture = createdFixture;
          },
        },
      );
      try {
        await vi.waitFor(
          () => context.expect(existsSync(join(fixture, "permission-ready"))).toBe(true),
          {
            interval: 10,
            timeout: 5_000,
          },
        );
        deadline.abort();
        const result = await resultPromise;

        context.expect(result.status).toBeNull();
        context.expect(result.signal).toMatch(/^SIG(?:TERM|KILL)$/);
        context.expect(result.permissionProcessRunning).toBe(false);
        context.expect(existsSync(fixture)).toBe(false);
      } finally {
        deadline.abort();
        await resultPromise;
      }
    });

    it.sequential("bounds child output and reaps its process group", async (context) => {
      const fixture = mkdtempSync(join(tmpdir(), "nemoclaw-collaborator-output-"));
      const processFile = join(fixture, "process");
      let result: SupervisedProcessResult | undefined;
      let outputProcessPid = Number.NaN;
      try {
        result = await runProcess(
          "bash",
          [
            "--noprofile",
            "--norc",
            "-c",
            `printf '%s\\n' "$$" >"$PERMISSION_PROCESS_FILE"
/usr/bin/head -c 65537 /dev/zero >&2
exec /bin/sleep 60`,
          ],
          { ...process.env, PERMISSION_PROCESS_FILE: processFile },
          context,
          64 * 1024,
        );
        outputProcessPid = Number.parseInt(readFileSync(processFile, "utf8"), 10);
      } finally {
        rmSync(fixture, { force: true, recursive: true });
      }
      let outputProcessRunning = false;
      try {
        process.kill(outputProcessPid, 0);
        outputProcessRunning = true;
      } catch {
        // The output-limited process is gone as required.
      }

      context.expect(result?.error?.message).toBe("stderr exceeded the process output limit");
      context.expect(result?.status).toBeNull();
      context.expect(result?.signal).toMatch(/^SIG(?:TERM|KILL)$/);
      context.expect(outputProcessRunning).toBe(false);
    });

    it.sequential("reports oversized output as failure after a zero exit", async (context) => {
      const result = await runProcess(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          "(sleep 0.05; /usr/bin/head -c 2048 /dev/zero >&2) & exit 0",
        ],
        process.env,
        context,
        1024,
      );

      context.expect(result.error?.message).toBe("stderr exceeded the process output limit");
      context.expect(result.status).toBe(-1);
      context.expect(result.signal).toBeNull();
    });
  },
);
