// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  childCompletion,
  childOutputAfterDelay,
  cleanupIssue9880Fixtures,
  issue9880Fixture,
  waitForIssue9880RemoteScript,
} from "../../helpers/brev-launchable-issue-9880-fixture.ts";
import { treeContainsLiteral } from "../../helpers/secret-scan.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

type Step = {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type Workflow = {
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs?: Record<
    string,
    {
      if?: string;
      permissions?: Record<string, string>;
      steps?: Step[];
    }
  >;
};

const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/issue-9880-staging-reproduction.yaml",
);
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  "tools/e2e/brev-launchable-issue-9880.sh",
);

afterEach(() => cleanupIssue9880Fixtures());

function workflow(): Workflow {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

function step(value: Workflow, name: string): Step {
  const found = value.jobs?.reproduce?.steps?.find(
    (entry) => entry.name === name,
  );
  expect(found).toBeDefined();
  return found!;
}

describe("the staging Launchable reproduces the bounded OpenClaw CLI scenario", () => {
  // source-shape-contract: security -- The temporary credential-bearing Launchable lane must remain manual, trusted-main-only, read-only, and non-cancelling.
  it("keeps the manual workflow read-only and non-cancelling (#9880)", () => {
    const value = workflow();

    expect(value.permissions).toEqual({ contents: "read" });
    expect(value.concurrency).toEqual({
      group: "issue-9880-staging-launchable",
      "cancel-in-progress": false,
    });
    expect(value.jobs?.reproduce?.if).toContain("workflow_dispatch");
    expect(value.jobs?.reproduce?.if).toContain("refs/heads/main");
    expect(value.jobs?.reproduce?.if).toContain("NVIDIA/NemoClaw");
  });

  // source-shape-contract: security -- Step-scoped credentials, trusted workflow checkout, maintainer authorization, and independent cleanup prevent PR code or failed execution from retaining cloud access.
  it("exposes credentials only to their owning steps and removes Brev state (#9880)", () => {
    const value = workflow();
    const checkout = step(value, "Check out trusted reproduction lane");
    const authorize = step(value, "Authorize maintainer dispatch");
    const prepare = step(value, "Prepare Brev CLI and evidence directory");
    const reproduce = step(
      value,
      "Reproduce issue 9880 on the staging Launchable",
    );
    const cleanup = step(value, "Verify workflow-owned workspace cleanup");
    const removeCredentials = step(value, "Remove Brev credentials");

    expect(checkout.env).toBeUndefined();
    expect(checkout.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(String(checkout.with?.["sparse-checkout"])).toContain(
      "tools/e2e/brev-launchable-issue-9880.sh",
    );
    expect(authorize.run).toContain("maintain|admin");
    expect(prepare.env).toEqual(
      expect.objectContaining({
        BREV_API_KEY: "${{ secrets.BREV_API_KEY }}",
        BREV_ORG_ID: "${{ secrets.BREV_ORG_ID }}",
      }),
    );
    expect(prepare.env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    const privateHome = prepare.env?.HOME;
    expect(privateHome).toBe("${{ runner.temp }}/issue-9880-home");
    expect(reproduce.env).toEqual(
      expect.objectContaining({
        BREV_LAUNCHABLE_ID: "${{ vars.NEMOCLAW_STAGING_LAUNCHABLE_ID }}",
        GH_TOKEN: "${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}",
        NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
      }),
    );
    expect(reproduce.env).not.toHaveProperty("BREV_API_KEY");
    expect(reproduce.env?.HOME).toBe(privateHome);
    expect(cleanup.if).toBe(
      "${{ always() && steps.prepare.outputs.work_dir != '' }}",
    );
    expect(cleanup.env?.HOME).toBe(privateHome);
    expect(cleanup.run).toMatch(
      /^tools\/e2e\/brev-launchable-issue-9880[.]sh cleanup-owned-workspace$/,
    );
    expect(removeCredentials.if).toBe("always()");
    expect(removeCredentials.env?.HOME).toBe(privateHome);
    expect(removeCredentials.run).toContain('rm -rf -- "$HOME"');
  });

  // source-shape-contract: security -- The shipped trusted script must bind staging identity before credential exposure, bound every turn, redact evidence, and retain exact-name cleanup.
  it("runs one bounded prompt and always verifies workspace cleanup (#9880)", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'brev create "$INSTANCE_NAME" --launchable "$BREV_LAUNCHABLE_ID"',
    );
    expect(script).toContain("timeout --signal=TERM --kill-after=10s 90s");
    expect(script).toContain(
      "List 10 REST API endpoints for a blog service, one per line",
    );
    expect(script).toContain(
      "openclaw agent --agent main --json --thinking off",
    );
    expect(script).toContain("meta/llama-3.3-70b-instruct");
    expect(script).toContain("for attempt in 1 2 3 4 5");
    expect(script).toContain("cleanup-owned-workspace");
    expect(script).toContain("cleanup could not inspect workspace inventory");
    expect(script).toContain("workspace Brev exec readiness timed out");
    expect(script).toContain("Brev exec access to $INSTANCE_NAME succeeded");
    expect(script).toContain('classification="timeout"');
    expect(script).toContain('brev delete "$INSTANCE_NAME"');
    expect(script).toContain('jq -e --arg run "$producer_run"');
    expect(script).toContain(
      "standing Launchable runtime identity does not match",
    );
    expect(script).toContain("NEMOCLAW_REDACTION_SECRET");
    expect(script.indexOf("trap cleanup_scenario_files EXIT")).toBeLessThan(
      script.indexOf('remote_script="$(mktemp'),
    );
    expect(script.indexOf('redact_file "$raw_log"')).toBeLessThan(
      script.indexOf("trap - EXIT INT TERM"),
    );
    expect(script).not.toContain("--count");
    expect(script).not.toContain("KEEP_ALIVE");
  });

  it.each([
    ["BREV_EXEC_TIMEOUT_SECONDS", "0"],
    ["BREV_EXEC_TIMEOUT_SECONDS", "1+1"],
    ["POLL_SECONDS", "0"],
    ["POLL_SECONDS", "$(touch forbidden)"],
  ])("rejects invalid %s before cloud operations (#9880)", (name, value) => {
    const fixture = issue9880Fixture();
    const result = fixture.run({ [name]: value });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      `${name} must be a positive integer`,
    );
    expect(fs.existsSync(fixture.calls)).toBe(false);
    expect(fs.existsSync(fixture.state)).toBe(false);
  });

  it.each([
    [
      "brev exec",
      /timeout --signal=KILL [12]s brev exec issue-9880-test true/u,
    ],
  ])(
    "bounds a blocked %s operation by the Brev exec deadline (#9880)",
    (blockedCommand, boundedCall) => {
      const fixture = issue9880Fixture();
      const result = fixture.run({
        BREV_EXEC_TIMEOUT_SECONDS: "2",
        FAKE_BLOCK_COMMAND: blockedCommand,
      });

      expect(
        result.status,
        `${result.stdout}\n${result.stderr}\n${fs.readFileSync(fixture.calls, "utf8")}`,
      ).not.toBe(0);
      const calls = fs.readFileSync(fixture.calls, "utf8");
      expect(`${result.stdout}\n${result.stderr}`, calls).toContain(
        "workspace Brev exec readiness timed out",
      );
      expect(calls).toMatch(boundedCall);
    },
    10_000,
  );

  it("removes the credential-bearing remote script after termination (#9880)", async () => {
    const fixture = issue9880Fixture();
    const child = fixture.start({
      BREV_EXEC_TIMEOUT_SECONDS: "2",
      FAKE_EXEC_SUCCEEDS: "1",
      FAKE_SCENARIO_BLOCKS: "1",
      NVIDIA_API_KEY: "nvapi-interrupt-test-secret",
    });
    const remoteFiles = await waitForIssue9880RemoteScript(fixture.root);
    expect(remoteFiles, await childOutputAfterDelay(child)).toHaveLength(1);

    const completed = childCompletion(child);
    process.kill(-child.pid!, "SIGTERM");
    await completed;

    expect(
      fs
        .readdirSync(fixture.root)
        .filter((file) => file.startsWith("issue-9880-remote.")),
    ).toEqual([]);
    expect(
      fs
        .readdirSync(fixture.root)
        .filter((file) => /^issue-9880\.[A-Za-z0-9]+$/u.test(file)),
    ).toEqual([]);
    expect(
      treeContainsLiteral(fixture.root, "nvapi-interrupt-test-secret"),
    ).toBe(false);
  }, 10_000);

  it("removes the raw log when redaction fails (#9880)", () => {
    const fixture = issue9880Fixture();
    fs.mkdirSync(path.join(fixture.workDir, "issue-9880.log"));
    const result = fixture.run({
      FAKE_EXEC_SUCCEEDS: "1",
      FAKE_SCENARIO_SUCCEEDS: "1",
      NVIDIA_API_KEY: "nvapi-redaction-failure-secret",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("IsADirectoryError");
    const calls = fs.readFileSync(fixture.calls, "utf8");
    expect(calls).toContain("brev exec issue-9880-test true");
    expect(calls).toMatch(/brev exec issue-9880-test @.*issue-9880-remote[.]/u);
    expect(
      fs
        .readdirSync(fixture.root)
        .filter((file) => file.startsWith("issue-9880-remote.")),
    ).toEqual([]);
    expect(
      fs
        .readdirSync(fixture.root)
        .filter((file) => /^issue-9880\.[A-Za-z0-9]+$/u.test(file)),
    ).toEqual([]);
    expect(
      treeContainsLiteral(fixture.root, "nvapi-redaction-failure-secret"),
    ).toBe(false);
  });

  it("removes the raw log when remote script setup fails (#9880)", () => {
    const fixture = issue9880Fixture();
    const result = fixture.run({
      FAKE_EXEC_SUCCEEDS: "1",
      FAKE_REMOTE_MKTEMP_FAILS: "1",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Verified standing Launchable runtime identity before credential exposure",
    );
    expect(
      fs
        .readdirSync(fixture.root)
        .filter((file) => file.startsWith("issue-9880-remote.")),
    ).toEqual([]);
    expect(
      fs
        .readdirSync(fixture.root)
        .filter((file) => /^issue-9880\.[A-Za-z0-9]+$/u.test(file)),
    ).toEqual([]);
  });

  it("fails closed when a regular artifact cannot be read (#9880)", () => {
    const fixture = issue9880Fixture();
    const unreadable = path.join(fixture.root, "unreadable-artifact");
    fs.writeFileSync(unreadable, "nvapi-unreadable-secret");
    fs.chmodSync(unreadable, 0o000);

    try {
      expect(() =>
        treeContainsLiteral(fixture.root, "nvapi-unreadable-secret"),
      ).toThrow();
    } finally {
      fs.chmodSync(unreadable, 0o600);
    }
  });

  it("caps poll sleep to the remaining Brev exec deadline (#9880)", () => {
    const fixture = issue9880Fixture();
    const result = fixture.run({
      BREV_EXEC_TIMEOUT_SECONDS: "2",
      POLL_SECONDS: "9",
      FAKE_EXEC_SUCCEEDS: "0",
    });

    expect(result.status).not.toBe(0);
    const calls = fs.readFileSync(fixture.calls, "utf8");
    const readinessStart = calls.search(
      /timeout --signal=KILL [12]s brev exec/u,
    );
    expect(readinessStart, calls).toBeGreaterThanOrEqual(0);
    const readiness = calls.slice(readinessStart);
    expect(readiness).toMatch(
      /timeout --signal=KILL [12]s brev exec issue-9880-test true/u,
    );
    expect(readiness).toMatch(/sleep [12]/u);
    expect(readiness).not.toContain("sleep 9");
    expect(readiness).not.toContain("timeout 0s");
  }, 10_000);
});
