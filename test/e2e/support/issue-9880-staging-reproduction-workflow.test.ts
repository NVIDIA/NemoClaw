// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

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
const SCRIPT_PATH = path.join(REPO_ROOT, "tools/e2e/brev-launchable-issue-9880.sh");

function workflow(): Workflow {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

function step(value: Workflow, name: string): Step {
  const found = value.jobs?.reproduce?.steps?.find((entry) => entry.name === name);
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
    const reproduce = step(value, "Reproduce issue 9880 on the staging Launchable");
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
    expect(cleanup.if).toBe("${{ always() && steps.prepare.outputs.work_dir != '' }}");
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

    expect(script).toContain('brev create "$INSTANCE_NAME" --launchable "$BREV_LAUNCHABLE_ID"');
    expect(script).toContain("timeout --signal=TERM --kill-after=10s 90s");
    expect(script).toContain("List 10 REST API endpoints for a blog service, one per line");
    expect(script).toContain("openclaw agent --agent main --json --thinking off");
    expect(script).toContain("meta/llama-3.3-70b-instruct");
    expect(script).toContain("for attempt in 1 2 3 4 5");
    expect(script).toContain("cleanup-owned-workspace");
    expect(script).toContain("cleanup could not inspect workspace inventory");
    expect(script).toContain("Brev SSH configuration refresh failed");
    expect(script).toContain('classification="timeout"');
    expect(script).toContain('brev delete "$INSTANCE_NAME"');
    expect(script).toContain("standing Launchable runtime identity does not match");
    expect(script).toContain("NEMOCLAW_REDACTION_SECRET");
    expect(script).not.toContain("--count");
    expect(script).not.toContain("KEEP_ALIVE");
  });
});
