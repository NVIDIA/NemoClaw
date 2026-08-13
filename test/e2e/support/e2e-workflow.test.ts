// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
import { readWorkflow, removeJobNeed } from "../../helpers/e2e-workflow-contract";
import { testTimeoutOptions } from "../../helpers/timeouts";
import { assertChannelsStopStartSandboxName } from "../live/channels-stop-start-safety.ts";
import { requireFixture } from "./require-fixture";

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

  it("rejects a Launchable environment gate, authorization drift, and secret-guard drift", () => {
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
    const prepare = job.steps!.find((step) => step.name === "Prepare the trusted lane")!;
    prepare.env!.BREV_API_KEY = "${{ secrets.BREV_API_KEY }}";
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
      ]),
    );
  });

  it("rejects an inverted selected-jobs condition", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { if?: string }>;
    };
    workflow.jobs["hermes-discord"]!.if =
      "${{ !contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'hermes-discord') }}";

    expect(validateE2eWorkflow(workflow)).toContain(
      "hermes-discord job must use the shared jobs selector condition",
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
      jobs: Record<
        string,
        {
          env: Record<string, unknown>;
          steps: Array<{ name?: string; run?: string; with?: Record<string, unknown> }>;
          strategy: {
            "fail-fast": boolean;
            "max-parallel": number;
            matrix: { include: Array<Record<string, string>> };
          };
          "timeout-minutes": number;
        }
      >;
    };
    const job = workflow.jobs["common-egress-agent"]!;
    const source = fs.readFileSync("test/e2e/live/common-egress-agent.test.ts", "utf8");
    expect(source).toContain("const TEST_TIMEOUT_MS = 40 * 60_000;");

    job["timeout-minutes"] = 40;
    job.strategy["fail-fast"] = true;
    job.strategy["max-parallel"] = 3;
    job.strategy.matrix.include.pop();
    job.env.E2E_ARTIFACT_DIR = "${{ github.workspace }}/e2e-artifacts/live/common-egress-agent";
    delete job.env.NEMOCLAW_E2E_SHARD;
    const run = job.steps.find((step) => step.name === "Run common-egress agent live test")!;
    run.run = run.run!.replace('--selector "${{ matrix.selector }}"', "--selector all");
    const upload = job.steps.find((step) => step.name === "Upload common-egress agent artifacts")!;
    delete upload.with;

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "common-egress-agent scenario jobs must keep the 60 minute timeout",
        "common-egress-agent scenario matrix must disable fail-fast",
        "common-egress-agent scenario matrix must cap concurrency at two",
        "common-egress-agent job must keep the three isolated scenario shards",
        "common-egress-agent job must isolate artifacts by matrix.scenario",
        "common-egress-agent job must bind NEMOCLAW_E2E_SHARD to matrix.scenario",
        `step 'Run common-egress agent live test' run script must include --selector "\${{ matrix.selector }}"`,
        "common-egress-agent upload-e2e-artifacts invocation must not override its contract",
        "common-egress-agent upload-e2e-artifacts must preserve its explicit name/path contract",
      ]),
    );
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

  it("rejects Bedrock matrix shard identity drift (#6938)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-bedrock-shard-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<string, { env: Record<string, unknown> }>;
    };
    delete workflow.jobs["bedrock-runtime-compatible-anthropic"].env.NEMOCLAW_E2E_SHARD;
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toContain(
        "bedrock-runtime-compatible-anthropic job must pass matrix.agent through NEMOCLAW_E2E_SHARD",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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

  type RebuildWorkflowStep = {
    env?: Record<string, string>;
    name?: string;
    run?: string;
    uses?: string;
  };
  const rebuildCacheMutations = [
    [
      "an isolated builder",
      {
        name: "Set up rebuild Buildx",
        uses: "docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
      },
    ],
    [
      "a separate cache warm",
      {
        name: "Warm current base build cache",
        uses: "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
      },
    ],
    [
      "a step-level builder selection",
      {
        env: { BUILDX_BUILDER: "external" },
        name: "Run rebuild live test",
      },
    ],
    [
      "a persistent builder selection",
      {
        name: "Select rebuild Buildx",
        run: "docker buildx use external",
      },
    ],
    [
      "a multiline environment-file builder selection",
      {
        name: "Persist rebuild Buildx through the environment file",
        run: "printf '%s\\n' 'BUILDX_BUILDER<<EOF' 'external' 'EOF' >> \"$GITHUB_ENV\"",
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, RebuildWorkflowStep]>;
  const rebuildCacheCases = ["rebuild-hermes", "rebuild-hermes-stale-base"].flatMap((jobName) =>
    rebuildCacheMutations.map(
      ([caseName, injectedStep]) => [jobName, caseName, injectedStep] as const,
    ),
  );

  it.each(rebuildCacheCases)("rejects %s with %s", (jobName, _case, injectedStep) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-cache-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<string, { steps: RebuildWorkflowStep[] }>;
    };
    workflow.jobs[jobName].steps.splice(2, 0, injectedStep);
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toContain(
        `${jobName} must keep rebuild builds on the Docker engine cache`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // source-shape-contract: security -- Mutates the shipped workflow to prove PR-safe routing rejects credential-backed smokes and mutable tunnel tooling
  it("rejects credential-backed provider smokes in the PR-safe inference-routing job", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-inference-routing-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        { steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }> }
      >;
    };
    const run = workflow.jobs["inference-routing"]?.steps?.find(
      (step) => step.name === "Run inference routing live test",
    );
    expect(run).toBeDefined();
    run!.run = "npx vitest run --project e2e-live inference-routing-provider-smoke.test.ts";
    const prerequisite = workflow.jobs["inference-routing"]?.steps?.find(
      (step) => step.name === "Install and verify cloudflared prerequisite",
    );
    expect(prerequisite?.env).toBeDefined();
    prerequisite!.env!.CLOUDFLARED_VERSION = "latest";
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    const digestWorkflowPath = path.join(tmp, "digest-workflow.yaml");
    const digestWorkflow = readWorkflow() as {
      jobs: Record<string, { steps?: Array<{ name?: string; env?: Record<string, string> }> }>;
    };
    const digestPrerequisite = digestWorkflow.jobs["inference-routing"]?.steps?.find(
      (step) => step.name === "Install and verify cloudflared prerequisite",
    );
    expect(digestPrerequisite?.env).toBeDefined();
    digestPrerequisite!.env!.CLOUDFLARED_DEB_SHA256 = "mutable";
    fs.writeFileSync(digestWorkflowPath, YAML.stringify(digestWorkflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "step 'Run inference routing live test' run script must include test/e2e/live/inference-routing.test.ts",
          "step 'Run inference routing live test' run script must not include inference-routing-provider-smoke.test.ts",
          "inference-routing cloudflared prerequisite step must pin CLOUDFLARED_VERSION=2026.6.1",
        ]),
      );
      expect(validateE2eWorkflowBoundary(digestWorkflowPath)).toContain(
        "inference-routing cloudflared prerequisite step must pin CLOUDFLARED_DEB_SHA256=ccd02ec216c62bfa573395d8f72cb2e91e95cbdf8726a8acc06b3e2d9aa31526",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // source-shape-contract: security -- Mutates the shipped workflow to prove artifact uploads reject unmanaged temporary paths
  it("rejects free-standing E2E artifact uploads from raw temp paths", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        {
          steps: Array<{
            name?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
    const upload = workflow.jobs["openclaw-inference-switch"].steps.find(
      (step) => step.name === "Upload OpenClaw inference switch artifacts",
    );
    expect(upload?.with).toEqual(expect.any(Object));
    upload!.with!.path =
      `${String(upload!.with!.path)}\n/tmp/nemoclaw-e2e-openclaw-inference-switch-install.log`;
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toContain(
        "openclaw-inference-switch upload-e2e-artifacts must preserve its explicit name/path contract",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it(
    "evaluates high-risk dispatch selector behavior before secret-bearing jobs run",
    testTimeoutOptions(30_000),
    () => {
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "brave-search,../escape",
        }),
      ).toMatchObject({
        valid: false,
        liveTargetsRun: false,
        selectedFreeStandingJobs: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "brave-search",
          targets: "brave-search",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["brave-search"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "brave-search",
          targets: "ubuntu-repo-cloud-langchain-deepagents-code",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: true,
        selectedFreeStandingJobs: ["brave-search"],
        registryTargets: ["ubuntu-repo-cloud-langchain-deepagents-code"],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "brave-search",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["brave-search"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "brave-search,ubuntu-repo-cloud-openclaw",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: true,
        selectedFreeStandingJobs: ["brave-search"],
        registryTargets: ["ubuntu-repo-cloud-openclaw"],
      });
      for (const [legacy, canonical] of [
        ["hermes-dashboard", "hermes-e2e"],
        ["sandbox-rlimits-connect", "sandbox-operations"],
      ] as const) {
        for (const selectors of [{ jobs: legacy }, { targets: legacy }]) {
          expect(evaluateE2eWorkflowDispatchSelectors(selectors)).toMatchObject({
            valid: true,
            liveTargetsRun: false,
            selectedFreeStandingJobs: [canonical],
            registryTargets: [],
          });
        }
      }
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

  it("rejects malformed free-standing workflow metadata before matrix generation", {
    timeout: 60_000,
  }, () => {
    const malformedWorkflows = [
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
    ];

    for (const { body, error } of malformedWorkflows) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-bad-workflow-"));
      const workflowPath = path.join(tmp, "workflow.yaml");
      try {
        fs.writeFileSync(workflowPath, body);
        expect(validateFreeStandingWorkflowInventory(workflowPath)).toContain(error);
        expect(() => readFreeStandingJobsInventory(workflowPath)).toThrow(error);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

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

      for (const job of inventory.allowedJobs) {
        expect(evaluateE2eWorkflowDispatchSelectors({ jobs: job })).toMatchObject({
          valid: true,
          liveTargetsRun: false,
          selectedFreeStandingJobs: [job],
          registryTargets: [],
        });
      }
      for (const target of inventory.targetToJob.keys()) {
        expect(evaluateE2eWorkflowDispatchSelectors({ targets: target })).toMatchObject({
          valid: true,
          liveTargetsRun: false,
          selectedFreeStandingJobs: [target],
          registryTargets: [],
        });
      }
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

  // source-shape-contract: security -- Mutates the shipped workflow to prove channel lifecycle secrets and artifacts fail closed
  it("rejects channels stop/start workflow-boundary drift for secret and artifact handling", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        {
          env: Record<string, unknown>;
          steps: Array<Record<string, unknown>>;
          strategy: { matrix: { agent: string[] }; "fail-fast": boolean };
          "timeout-minutes"?: number;
        }
      >;
    };
    const job = workflow.jobs["channels-stop-start"];
    expect(job).toBeDefined();
    job["timeout-minutes"] = 45;
    job.strategy["fail-fast"] = true;
    job.strategy.matrix.agent = ["openclaw"];
    job.env.NEMOCLAW_SANDBOX_NAME = "personal-dev-${{ matrix.agent }}";
    job.env.DOCKER_CONFIG = "${{ github.workspace }}/.docker-config-shared";
    job.env.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";
    const checkoutStep = job.steps.find(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
    );
    expect(checkoutStep).toBeDefined();
    checkoutStep!.with = {
      ...(checkoutStep!.with as Record<string, unknown>),
      "persist-credentials": true,
    };

    const installOpenShellStep = job.steps.find((step) => step.name === "Install OpenShell");
    expect(installOpenShellStep).toBeDefined();
    installOpenShellStep!.run = "bash scripts/install-openshell.sh";

    const runStep = job.steps.find((step) => step.name === "Run channels stop/start live test");
    expect(runStep).toBeDefined();
    runStep!.env = {
      TELEGRAM_BOT_TOKEN: "real-token",
    };
    runStep!.run = String(runStep!.run).replace(
      "test/e2e/live/channels-stop-start.test.ts",
      "test/e2e/live/channels-add-remove.test.ts",
    );

    const uploadStep = job.steps.find(
      (step) => step.name === "Upload channels stop/start artifacts",
    );
    expect(uploadStep).toBeDefined();
    uploadStep!.uses = "actions/upload-artifact@v4";
    uploadStep!.with = {
      ...(uploadStep!.with as Record<string, unknown>),
      name: "channels-stop-start",
      path: "e2e-artifacts/live/channels-stop-start/",
      "include-hidden-files": true,
      "retention-days": 1,
    };

    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      const errors = validateE2eWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "channels-stop-start job must keep the 90 minute timeout",
          "channels-stop-start strategy.fail-fast must be false",
          "channels-stop-start matrix must bind canonical per-agent sandbox names",
          "channels-stop-start job must derive NEMOCLAW_SANDBOX_NAME from matrix.sandbox_name",
          "channels-stop-start job must not include DOCKER_CONFIG",
          "channels-stop-start job env must not include NVIDIA_INFERENCE_API_KEY",
          "channels-stop-start checkout step must set persist-credentials=false",
          "step 'Install OpenShell' run script must include env -u DOCKER_CONFIG",
          "channels-stop-start step must receive NVIDIA_INFERENCE_API_KEY from secrets",
          "channels-stop-start step must set the fake Telegram token",
          "step 'Run channels stop/start live test' run script must include test/e2e/live/channels-stop-start.test.ts",
          "channels-stop-start must not invoke actions/upload-artifact directly",
          "channels-stop-start must use upload-e2e-artifacts exactly once",
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
