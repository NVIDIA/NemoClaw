// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  evaluateE2eWorkflowDispatchSelectors,
  evaluateStagingBrevLaunchableDispatch,
  focusedE2eJobsForChangedFiles,
  readFreeStandingJobsInventory,
  validateE2eWorkflow,
  validateE2eWorkflowBoundary,
  validateFreeStandingWorkflowInventory,
} from "../../../tools/e2e/workflow-boundary.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import {
  catalogueTarget,
  E2E_TARGET_CATALOGUE,
  validateE2eTargetCatalogue,
} from "../../../tools/e2e/target-catalogue.mts";
import { readWorkflow, removeJobNeed } from "../../helpers/e2e-workflow-contract";
import { testTimeoutOptions } from "../../helpers/timeouts";
import { assertChannelsStopStartSandboxName } from "../live/channels-stop-start-safety.ts";
import { COMMON_EGRESS_TEST_TIMEOUT_MS } from "../live/common-egress-agent-helpers.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { requireFixture } from "./require-fixture";

function runReleaseWaiverAuthorization(
  overrides: Record<string, string> = {},
): ReturnType<typeof spawnSync> & { permissionChecks: string[] } {
  const workflow = readWorkflow() as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const script = workflow.jobs["generate-matrix"]!.steps!.find(
    (step) => step.name === "Authorize release qualification waiver",
  )!.run!;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-release-waiver-auth-"));
  const curlLog = path.join(fixture, "curl.log");
  const curlPath = path.join(fixture, "curl");
  fs.writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
administrator="\${url%/permission}"
administrator="\${administrator##*/}"
output_file=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "--output" ]]; then output_file="$argument"; fi
  previous="$argument"
done
printf '%s\n' "$administrator" >>"$CURL_LOG"
case "$administrator" in
  maintainer) role=maintain ;;
  mismatch) login=different-user; role=admin ;;
  *) role=admin ;;
esac
login="\${login:-$administrator}"
printf -v body '{"user":{"login":"%s"},"role_name":"%s"}' "$login" "$role"
if [[ -n "$output_file" ]]; then printf '%s' "$body" >"$output_file"; printf '200'; else printf '%s' "$body"; fi
`,
  );
  fs.chmodSync(curlPath, 0o755);
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture}:${process.env.PATH ?? ""}`,
      ACTOR: "dispatch-admin",
      ALLOW_DGX_SPARK_RUNNER_QUEUE: "false",
      ALLOW_JETSON_DISPATCH: "false",
      CHECKOUT_SHA: "",
      CURL_LOG: curlLog,
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      GITHUB_TOKEN: "test-token",
      INCLUDE_LAUNCHABLE: "true",
      JOBS: "",
      TARGETS: "",
      TRIGGERING_ACTOR: "rerun-admin",
      WAIVED_JOBS: "staging-brev-launchable",
      WAIVER_REASON: "Brev's credential expired",
      WORKFLOW_REF: "refs/heads/main",
      ...overrides,
    },
  });
  const permissionChecks = fs.existsSync(curlLog)
    ? fs.readFileSync(curlLog, "utf8").trim().split("\n")
    : [];
  fs.rmSync(fixture, { force: true, recursive: true });
  return Object.assign(result, { permissionChecks });
}

function expectCatalogueOwningPathsToExist(): void {
  for (const target of E2E_TARGET_CATALOGUE) {
    for (const owner of target.owningPaths) {
      expect(fs.existsSync(path.join(REPO_ROOT, owner)), `${target.id}: ${owner}`).toBe(true);
    }
  }
}

describe("e2e workflow boundary", () => {
  it("guards channels-stop-start destructive cleanup to test-owned sandboxes", () => {
    expect(() => assertChannelsStopStartSandboxName("personal-dev", "openclaw")).toThrow(
      /only accepts openclaw sandbox names with prefix e2e-oc-ch-/,
    );
    expect(() => assertChannelsStopStartSandboxName("e2e-oc-ch-cycle", "openclaw")).not.toThrow();
    expect(() => assertChannelsStopStartSandboxName("e2e-hm-ch-cycle", "hermes")).not.toThrow();
    expect(() => assertChannelsStopStartSandboxName("e2e-hm-ch-cycle", "openclaw")).toThrow(
      /only accepts openclaw sandbox names with prefix e2e-oc-ch-/,
    );
  });

  it(
    "keeps the E2E workflow push-driven, dispatchable, pinned, and artifact-safe",
    testTimeoutOptions(30_000),
    () => expect(validateE2eWorkflowBoundary()).toEqual([]),
  );

  it("rejects a Launchable environment gate, authorization drift, and credential boundary drift", () => {
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        {
          if?: string;
          environment?: Record<string, unknown>;
          steps?: Array<{
            env?: Record<string, string>;
            name?: string;
            run?: string;
            uses?: string;
          }>;
        }
      >;
    };
    const job = workflow.jobs["staging-brev-launchable"]!;
    job.environment = { name: "unprotected" };
    (job as { env?: Record<string, string> }).env!.BREV_API_KEY = "${{ secrets.BREV_API_KEY }}";
    const prepare = job.steps!.find((step) => step.name === "Prepare the trusted lane")!;
    prepare.env!.BREV_API_KEY = "${{ secrets.BREV_API_KEY }}";
    prepare.env!.BREV_CLI_SHA256 = "latest";
    const run = job.steps!.find(
      (step) => step.name === "Build, deploy, verify, test, and clean up",
    )!;
    run.env!.GH_TOKEN = "${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}";
    run.env!.BREV_LAUNCHABLE_ID = "env-hardcoded";
    run.env!.NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY = "1";
    const generateSteps = workflow.jobs["generate-matrix"]!.steps!;
    const authorization = generateSteps.find(
      (step) => step.name === "Authorize Launchable E2E maintainer dispatch",
    )!;
    delete authorization.env!.TRIGGERING_ACTOR;
    authorization.run = authorization.run!.replace("maintain | admin", "write");
    generateSteps.push(...generateSteps.splice(generateSteps.indexOf(authorization), 1));

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "staging-brev-launchable must not use a GitHub environment",
        "Launchable E2E maintainer authorization must bind TRIGGERING_ACTOR",
        "step 'Authorize Launchable E2E maintainer dispatch' run script must include maintain | admin",
        "Launchable E2E maintainer authorization must run before generate-matrix checkout",
        "staging-brev-launchable BREV_API_KEY must use the trusted-run secret guard",
        "staging-brev-launchable GH_TOKEN must use the trusted-run secret guard",
        "staging-brev-launchable must read the repository Launchable ID variable",
        "staging-brev-launchable must not stop after image publication",
        "staging-brev-launchable job must not receive BREV_API_KEY",
        "staging-brev-launchable must pin the Brev CLI version and SHA-256 checksum",
      ]),
    );
  });

  it("rejects release qualification waiver authorization and planner drift", () => {
    const workflow = readWorkflow() as {
      on: {
        workflow_dispatch: {
          inputs: Record<string, { default?: string; description?: string; type?: string }>;
        };
      };
      jobs: Record<
        string,
        {
          outputs?: Record<string, string>;
          steps?: Array<{
            env?: Record<string, string>;
            name?: string;
            run?: string;
          }>;
        }
      >;
    };
    workflow.on.workflow_dispatch.inputs.release_qualification_waived_jobs.default =
      "staging-brev-launchable";
    const steps = workflow.jobs["generate-matrix"]!.steps!;
    const authorization = steps.find(
      (step) => step.name === "Authorize release qualification waiver",
    )!;
    delete authorization.env!.TRIGGERING_ACTOR;
    authorization.run = authorization.run!.replace('== "admin"', '== "maintain"');
    const matrix = steps.find((step) => step.name === "Generate E2E target matrix")!;
    delete matrix.env!.RELEASE_QUALIFICATION_WAIVED_JOBS;
    delete workflow.jobs["generate-matrix"]!.outputs!.release_qualification_waived_jobs;

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "workflow_dispatch release_qualification_waived_jobs input must be a string and default to empty",
        "release qualification waiver authorization must bind only trusted identity and release-run inputs",
        "step 'Authorize release qualification waiver' run script must include == \"admin\"",
        "matrix generation step must pass release qualification waived jobs through env",
        "generate-matrix job must expose release_qualification_waived_jobs output",
      ]),
    );
  });

  it("authorizes both administrator identities and accepts an apostrophe in the reason", () => {
    const result = runReleaseWaiverAuthorization();

    expect(result.status).toBe(0);
    expect(result.permissionChecks).toEqual(["dispatch-admin", "rerun-admin"]);
  });

  it.each([
    ["dispatch actor", { ACTOR: "maintainer" }, "requires a repository administrator"],
    ["rerun actor", { TRIGGERING_ACTOR: "maintainer" }, "requires a repository administrator"],
    ["permission identity", { ACTOR: "mismatch" }, "did not match the actor"],
  ])("rejects an invalid %s", (_case, overrides, error) => {
    const result = runReleaseWaiverAuthorization(overrides);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });

  it.each([
    ["candidate checkout", { CHECKOUT_SHA: "a".repeat(40) }],
    ["non-main workflow ref", { WORKFLOW_REF: "refs/heads/release" }],
    ["job selector", { JOBS: "live" }],
    ["target selector", { TARGETS: "cloud-onboard" }],
    ["missing Launchable", { INCLUDE_LAUNCHABLE: "false" }],
    ["Jetson override", { ALLOW_JETSON_DISPATCH: "true" }],
    ["DGX override", { ALLOW_DGX_SPARK_RUNNER_QUEUE: "true" }],
  ])("rejects a release waiver with %s", (_case, overrides) => {
    expect(runReleaseWaiverAuthorization(overrides).status).not.toBe(0);
  });

  it.each([
    ["reason only", { WAIVED_JOBS: "" }],
    ["jobs only", { WAIVER_REASON: "" }],
    ["short reason", { WAIVER_REASON: "too short" }],
    ["long reason", { WAIVER_REASON: `A${"x".repeat(500)}` }],
    ["unsupported reason character", { WAIVER_REASON: "Brev key expired & rotated" }],
  ])("rejects invalid paired waiver input: %s", (_case, overrides) => {
    expect(runReleaseWaiverAuthorization(overrides).status).not.toBe(0);
  });

  it("rejects an inverted selected-jobs condition", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { if?: string }>;
    };
    workflow.jobs["catalogue-standard"]!.if =
      "${{ needs.generate-matrix.outputs.catalogue_standard_matrix == '[]' }}";

    expect(validateE2eWorkflow(workflow)).toContain(
      "catalogue-standard must use its generated catalogue matrix",
    );
  });

  it("selects Launchable E2E only for trusted manual dispatches (#7487)", () => {
    expect(
      evaluateStagingBrevLaunchableDispatch({
        eventName: "workflow_dispatch",
      }),
    ).toEqual({ runLaunchableE2e: false });
    expect(
      evaluateStagingBrevLaunchableDispatch({
        eventName: "workflow_dispatch",
        includeStagingBrevLaunchable: true,
      }),
    ).toEqual({ runLaunchableE2e: true });
    expect(
      evaluateStagingBrevLaunchableDispatch({
        eventName: "workflow_dispatch",
        includeStagingBrevLaunchable: true,
        jobs: "hermes-e2e",
      }),
    ).toEqual({ runLaunchableE2e: false });
    expect(
      evaluateStagingBrevLaunchableDispatch({
        eventName: "workflow_dispatch",
        includeStagingBrevLaunchable: true,
        targets: "cloud-onboard",
      }),
    ).toEqual({ runLaunchableE2e: false });
    expect(
      evaluateStagingBrevLaunchableDispatch({
        eventName: "workflow_dispatch",
        jobs: "staging-brev-launchable",
      }),
    ).toEqual({ runLaunchableE2e: true });
    expect(
      evaluateStagingBrevLaunchableDispatch({
        eventName: "workflow_dispatch",
        jobs: "staging-brev-launchable",
        targets: "cloud-onboard",
      }),
    ).toEqual({ runLaunchableE2e: false });
    expect(
      evaluateStagingBrevLaunchableDispatch({
        eventName: "workflow_dispatch",
        jobs: "staging-brev-launchable,hermes-e2e",
      }),
    ).toEqual({ runLaunchableE2e: false });
    expect(
      evaluateStagingBrevLaunchableDispatch({
        eventName: "push",
      }),
    ).toEqual({ runLaunchableE2e: false });
    expect(
      evaluateStagingBrevLaunchableDispatch({
        eventName: "workflow_dispatch",
        includeStagingBrevLaunchable: true,
        trustedMain: false,
      }),
    ).toEqual({ runLaunchableE2e: false });
  });

  it("rejects a full dispatch with changed input, correlation, or selector contracts (#7487)", () => {
    const workflow = readWorkflow() as {
      "run-name": string;
      on: {
        workflow_dispatch: {
          inputs: Record<string, { default?: boolean; description?: string; type?: string }>;
        };
      };
      jobs: Record<
        string,
        {
          if?: string;
          steps?: Array<{ env?: Record<string, string>; name?: string; run?: string }>;
        }
      >;
    };
    workflow["run-name"] = "E2E";
    workflow.on.workflow_dispatch.inputs.include_staging_brev_launchable.default = true;
    workflow.jobs["staging-brev-launchable"]!.if = "${{ github.event_name == 'push' }}";
    workflow.jobs["staging-brev-launchable-readiness"] = {};

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "workflow run-name must expose the unique manual-dispatch correlation ID",
        "workflow_dispatch include_staging_brev_launchable input must be boolean and default to false",
        "workflow must not define superseded staging-brev-launchable-readiness job",
        "staging-brev-launchable must retain trusted manual selection",
      ]),
    );
  });

  it("rejects superseding full-dispatch and Launchable E2E concurrency drift (#7487)", () => {
    const workflow = readWorkflow() as {
      concurrency: Record<string, unknown>;
      jobs: Record<string, { concurrency?: Record<string, unknown> }>;
    };
    workflow.concurrency.group =
      "e2e-${{ github.ref }}-${{ inputs.checkout_sha != '' && format('pr-{0}', inputs.pr_number) || inputs.targets || 'supported' }}-${{ inputs.checkout_sha != '' && 'pr-gate' || inputs.jobs || 'all-jobs' }}";
    workflow.concurrency["cancel-in-progress"] = "${{ inputs.checkout_sha != '' }}";
    delete workflow.jobs["staging-brev-launchable"]!.concurrency!.queue;

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "workflow concurrency must isolate each full dispatch with github.run_id",
        "workflow concurrency must not cancel an active Jetson dispatch",
        "staging-brev-launchable concurrency must queue all pending Launchable E2E runs without cancellation",
      ]),
    );
  });

  it("keeps common-egress scenarios isolated with bounded concurrency and cleanup reserve", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { strategy: { "max-parallel"?: number } }>;
    };
    const job = workflow.jobs["catalogue-brave-nvidia-inference"]!;
    expect(COMMON_EGRESS_TEST_TIMEOUT_MS).toBeLessThan(
      catalogueTarget("common-egress-agent-openclaw-balanced-weather").timeoutMinutes * 60_000,
    );
    expect(
      [
        "common-egress-agent-openclaw-balanced-weather",
        "common-egress-agent-openclaw-open-reference",
        "common-egress-agent-hermes-open-reference",
      ].map((id) => {
        const target = catalogueTarget(id);
        return { selector: target.selector, shard: target.shard, timeout: target.timeoutMinutes };
      }),
    ).toEqual([
      { selector: "^common-egress.+C1.+$", shard: "openclaw-balanced-weather", timeout: 60 },
      { selector: "^common-egress.+C2.+$", shard: "openclaw-open-reference", timeout: 60 },
      { selector: "^common-egress.+C3.+$", shard: "hermes-open-reference", timeout: 60 },
    ]);
    job.strategy["max-parallel"] = 3;

    expect(validateE2eWorkflow(workflow)).toContain(
      "catalogue-brave-nvidia-inference must cap matrix concurrency at 2",
    );

    const personal = catalogueTarget("common-egress-agent-openclaw-personal-stock-price");
    expect(personal).toMatchObject({
      profile: "nvidia-inference",
      runnerComparison: false,
      selector: "^common-egress.+C4.+$",
      shard: "openclaw-personal-stock-price",
      environment: {
        BRAVE_API_KEY: "",
        NEMOCLAW_WEB_SEARCH_ENABLED: "0",
        NEMOCLAW_WEB_SEARCH_PROVIDER: "none",
        TAVILY_API_KEY: "",
      },
      owningPaths: expect.arrayContaining([
        "nemoclaw-blueprint/policies/presets/personal-open-internet.yaml",
        "nemoclaw-blueprint/policies/tiers.yaml",
        "src/lib/onboard/policy-selection.ts",
        "src/lib/onboard/policy-tier-suppression.ts",
        "src/lib/policy/index.ts",
        "test/e2e/live/openclaw-agent-assertion.ts",
        "test/e2e/live/personal-egress-live-proof.ts",
      ]),
    });
    expect(
      buildE2eWorkflowPlan({ targets: personal.id }).catalogueMatrices["nvidia-inference"].map(
        ({ id }) => id,
      ),
    ).toEqual([personal.id]);
  });

  it("binds typed-target evidence identity and upload to the live matrix entry", () => {
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        {
          env?: Record<string, string>;
          steps?: Array<{
            env?: Record<string, string>;
            name?: string;
            with?: Record<string, string>;
          }>;
        }
      >;
    };
    const live = workflow.jobs.live!;
    const run = live.steps!.find((step) => step.name === "Run live E2E tests")!;
    run.env!.E2E_TARGET_ID = "unbound-target";
    const upload = live.steps!.find((step) => step.name === "Upload E2E artifacts")!;
    upload.with!.path = upload.with!.path.replace("e2e-artifacts/live/risk-signal.json\n", "");

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "live E2E step must bind risk-signal identity to matrix.id",
        "artifact upload path must include e2e-artifacts/live/risk-signal.json",
      ]),
    );
  });

  it("requires matrix generation to use the planner CI-output mode", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const generate = workflow.jobs["generate-matrix"]?.steps?.find(
      (step) => step.name === "Generate E2E target matrix",
    );
    const generateRun =
      generate?.run ??
      (() => {
        throw new Error("workflow missing Generate E2E target matrix script");
      })();
    requireFixture(generateRun.includes("--ci-output"), "planner fixture missing --ci-output");
    const invalidRun = generateRun.replace("--ci-output", "--plain-output");
    requireFixture(invalidRun !== generateRun, "planner fixture mutation did not apply");
    generate!.run = invalidRun;

    expect(validateE2eWorkflow(workflow)).toContain(
      "step 'Generate E2E target matrix' run script must include --ci-output",
    );
  });

  it("includes deleted owning paths in main-push selection", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const generate = workflow.jobs["generate-matrix"]?.steps?.find(
      (step) => step.name === "Generate E2E target matrix",
    )!;

    requireFixture(
      generate.run?.includes("git diff --name-only --diff-filter=ACMRD") ?? false,
      "main-push planner fixture must include deleted paths",
    );
    generate.run = generate.run!.replace("--diff-filter=ACMRD", "--diff-filter=ACMR");
    expect(validateE2eWorkflow(workflow)).toContain(
      "step 'Generate E2E target matrix' run script must include git diff --name-only --diff-filter=ACMRD",
    );
    expect(
      buildE2eWorkflowPlan(
        {},
        { changedFiles: ["test/e2e/live/snapshot-commands.test.ts"] },
      ).catalogueMatrices.standard.map((row) => row.id),
    ).toEqual(["snapshot-commands"]);
  });

  it("keeps orchestration jobs within bounded timeouts", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { "timeout-minutes"?: number }>;
    };
    workflow.jobs["generate-matrix"]!["timeout-minutes"] = 11;
    delete workflow.jobs["report-to-pr"]!["timeout-minutes"];
    workflow.jobs.scorecard!["timeout-minutes"] = 16;

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "generate-matrix job must keep the 10 minute timeout",
        "report-to-pr job must keep the 15 minute timeout",
        "scorecard job must keep the 15 minute timeout",
      ]),
    );
  });

  it("keeps controller target selection bound to the generated matrix (#7031)", () => {
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        { steps?: Array<{ env?: Record<string, string>; name?: string; run?: string }> }
      >;
    };
    const generate = workflow.jobs["generate-matrix"]?.steps?.find(
      (step) => step.name === "Generate E2E target matrix",
    )!;
    delete generate.env!.CHECKOUT_SHA;
    generate.run = generate.run!.replace(
      "E2E planner matrix does not match controller-selected targets",
      "unchecked planner matrix",
    );

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "matrix generation step must bind controller checkout through CHECKOUT_SHA env",
        "step 'Generate E2E target matrix' run script must include E2E planner matrix does not match controller-selected targets",
      ]),
    );
  });

  it("keeps controller runner selection in a trusted pre-checkout matrix (#7031)", () => {
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        {
          outputs: Record<string, string>;
          steps: Array<{ id?: string; name?: string; run?: string; uses?: string }>;
        }
      >;
    };
    const generateMatrix = workflow.jobs["generate-matrix"]!;
    generateMatrix.outputs.matrix = "${{ steps.controller_matrix.outputs.matrix }}";
    const [trusted] = generateMatrix.steps.splice(
      generateMatrix.steps.findIndex((step) => step.id === "controller_matrix"),
      1,
    );
    trusted!.run = trusted!.run!.replace('"runner":"ubuntu-latest"', '"runner":"self-hosted"');
    generateMatrix.steps.splice(
      generateMatrix.steps.findIndex((step) => step.uses?.startsWith("actions/checkout@")) + 1,
      0,
      trusted!,
    );

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "generate-matrix job must expose trusted controller matrix output",
        "trusted controller matrix must pin typed target runner to ubuntu-latest",
        "trusted controller matrix step must run before PR checkout",
      ]),
    );
  });

  it.each([
    { scenario: "credential-backed profile" },
    { scenario: "provider smoke test" },
    { scenario: "cloudflared disabled" },
  ])(
    "rejects credential-backed provider smokes in the PR-safe inference-routing target [$scenario]",
    ({ scenario }) => {
      const target = catalogueTarget("inference-routing");

      const mutation = (
        {
          "credential-backed profile": { ...target, profile: "nvidia-inference" as const },
          "provider smoke test": {
            ...target,
            testFile: "test/e2e/live/inference-routing-provider-smoke.test.ts",
          },
          "cloudflared disabled": { ...target, cloudflared: false },
        } as const
      )[scenario]!;
      expect(() => validateE2eTargetCatalogue([mutation])).toThrow(
        "E2E target inference-routing must remain credential-free with reviewed cloudflared",
      );
    },
  );

  it("keeps every catalogue owning path bound to a repository file or directory", () => {
    expectCatalogueOwningPathsToExist();
  });

  it.each(
    Array.from([["hermes-dashboard", "hermes-e2e"]] as const, ([legacy, canonical]) => ({
      legacy,
      canonical,
    })),
  )(
    "evaluates $canonical dispatch selector behavior before secret-bearing jobs run",
    testTimeoutOptions(30_000),
    ({ legacy, canonical }) => {
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "brave-search,../escape",
        }),
      ).toMatchObject({
        valid: false,
        liveTargetsRun: false,
        selectedFreeStandingJobs: [],
      });
      const bravePlan = buildE2eWorkflowPlan({ targets: "brave-search" });
      expect(bravePlan.catalogueMatrices["brave-nvidia-inference"]).toEqual([
        expect.objectContaining({ id: "brave-search" }),
      ]);
      expect(bravePlan.matrix).toEqual([]);
      expect(bravePlan.selectedJobs).toEqual([]);
      const mixedPlan = buildE2eWorkflowPlan({
        targets: "brave-search,ubuntu-repo-cloud-openclaw",
      });
      expect(mixedPlan.catalogueMatrices["brave-nvidia-inference"]).toHaveLength(1);
      expect(mixedPlan.matrix.map(({ id }) => id)).toEqual(["ubuntu-repo-cloud-openclaw"]);

      [{ jobs: legacy }, { targets: legacy }].forEach((selectors) => {
        expect(evaluateE2eWorkflowDispatchSelectors(selectors)).toMatchObject({
          valid: true,
          liveTargetsRun: false,
          selectedFreeStandingJobs: [canonical],
          registryTargets: [],
        });
      });
    },
  );

  it("maps a credential-free target selector to shared-e2e and its test row", () => {
    expect(
      evaluateE2eWorkflowDispatchSelectors({
        targets: "vllm-docker-storage",
      }),
    ).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["vllm-docker-storage"],
      registryTargets: [],
    });
    expect(buildE2eWorkflowPlan({ targets: "vllm-docker-storage" })).toMatchObject({
      matrix: [],
      testMatrix: [
        {
          id: "vllm-docker-storage",
          file: "test/vllm-docker-storage.test.ts",
          project: "integration",
        },
      ],
      selectedJobs: ["shared-e2e"],
    });
  });

  it.each([
    {
      body: `
jobs:
  fixture-version-check:
    env:
      E2E_JOB: "yes"
      E2E_TARGET_ID: fixture-version-check
`,
      error: 'fixture-version-check job E2E_JOB must be "1"',
    },
    {
      body: `
jobs:
  fixture-version-check:
    env:
      E2E_TARGET_ID: fixture-version-check
`,
      error: "fixture-version-check job E2E_TARGET_ID requires E2E_JOB",
    },
    {
      body: `
jobs:
  fixture-version-check:
    env:
      E2E_JOB: "1"
      E2E_TARGET_ID: "bad:target"
`,
      error: "fixture-version-check job E2E_TARGET_ID must be a selector id",
    },
    {
      body: `
jobs:
  resource-heavy:
    env:
      E2E_JOB: "1"
      E2E_DEFAULT_ENABLED: "yes"
      E2E_TARGET_ID: resource-heavy
`,
      error: 'resource-heavy job E2E_DEFAULT_ENABLED must be "0" when set',
    },
    {
      body: `
jobs:
  first:
    env:
      E2E_JOB: "1"
      E2E_TARGET_ID: duplicate-target
  second:
    env:
      E2E_JOB: "1"
      E2E_TARGET_ID: duplicate-target
`,
      error: "free-standing workflow metadata repeats target id: duplicate-target",
    },
  ])(
    "rejects malformed free-standing workflow metadata before matrix generation [case %#]",
    {
      timeout: 60_000,
    },
    ({ body, error }) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-bad-workflow-"));
      const workflowPath = path.join(tmp, "workflow.yaml");
      try {
        fs.writeFileSync(workflowPath, body);
        expect(validateFreeStandingWorkflowInventory(workflowPath)).toContain(error);
        expect(() => readFreeStandingJobsInventory(workflowPath)).toThrow(error);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it(
    "keeps each free-standing selector out of the registry matrix",
    testTimeoutOptions(420_000),
    () => {
      const hermesSelector = "hermes-e2e";
      const inventory = readFreeStandingJobsInventory();
      const nonHermesJobs = inventory.allowedJobs.filter((job) => job !== hermesSelector);
      const nonHermesTargets = [...inventory.targetToJob.keys()].filter(
        (target) => target !== hermesSelector,
      );

      expect(nonHermesJobs).not.toHaveLength(0);
      expect(nonHermesTargets).not.toHaveLength(0);
      expect(inventory.allowedJobs).toContain(hermesSelector);
      expect(inventory.targetToJob.get(hermesSelector)).toBe(hermesSelector);

      expect(evaluateE2eWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toEqual(
        inventory.allowedJobs.filter((job) => !inventory.explicitOnlyJobs.includes(job)).sort(),
      );

      expect(buildE2eWorkflowPlan({ jobs: nonHermesJobs.join(",") })).toMatchObject({
        hermesSelected: false,
        matrix: [],
      });
      expect(buildE2eWorkflowPlan({ jobs: hermesSelector })).toMatchObject({
        hermesSelected: true,
        matrix: [],
      });
      expect(buildE2eWorkflowPlan({ targets: nonHermesTargets.join(",") })).toMatchObject({
        hermesSelected: false,
        matrix: [],
      });
      expect(buildE2eWorkflowPlan({ targets: hermesSelector })).toMatchObject({
        hermesSelected: true,
        matrix: [],
      });

      inventory.allowedJobs.forEach((job) => {
        expect(evaluateE2eWorkflowDispatchSelectors({ jobs: job })).toMatchObject({
          valid: true,
          liveTargetsRun: false,
          selectedFreeStandingJobs: [job],
          registryTargets: [],
        });
      });
      [...inventory.targetToJob.keys()].forEach((target) => {
        expect(evaluateE2eWorkflowDispatchSelectors({ targets: target })).toMatchObject({
          valid: true,
          liveTargetsRun: false,
          selectedFreeStandingJobs: [target],
          registryTargets: [],
        });
      });
    },
  );

  it("applies boundary checks to newly marked free-standing jobs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<string, Record<string, unknown>>;
    };
    workflow.jobs["ad-hoc-derived"] = {
      "runs-on": "ubuntu-latest",
      needs: "live",
      if: "${{ inputs.targets != '' }}",
      env: {
        E2E_JOB: "1",
        E2E_TARGET_ID: "ad-hoc-derived",
        NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      },
      steps: [
        { uses: "actions/checkout@v4" },
        {
          name: "Run ad hoc",
          run: "echo ${{ inputs.jobs }} && echo ${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
        },
      ],
    };
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "ad-hoc-derived job must depend on generate-matrix",
          "ad-hoc-derived job must use the shared jobs selector condition",
          "ad-hoc-derived job env must not include NVIDIA_INFERENCE_API_KEY",
          "ad-hoc-derived step 'actions/checkout@v4' action must be pinned to a full commit SHA",
          "step 'Run ad hoc' run script must not interpolate dispatch inputs directly",
          "ad-hoc-derived step 'Run ad hoc' run script must not interpolate secrets directly",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects matrix generation that bypasses the planner CI-output mode", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e.yaml"),
      "utf8",
    );
    requireFixture(workflow.includes("--ci-output"), "workflow fixture missing --ci-output");
    const invalidWorkflow = workflow.replace("--ci-output", "--plain-output");
    requireFixture(invalidWorkflow !== workflow, "workflow fixture mutation did not apply");
    fs.writeFileSync(workflowPath, invalidWorkflow);

    try {
      const errors = validateE2eWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "step 'Generate E2E target matrix' run script must include --ci-output",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
