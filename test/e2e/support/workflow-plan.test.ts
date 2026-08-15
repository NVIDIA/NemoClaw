// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { discoverCredentialFreeTests } from "../../../tools/e2e/credential-free-tests.mts";
import { RETIRED_CONTROLLER_SELECTOR_IDS } from "../../../tools/e2e/retired-selector-compatibility.mts";
import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
  E2E_TARGET_CATALOGUE,
  isPrCandidateCatalogueTarget,
  validateE2eTargetCatalogue,
} from "../../../tools/e2e/target-catalogue.mts";
import { readFreeStandingJobsInventory } from "../../../tools/e2e/workflow-boundary.mts";
import {
  buildE2eWorkflowPlan,
  releaseRequiredWorkflowJobs,
  parseReleaseQualificationWaivedJobs,
  renderE2eWorkflowPlanSummary,
  runE2eWorkflowPlanCli,
  selectedWorkflowJobs,
  validateE2eWorkflowPlan,
  writeE2eWorkflowPlanCiOutput,
} from "../../../tools/e2e/workflow-plan.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { buildLiveTargetMatrix } from "../registry/run.ts";

const PLANNER_CLI = path.join(REPO_ROOT, "tools", "e2e", "workflow-plan.mts");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

function firstId<T extends { id: string }>(rows: readonly T[], label: string): string {
  expect(rows, `expected at least one ${label}`).not.toHaveLength(0);
  return rows[0]!.id;
}

function retiredControllerSelectorIds(): string[] {
  const allowedJobs = new Set(readFreeStandingJobsInventory().allowedJobs);
  const retiredIds = RETIRED_CONTROLLER_SELECTOR_IDS.filter((id) => !allowedJobs.has(id));
  expect(retiredIds).toEqual([...RETIRED_CONTROLLER_SELECTOR_IDS]);
  return retiredIds;
}

function expectedCiOutput(plan: ReturnType<typeof buildE2eWorkflowPlan>): string {
  return [
    `matrix=${JSON.stringify(plan.matrix)}`,
    `test_matrix=${JSON.stringify(plan.testMatrix)}`,
    `catalogue_standard_matrix=${JSON.stringify(plan.catalogueMatrices.standard)}`,
    `catalogue_nvidia_api_matrix=${JSON.stringify(plan.catalogueMatrices["nvidia-api"])}`,
    `catalogue_nvidia_inference_matrix=${JSON.stringify(plan.catalogueMatrices["nvidia-inference"])}`,
    `catalogue_github_read_matrix=${JSON.stringify(plan.catalogueMatrices["github-read"])}`,
    `catalogue_brave_nvidia_inference_matrix=${JSON.stringify(plan.catalogueMatrices["brave-nvidia-inference"])}`,
    `selected_jobs=${JSON.stringify(plan.selectedJobs)}`,
    `selected_workflow_jobs=${JSON.stringify(selectedWorkflowJobs(plan))}`,
    `hermes_selected=${plan.hermesSelected}`,
    `explicit_only_jobs=${plan.explicitOnlyJobs.join(",")}`,
    "release_qualification_waived_jobs=[]",
    `release_required_jobs=${JSON.stringify(releaseRequiredWorkflowJobs())}`,
    "",
  ].join("\n");
}

function prCandidatePlan(
  plan: ReturnType<typeof buildE2eWorkflowPlan>,
): ReturnType<typeof buildE2eWorkflowPlan> {
  return {
    ...plan,
    catalogueMatrices: Object.fromEntries(
      Object.entries(plan.catalogueMatrices).map(([profile, rows]) => [
        profile,
        rows.filter((row) => isPrCandidateCatalogueTarget(catalogueTarget(row.id))),
      ]),
    ) as ReturnType<typeof buildE2eWorkflowPlan>["catalogueMatrices"],
  };
}

describe("E2E workflow plan", () => {
  it("defaults to every release-required target and tagged credential-free test", () => {
    const plan = buildE2eWorkflowPlan();

    expect(plan.matrix).toEqual(buildLiveTargetMatrix());
    expect(plan.testMatrix).toEqual(discoverCredentialFreeTests());
    expect(Object.values(plan.catalogueMatrices).flat()).toHaveLength(E2E_TARGET_CATALOGUE.length);
    expect(plan.hermesSelected).toBe(true);
    expect(plan.explicitOnlyJobs).toEqual(["llama-cpp-dgx-spark-qualification"]);
    expect(releaseRequiredWorkflowJobs()).toContain("live");
    expect(releaseRequiredWorkflowJobs()).toContain("staging-brev-launchable");
    expect(releaseRequiredWorkflowJobs()).not.toContain("llama-cpp-dgx-spark-qualification");
  });

  it("waives only named release-required E2E jobs", () => {
    const defaultJobs = releaseRequiredWorkflowJobs();
    const requestedWaivers = ["live", "staging-brev-launchable"];
    const requiredJobs = releaseRequiredWorkflowJobs({ waivedJobs: requestedWaivers });

    expect(requiredJobs).toEqual(defaultJobs.filter((job) => !requestedWaivers.includes(job)));
    expect(parseReleaseQualificationWaivedJobs(requestedWaivers.join(","))).toEqual(
      requestedWaivers,
    );
    expect(() => releaseRequiredWorkflowJobs({ waivedJobs: ["generate-matrix"] })).toThrow(
      "Cannot waive non-release E2E jobs: generate-matrix",
    );
    expect(() => releaseRequiredWorkflowJobs({ waivedJobs: ["live", "live"] })).toThrow(
      "Release qualification waived jobs must not contain duplicates",
    );
  });

  it("validates jobs and selects only matching credential-free tests", () => {
    const testId = firstId(discoverCredentialFreeTests(), "credential-free test");
    const plan = buildE2eWorkflowPlan({ jobs: `${testId},hermes-e2e` });

    expect(plan.matrix).toEqual([]);
    expect(plan.testMatrix.map((row) => row.id)).toEqual([testId]);
    expect(plan.hermesSelected).toBe(true);
  });

  it("routes a catalogue target through its credential profile", () => {
    const plan = buildE2eWorkflowPlan({ jobs: "cloud-inference" });

    expect(plan.catalogueMatrices["nvidia-inference"].map((row) => row.id)).toEqual([
      "cloud-inference",
    ]);
    expect(plan.catalogueMatrices.standard).toEqual([]);
    expect(selectedWorkflowJobs(plan)).toEqual(["catalogue-nvidia-inference"]);
  });

  it("preserves the profile, timeout, install mode, packages, and environment for migrated targets", () => {
    expect(catalogueTarget("gateway-guard-recovery")).toMatchObject({
      profile: "nvidia-inference",
      timeoutMinutes: 45,
      installMode: "authenticated",
      installNonInteractive: true,
      hostPackages: [],
      environment: {
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
        OPENSHELL_GATEWAY: "nemoclaw",
      },
    });
    expect(catalogueTarget("network-policy")).toMatchObject({
      profile: "nvidia-inference",
      timeoutMinutes: 90,
      installMode: "credential-free",
      installNonInteractive: true,
      hostPackages: ["expect"],
      selector: "^network-policy:.+probes$",
      environment: {
        NEMOCLAW_E2E_SHARD: "live-probes",
        NEMOCLAW_SANDBOX_NAME: "e2e-net-policy",
      },
    });
    expect(catalogueTarget("openclaw-tui-chat-correlation")).toMatchObject({
      profile: "nvidia-inference",
      timeoutMinutes: 75,
      installMode: "none",
      hostPackages: ["expect"],
      environment: {
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
        NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      },
    });
    expect(catalogueTarget("hermes-slack")).toMatchObject({
      id: "hermes-slack",
      displayName: "Messaging: isolates Hermes Slack credentials and reaches Slack APIs",
      profile: "nvidia-inference",
      runner: "linux-amd64-cpu4",
      testFile: "test/e2e/live/hermes-slack-e2e.test.ts",
      owningPaths: [
        "test/e2e/live/hermes-slack-e2e.test.ts",
        "test/e2e/live/hermes-slack-e2e-helpers.ts",
      ],
      releaseRequired: true,
      timeoutMinutes: 75,
      installMode: "none",
      installNonInteractive: false,
      restoreCli: true,
      exposeCliBin: true,
      hostPackages: [],
      environment: {
        NEMOCLAW_AGENT: "hermes",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_POLICY_TIER: "open",
        NEMOCLAW_RECREATE_SANDBOX: "1",
        NEMOCLAW_SANDBOX_NAME: "e2e-hermes-slack",
        OPENSHELL_GATEWAY: "nemoclaw",
        SLACK_APP_TOKEN: "xapp-test-hermes-slack-app-token",
        SLACK_BOT_TOKEN: "xoxb-test-hermes-slack-token",
      },
    });
    expect(catalogueTarget("openclaw-inference-switch")).toMatchObject({
      id: "openclaw-inference-switch",
      displayName: "Inference: OpenClaw switches providers and remains responsive",
      profile: "standard",
      runner: "ubuntu-latest",
      testFile: "test/e2e/live/openclaw-inference-switch.test.ts",
      owningPaths: [
        "test/e2e/live/openclaw-inference-switch.test.ts",
        "test/e2e/live/openclaw-inference-switch-helpers.ts",
      ],
      releaseRequired: true,
      timeoutMinutes: 90,
      installMode: "none",
      installNonInteractive: false,
      restoreCli: true,
      exposeCliBin: true,
      hostPackages: [],
      environment: {
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_E2E_SHARD: "anthropic",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_SANDBOX_NAME: "e2e-oc-inf-switch",
        NEMOCLAW_SWITCH_PROVIDER: "compatible-anthropic-endpoint",
        NEMOCLAW_SWITCH_MODEL: "mock-anthropic-model",
        NEMOCLAW_SWITCH_INFERENCE_API: "anthropic-messages",
        NEMOCLAW_SWITCH_MOCK_ANTHROPIC: "1",
        OPENSHELL_GATEWAY: "nemoclaw",
      },
    });
    expect(catalogueTarget("sandbox-operations")).toMatchObject({
      id: "sandbox-operations",
      displayName: "Sandbox: preserves lifecycle and multi-sandbox operations",
      profile: "nvidia-inference",
      runner: "ubuntu-latest",
      testFile: "test/e2e/live/sandbox-operations.test.ts",
      owningPaths: ["test/e2e/live/sandbox-operations.test.ts"],
      releaseRequired: true,
      timeoutMinutes: 60,
      installMode: "credential-free",
      installNonInteractive: true,
      restoreCli: true,
      exposeCliBin: true,
      hostPackages: [],
      environment: {
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_POLICY_TIER: "open",
        OPENSHELL_GATEWAY: "nemoclaw",
      },
    });

    const plan = buildE2eWorkflowPlan({
      jobs: "gateway-guard-recovery,hermes-slack,network-policy,openclaw-inference-switch,openclaw-tui-chat-correlation,sandbox-operations",
    });
    expect(plan.catalogueMatrices["nvidia-inference"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gateway-guard-recovery",
          host_packages: "",
          install_non_interactive: true,
        }),
        expect.objectContaining({
          id: "hermes-slack",
          display_name: "Messaging: isolates Hermes Slack credentials and reaches Slack APIs",
          runner: "linux-amd64-cpu4",
          test_file: "test/e2e/live/hermes-slack-e2e.test.ts",
        }),
        expect.objectContaining({
          id: "network-policy",
          host_packages: "expect",
          install_non_interactive: true,
        }),
        expect.objectContaining({
          id: "openclaw-tui-chat-correlation",
          host_packages: "expect",
        }),
        expect.objectContaining({
          id: "sandbox-operations",
          install_mode: "credential-free",
          install_non_interactive: true,
        }),
      ]),
    );
    expect(plan.catalogueMatrices.standard).toContainEqual(
      expect.objectContaining({
        id: "openclaw-inference-switch",
        display_name: "Inference: OpenClaw switches providers and remains responsive",
      }),
    );
    const retainedJobs = readFreeStandingJobsInventory().allowedJobs;
    for (const target of ["hermes-slack", "openclaw-inference-switch", "sandbox-operations"]) {
      expect(retainedJobs).not.toContain(target);
    }
  });

  it.each([
    [
      "issue-4434-tui-unreachable-inference",
      "the nvidia-inference profile uses gateway-managed inference, which this test skips by design",
    ],
    [
      "overlayfs-autofix",
      "the managed Linux Docker gateway bypasses the legacy overlayfs autofix path",
    ],
  ])("excludes %s from catalogue planning with a reason (#9022)", (id, reason) => {
    expect(E2E_TARGET_CATALOGUE.map((target) => target.id)).not.toContain(id);
    for (const selector of ["jobs", "targets"] as const) {
      expect(() => buildE2eWorkflowPlan({ [selector]: id })).toThrow(
        `E2E catalogue target ${id} is not scheduled: ${reason}`,
      );
    }
  });

  it("rejects unreviewed catalogue execution metadata", () => {
    const target = catalogueTarget("network-policy");
    expect(() => validateE2eTargetCatalogue([{ ...target, runnerKey: "unknown-runner" }])).toThrow(
      "invalid runner routing key",
    );
    expect(() =>
      validateE2eTargetCatalogue([{ ...target, hostPackages: ["curl"] as never }]),
    ).toThrow("invalid or duplicate host packages");
    expect(() => validateE2eTargetCatalogue([{ ...target, selector: "safe; sudo true" }])).toThrow(
      "invalid test selector",
    );
    expect(() =>
      validateE2eTargetCatalogue([{ ...target, artifactLayout: "unreviewed" as never }]),
    ).toThrow("invalid artifact layout");
    expect(() =>
      validateE2eTargetCatalogue([{ ...target, artifactLayout: "flat-shard", shard: "default" }]),
    ).toThrow("flat artifact layout requires a named shard");
    expect(() =>
      validateE2eTargetCatalogue([
        target,
        { ...target, id: "duplicate-evidence", displayName: "Evidence: duplicates a shard" },
      ]),
    ).toThrow("duplicates an evidence target and shard");
  });

  it.each([
    [
      "agent-turn-latency",
      {
        profile: "nvidia-inference",
        installMode: "authenticated",
        installNonInteractive: true,
        hostPreparation: "hermes-swap",
        runnerComparison: true,
        compatibleApiKey: true,
      },
    ],
    [
      "bootstrap-install-smoke",
      { profile: "nvidia-inference", restoreCli: false, compatibleApiKey: true },
    ],
    [
      "hermes-discord",
      {
        profile: "nvidia-inference",
        runnerKey: "hermes-discord",
        hostPreparation: "hermes-swap",
        runnerComparison: true,
      },
    ],
    [
      "hermes-inference-switch",
      {
        profile: "standard",
        installNonInteractive: true,
        runnerKey: "hermes-inference-switch",
        hostPreparation: "hermes-swap",
        runnerComparison: true,
        shard: "anthropic",
      },
    ],
    [
      "hermes-shields-config",
      {
        profile: "standard",
        runnerKey: "hermes-shields-config",
        hostPreparation: "hermes-swap",
        runnerComparison: true,
      },
    ],
    [
      "skill-agent",
      {
        profile: "nvidia-inference",
        installMode: "authenticated",
        artifactLayout: "target-shard",
      },
    ],
  ] as const)("preserves the shared execution contract for %s", (id, contract) => {
    expect(catalogueTarget(id)).toMatchObject(contract);
  });

  it.each([
    [
      "bedrock-runtime-compatible-anthropic",
      [
        "bedrock-runtime-compatible-anthropic-openclaw",
        "bedrock-runtime-compatible-anthropic-hermes",
      ],
    ],
    ["channels-stop-start", ["channels-stop-start-openclaw", "channels-stop-start-hermes"]],
    ["security-posture", ["security-posture-openclaw", "security-posture-hermes"]],
  ])("maps the %s selector to its concrete catalogue executions", (selector, expected) => {
    const plan = buildE2eWorkflowPlan({ jobs: selector });
    expect(
      Object.values(plan.catalogueMatrices)
        .flat()
        .map((row) => row.id),
    ).toEqual(expected);
    expect(plan.selectedJobs).not.toContain(selector);
  });

  it("rejects malformed, implementation-derived, and duplicate display names", () => {
    const networkPolicy = catalogueTarget("network-policy");
    const cloudInference = catalogueTarget("cloud-inference");

    expect(() =>
      validateE2eTargetCatalogue([{ ...networkPolicy, displayName: "network-policy" }]),
    ).toThrow("invalid or duplicate display name");
    expect(() =>
      validateE2eTargetCatalogue([
        { ...networkPolicy, displayName: "E2E: validates issue #7912 live" },
      ]),
    ).toThrow("invalid or duplicate display name");
    for (const displayName of [
      "Network: enforces network-policy rules",
      "Network: runs on ubuntu-latest",
      "Network: validates issue-2478 recovery",
    ]) {
      expect(() => validateE2eTargetCatalogue([{ ...networkPolicy, displayName }])).toThrow(
        "invalid or duplicate display name",
      );
    }
    expect(() =>
      validateE2eTargetCatalogue([
        {
          ...networkPolicy,
          displayName: "Network: uses isolated-sandbox for policy checks",
          environment: { NEMOCLAW_SANDBOX_NAME: "isolated-sandbox" },
        },
      ]),
    ).toThrow("invalid or duplicate display name");
    expect(() =>
      validateE2eTargetCatalogue([
        networkPolicy,
        { ...cloudInference, displayName: networkPolicy.displayName },
      ]),
    ).toThrow("invalid or duplicate display name");
  });

  it("omits credentialed catalogue profiles when checkout_sha is set", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-pr-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const plan = buildE2eWorkflowPlan();
    plan.catalogueMatrices["nvidia-api"] = [];
    plan.catalogueMatrices["nvidia-inference"] = [];
    plan.catalogueMatrices["github-read"] = [];
    plan.catalogueMatrices["brave-nvidia-inference"] = [];

    try {
      writeE2eWorkflowPlanCiOutput(
        {},
        {
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
        },
      );

      expect(readFileSync(output, "utf8")).toBe(expectedCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("allows manual PR dispatch only for standard-profile targets", () => {
    expect(
      Object.fromEntries(
        E2E_TARGET_CATALOGUE.map((target) => [
          target.profile,
          isPrCandidateCatalogueTarget(target),
        ]),
      ),
    ).toEqual({
      standard: true,
      "nvidia-api": false,
      "nvidia-inference": false,
      "github-read": false,
      "brave-nvidia-inference": false,
    });
  });

  it("routes homogeneous GPU targets through the standard profile", () => {
    const expectedRunner = "linux-amd64-gpu-rtxpro6000-latest-1";
    const gpuDoubleOnboard = catalogueTarget("gpu-double-onboard");
    const gpuE2e = catalogueTarget("gpu-e2e");
    const llamaCpp = catalogueTarget("llama-cpp-generic-gpu");

    expect([gpuDoubleOnboard, gpuE2e, llamaCpp]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profile: "standard", runner: expectedRunner }),
      ]),
    );
    expect([gpuDoubleOnboard.runner, gpuE2e.runner, llamaCpp.runner]).toEqual([
      expectedRunner,
      expectedRunner,
      expectedRunner,
    ]);
    expect(gpuE2e.environment.E2E_LLAMA_CPP_DEDICATED_LANE).toBe("1");
    expect(llamaCpp.environment).toEqual(
      expect.objectContaining({
        NEMOCLAW_LLAMACPP_RECIPE: "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1",
        NEMOCLAW_PROVIDER: "install-llama-cpp",
      }),
    );
    expect(llamaCpp.environment).not.toHaveProperty("NEMOCLAW_MODEL");
  });

  it("selects only catalogue targets that own changed files", () => {
    const changedFile = "test/e2e/live/snapshot-commands.test.ts";
    const plan = buildE2eWorkflowPlan({}, { changedFiles: [changedFile] });

    expect(catalogueTargetsForChangedFiles([changedFile]).map((target) => target.id)).toEqual([
      "snapshot-commands",
    ]);
    expect(plan.catalogueMatrices.standard.map((row) => row.id)).toEqual(["snapshot-commands"]);
    expect(selectedWorkflowJobs(plan)).toEqual(["catalogue-standard", "jetson-nvmap-gpu"]);
  });

  it("selects the Jetson test when no other E2E job owns a changed file (#8142)", () => {
    const plan = buildE2eWorkflowPlan({}, { changedFiles: ["docs/index.yml"] });

    expect(selectedWorkflowJobs(plan)).toEqual(["jetson-nvmap-gpu"]);
    expect(Object.values(plan.catalogueMatrices).flat()).toEqual([]);
    expect(plan.matrix).toEqual([]);
    expect(plan.testMatrix).toEqual([]);
  });

  it.each([
    ".github/workflows/e2e.yaml",
    ".github/actions/prepare-e2e/action.yaml",
    "test/e2e/fixtures/e2e-test.ts",
    "tools/e2e/live-vitest-invocation.mts",
  ])("selects the full suite when shared execution changes: %s", (changedFile) => {
    const plan = buildE2eWorkflowPlan({}, { changedFiles: [changedFile] });
    const fullPlan = buildE2eWorkflowPlan();

    expect(plan).toEqual({
      ...fullPlan,
      selectedJobs: [...fullPlan.selectedJobs, "jetson-nvmap-gpu"],
    });
  });

  it("selects catalogue targets without unrelated jobs when their profile changes", () => {
    const plan = buildE2eWorkflowPlan(
      {},
      { changedFiles: [".github/workflows/e2e-standard-profile.yaml"] },
    );

    expect(Object.values(plan.catalogueMatrices).flat()).toHaveLength(E2E_TARGET_CATALOGUE.length);
    expect(plan.selectedJobs).toEqual(["jetson-nvmap-gpu"]);
    expect(plan.matrix).toEqual([]);
    expect(plan.testMatrix).toEqual([]);
  });

  it("selects every catalogue target when its shared installer changes", () => {
    expect(catalogueTargetsForChangedFiles(["scripts/install-openshell.sh"])).toEqual(
      E2E_TARGET_CATALOGUE,
    );
  });

  it("uses the PR risk rules to select catalogue targets for changed runtime code", () => {
    const plan = buildE2eWorkflowPlan({}, { changedFiles: ["src/lib/onboard.ts"] });
    const targetIds = Object.values(plan.catalogueMatrices)
      .flat()
      .map((row) => row.id);

    expect(targetIds).toEqual(expect.arrayContaining(["onboard-repair", "onboard-resume"]));
  });

  it("uses one risk rule for catalogue targets and workflow jobs", () => {
    const plan = buildE2eWorkflowPlan(
      {},
      { changedFiles: ["src/lib/messaging/applier/agent-config.ts"] },
    );

    expect(plan.catalogueMatrices.standard.map((row) => row.id)).toContain("channels-add-remove");
    expect(plan.catalogueMatrices["nvidia-inference"].map((row) => row.id)).toEqual(
      expect.arrayContaining(["channels-stop-start-openclaw", "channels-stop-start-hermes"]),
    );
    expect(plan.selectedJobs).not.toContain("channels-stop-start");
  });

  it.each(["jobs", "targets"] as const)(
    "maps the retired Hermes dashboard %s selector to the canonical lane",
    (kind) => {
      const legacyPlan = buildE2eWorkflowPlan({ [kind]: "hermes-dashboard" });
      const canonicalPlan = buildE2eWorkflowPlan({ [kind]: "hermes-e2e" });
      const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-alias-"));
      const output = path.join(directory, "github-output");
      const summary = path.join(directory, "summary.md");

      try {
        writeE2eWorkflowPlanCiOutput(
          { [kind]: "hermes-dashboard" },
          {
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            INFERENCE_MODE: "mock",
          },
        );

        expect(legacyPlan).toEqual(canonicalPlan);
        expect(legacyPlan.hermesSelected).toBe(true);
        expect(readFileSync(output, "utf8")).toContain("hermes_selected=true\n");
        expect(readFreeStandingJobsInventory().allowedJobs).not.toContain("hermes-dashboard");
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it.each(["jobs", "targets"] as const)(
    "maps the retired sandbox rlimit %s selector to sandbox operations",
    (kind) => {
      const legacyPlan = buildE2eWorkflowPlan({ [kind]: "sandbox-rlimits-connect" });
      const canonicalPlan = buildE2eWorkflowPlan({ [kind]: "sandbox-operations" });

      expect(legacyPlan).toEqual(canonicalPlan);
      expect(legacyPlan.hermesSelected).toBe(false);
      expect(readFreeStandingJobsInventory().allowedJobs).not.toContain("sandbox-rlimits-connect");
    },
  );

  it("routes a registry target into the live matrix", () => {
    const registryId = firstId(buildLiveTargetMatrix(), "supported registry target");
    const plan = buildE2eWorkflowPlan({ targets: registryId });

    expect(plan.matrix.map((row) => row.id)).toEqual([registryId]);
    expect(plan.testMatrix).toEqual([]);
    expect(plan.hermesSelected).toBe(false);
  });

  it("partitions mixed registry and tagged test targets", () => {
    const registryId = firstId(buildLiveTargetMatrix(), "supported registry target");
    const testId = firstId(discoverCredentialFreeTests(), "credential-free test");
    const plan = buildE2eWorkflowPlan({ targets: `${registryId},${testId}` });

    expect(plan.matrix.map((row) => row.id)).toEqual([registryId]);
    expect(plan.testMatrix.map((row) => row.id)).toEqual([testId]);
  });

  it.each(["definitely-unknown-e2e-job", "constructor"])(
    "rejects unknown job %s without consulting inherited alias properties",
    (job) => {
      expect(() => buildE2eWorkflowPlan({ jobs: job })).toThrow(`Unknown E2E test ID: ${job}`);
    },
  );

  it("maps launchable-smoke to bootstrap-install-smoke when checkout_sha is set", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-cli-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const plan = buildE2eWorkflowPlan({ jobs: "bootstrap-install-smoke" });
    try {
      const result = spawnSync(TSX, [PLANNER_CLI, "--ci-output"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          JOBS: "launchable-smoke",
          TARGETS: "",
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
        },
        timeout: 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      const expectedPlan = prCandidatePlan(plan);
      expect(readFileSync(output, "utf8")).toBe(expectedCiOutput(expectedPlan));
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(expectedPlan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("plans active jobs while checking retired controller selectors (#7616)", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-cli-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const activeJobs = "cloud-onboard,security-posture";
    const plan = buildE2eWorkflowPlan({ jobs: activeJobs });
    try {
      const result = spawnSync(TSX, [PLANNER_CLI, "--ci-output"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          JOBS: [activeJobs, ...retiredControllerSelectorIds()].join(","),
          TARGETS: "",
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
        },
        timeout: 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      const expectedPlan = prCandidatePlan(plan);
      expect(readFileSync(output, "utf8")).toBe(expectedCiOutput(expectedPlan));
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(expectedPlan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each(RETIRED_CONTROLLER_SELECTOR_IDS)(
    "emits an empty live plan for retired controller job %s (#7616)",
    (job) => {
      const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-cli-"));
      const output = path.join(directory, "github-output");
      const summary = path.join(directory, "summary.md");
      const plan: ReturnType<typeof buildE2eWorkflowPlan> = {
        matrix: [],
        testMatrix: [],
        catalogueMatrices: {
          standard: [],
          "nvidia-api": [],
          "nvidia-inference": [],
          "github-read": [],
          "brave-nvidia-inference": [],
        },
        selectedJobs: [],
        hermesSelected: false,
        explicitOnlyJobs: readFreeStandingJobsInventory().explicitOnlyJobs,
      };
      try {
        const result = spawnSync(TSX, [PLANNER_CLI, "--ci-output"], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            INFERENCE_MODE: "mock",
            JOBS: job,
            TARGETS: "",
            NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
          },
          timeout: 30_000,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(output, "utf8")).toBe(expectedCiOutput(plan));
        expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it.each(["jobs", "targets"] as const)(
    "emits an empty shared plan for the Jetson dispatch %s selector (#8142)",
    (selector) => {
      expect(buildE2eWorkflowPlan({ [selector]: "jetson-nvmap-gpu" })).toEqual({
        matrix: [],
        testMatrix: [],
        catalogueMatrices: {
          standard: [],
          "nvidia-api": [],
          "nvidia-inference": [],
          "github-read": [],
          "brave-nvidia-inference": [],
        },
        selectedJobs: ["jetson-nvmap-gpu"],
        hermesSelected: false,
        explicitOnlyJobs: readFreeStandingJobsInventory().explicitOnlyJobs,
      });
    },
  );

  it("emits an empty matrix for retired free-standing rebuild selectors (#7615)", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-cli-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const plan: ReturnType<typeof buildE2eWorkflowPlan> = {
      matrix: [],
      testMatrix: [],
      catalogueMatrices: {
        standard: [],
        "nvidia-api": [],
        "nvidia-inference": [],
        "github-read": [],
        "brave-nvidia-inference": [],
      },
      selectedJobs: [],
      hermesSelected: false,
      explicitOnlyJobs: readFreeStandingJobsInventory().explicitOnlyJobs,
    };
    try {
      const result = spawnSync(TSX, [PLANNER_CLI, "--ci-output"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          JOBS: "",
          TARGETS: "sandbox-rebuild,upgrade-stale-sandbox",
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
        },
        timeout: 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(expectedCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects the retired bootstrap job outside a PR controller checkout", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-cli-"));
    try {
      const result = spawnSync(TSX, [PLANNER_CLI, "--ci-output"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: path.join(directory, "github-output"),
          GITHUB_STEP_SUMMARY: path.join(directory, "summary.md"),
          INFERENCE_MODE: "mock",
          JOBS: "launchable-smoke",
          TARGETS: "",
          NEMOCLAW_E2E_EXPECTED_SHA: "",
        },
        timeout: 30_000,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("::error::Unknown E2E test ID: launchable-smoke");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects an unknown target that belongs to neither inventory nor registry", () => {
    expect(() => buildE2eWorkflowPlan({ targets: "definitely-unknown-e2e-target" })).toThrow(
      "Unknown target 'definitely-unknown-e2e-target'",
    );
  });

  it.each([
    ["jobs", "alpha,,beta"],
    ["jobs", "alpha beta"],
    ["targets", "../escape"],
    ["targets", "alpha,"],
  ] as const)("rejects invalid %s input %s", (kind, value) => {
    expect(() => buildE2eWorkflowPlan({ [kind]: value })).toThrow(`Invalid ${kind} input`);
  });

  it("combines free-standing jobs and typed targets in one execution plan", () => {
    const registryId = firstId(buildLiveTargetMatrix(), "supported registry target");
    const plan = buildE2eWorkflowPlan({ jobs: "hermes-e2e", targets: registryId });

    expect(plan.matrix.map((row) => row.id)).toEqual([registryId]);
    expect(plan.testMatrix).toEqual([]);
    expect(plan.hermesSelected).toBe(true);
  });

  it("fails closed on malformed planner output", () => {
    const validPlan = buildE2eWorkflowPlan();
    const [registryRow] = validPlan.matrix;
    const [testRow] = validPlan.testMatrix;
    expect(registryRow).toBeDefined();
    expect(testRow).toBeDefined();
    const { explicitOnlyJobs: _omitted, ...missingField } = validPlan;
    const malformedPlans = [
      missingField,
      { ...validPlan, matrix: [...validPlan.matrix, { ...registryRow }] },
      { ...validPlan, testMatrix: [{ ...testRow, id: "invalid_id" }] },
      {
        ...validPlan,
        testMatrix: [{ ...testRow, project: "e2e-live", file: "test/e2e/live/../secret.test.ts" }],
      },
      { ...validPlan, testMatrix: [{ ...testRow, id: registryRow.id }] },
      { ...validPlan, hermesSelected: "false" },
    ];

    for (const plan of malformedPlans) {
      expect(() => validateE2eWorkflowPlan(plan)).toThrow(
        "E2E planner returned an invalid output schema",
      );
    }
  });

  it("writes byte-compatible GitHub outputs and the execution-plan summary", () => {
    const testId = firstId(discoverCredentialFreeTests(), "credential-free test");
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const plan = buildE2eWorkflowPlan({ jobs: testId });
    try {
      writeE2eWorkflowPlanCiOutput(
        { jobs: testId },
        {
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
        },
      );

      expect(readFileSync(output, "utf8")).toBe(expectedCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects an unsupported inference mode before writing CI output", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    try {
      expect(() =>
        writeE2eWorkflowPlanCiOutput(
          {},
          {
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            INFERENCE_MODE: "unsupported",
          },
        ),
      ).toThrow("Invalid inference_mode: unsupported");
      expect(existsSync(output)).toBe(false);
      expect(existsSync(summary)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("requires changed-file evidence for push planning", () => {
    expect(() =>
      writeE2eWorkflowPlanCiOutput(
        {},
        {
          EVENT_NAME: "push",
          INFERENCE_MODE: "mock",
        },
      ),
    ).toThrow("E2E planner requires CHANGED_FILES for a push event");
  });

  it("emits one compact JSON line with the deterministic workflow-output schema", () => {
    let output = "";
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      runE2eWorkflowPlanCli(["--jobs", "hermes-e2e"]);
    } finally {
      process.stdout.write = write;
    }

    expect(output.endsWith("\n")).toBe(true);
    expect(output.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(output);
    expect(Object.keys(parsed)).toEqual([
      "matrix",
      "testMatrix",
      "catalogueMatrices",
      "selectedJobs",
      "hermesSelected",
      "explicitOnlyJobs",
    ]);
    expect(output).toBe(`${JSON.stringify(parsed)}\n`);
  });

  it("renders the selected targets and workflow jobs as a readable plan", () => {
    const filtered = spawnSync(TSX, [PLANNER_CLI, "--summary", "--jobs", "hermes-e2e"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(filtered.status, filtered.stderr).toBe(0);
    expect(filtered.stdout).toBe(`## E2E Execution Plan

| Target or job | Execution | Runner |
| --- | --- | --- |
| \`hermes-e2e\` | retained workflow job | declared by job |
`);

    const complete = spawnSync(TSX, [PLANNER_CLI, "--summary"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(complete.status, complete.stderr).toBe(0);
    expect(complete.stdout).toContain(
      "| `cloud-onboard` | retained workflow job | declared by job |",
    );
    expect(complete.stdout).toContain(
      "| `ubuntu-repo-cloud-openclaw` | typed registry | `ubuntu-latest` |",
    );
    expect(complete.stdout).toContain("| shared E2E job | `ubuntu-latest` |");
    expect(complete.stdout).toContain("| `channels-add-remove` | `standard` profile |");
    expect(complete.stdout).toContain(
      "| `model-router-provider-routed-inference` | `nvidia-api` profile |",
    );
    expect(complete.stdout).toContain("| `cloud-inference` | `nvidia-inference` profile |");
  });

  it("keeps CI and readable summary output modes separate", () => {
    expect(() => runE2eWorkflowPlanCli(["--ci-output", "--summary"])).toThrow(
      "--ci-output and --summary cannot be combined",
    );
  });

  it("reports CLI failures as workflow annotations", () => {
    const result = spawnSync(
      TSX,
      [PLANNER_CLI, "--jobs", "hermes-e2e", "--targets", "definitely-unknown-e2e-target"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("::error::Unknown target 'definitely-unknown-e2e-target'");
  });

  it("writes CI outputs from the selector environment through the CLI", () => {
    const testId = firstId(discoverCredentialFreeTests(), "credential-free test");
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-cli-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const plan = buildE2eWorkflowPlan({ jobs: testId });
    try {
      const result = spawnSync(TSX, [PLANNER_CLI, "--ci-output"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          JOBS: testId,
          TARGETS: "",
        },
        timeout: 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(expectedCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("writes controller-selected jobs and targets through the CI-output path (#7031)", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-cli-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const target = "ubuntu-repo-cloud-langchain-deepagents-code";
    const plan = buildE2eWorkflowPlan({ jobs: "cloud-onboard", targets: target });
    try {
      const result = spawnSync(TSX, [PLANNER_CLI, "--ci-output"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          JOBS: "cloud-onboard",
          TARGETS: target,
        },
        timeout: 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(expectedCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
