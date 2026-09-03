// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  credentialFreeTestCoverage,
  credentialFreeTestMatrix,
  discoverCredentialFreeTests,
} from "../../../tools/e2e/credential-free-tests.mts";
import { E2E_AGENT_RUNTIMES } from "../../../tools/e2e/execution-coverage.mts";
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
  renderE2eWorkflowPlanSummary,
  runE2eWorkflowPlanCli,
  selectedWorkflowJobs,
  validateE2eWorkflowPlan,
  withoutUnavailableOptionalCredentialTargets,
  writeE2eWorkflowPlanCiOutput,
} from "../../../tools/e2e/workflow-plan.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { listTargets } from "../registry/registry.ts";
import { buildLiveTargetMatrix } from "../registry/run.ts";
import { liveTargetSupport } from "../registry/runtime-support.ts";
import { expectedWorkflowPlanCiOutput } from "./workflow-plan-test-assertions.ts";

const PLANNER_CLI = path.join(REPO_ROOT, "tools", "e2e", "workflow-plan.mts");
const PLANNER_CLI_PREFIX = ["--import", "tsx", PLANNER_CLI];

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

function expectExplicitCatalogueCoverage(): void {
  for (const target of E2E_TARGET_CATALOGUE) {
    expect(E2E_AGENT_RUNTIMES).toContain(target.agentRuntime);
    expect(target.agentRuntime === "unresolved").toBe(target.unresolvedReason !== "");
  }
}

describe("E2E workflow plan", () => {
  it("defaults to every release-required target and tagged credential-free test", () => {
    const plan = buildE2eWorkflowPlan();
    expect(plan).toEqual(buildE2eWorkflowPlan({}, { gatewayRuntimes: ["docker"] }));
    expect(plan.matrix).toEqual(buildLiveTargetMatrix());
    expect(plan.testMatrix).toEqual(
      credentialFreeTestMatrix(discoverCredentialFreeTests(), ["docker"]),
    );
    expect(Object.values(plan.catalogueMatrices).flat()).toHaveLength(E2E_TARGET_CATALOGUE.length);
    expect(
      plan.coverageMatrix.reduce<Record<string, number>>((counts, row) => {
        counts[row.source] = (counts[row.source] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({
      catalogue: E2E_TARGET_CATALOGUE.length,
      "typed-registry": 4,
      "shared-e2e": 2,
      "retained-workflow": 18,
      staging: 1,
    });
    expect(plan.coverageMatrix.filter((row) => row.unresolvedReason !== "")).toEqual([
      expect.objectContaining({
        id: "spark-install",
        agentRuntime: "unresolved",
      }),
    ]);
    expect(plan.hermesSelected).toBe(true);
    expect(plan.coverageMatrix).toHaveLength(91);
    expect(selectedWorkflowJobs(plan)).toEqual([
      "catalogue-brave-nvidia-inference",
      "catalogue-github-read",
      "catalogue-nvidia-api",
      "catalogue-nvidia-inference",
      "catalogue-standard",
      "cloud-onboard",
      "hermes-e2e",
      "hermes-gpu-startup",
      "live",
      "managed-image-multiarch-startup",
      "managed-image-protected-runtime",
      "mcp-bridge",
      "mcp-bridge-dev",
      "messaging-providers",
      "openclaw-plugin-runtime-exdev",
      "openshell-credential-generation-window",
      "openshell-gateway-auth-contract",
      "shared-e2e",
      "staging-brev-launchable",
    ]);
    expect(plan.explicitOnlyJobs).toEqual([
      "staging-brev-launchable-identity",
      "external-gateway-health",
      "llama-cpp-dgx-spark-qualification",
    ]);
    expect(releaseRequiredWorkflowJobs()).toContain("live");
    expect(releaseRequiredWorkflowJobs()).toContain("staging-brev-launchable");
    expect(releaseRequiredWorkflowJobs()).not.toContain("staging-brev-launchable-identity");
    expect(releaseRequiredWorkflowJobs()).not.toContain("llama-cpp-dgx-spark-qualification");
  });

  it("selects only native Podman-eligible executions when explicitly requested", () => {
    const plan = buildE2eWorkflowPlan({}, { gatewayRuntimes: ["podman"] });
    const catalogueIds = Object.values(plan.catalogueMatrices)
      .flat()
      .map((row) => row.id);
    expect(plan.matrix.map((row) => row.id)).toEqual([
      "ubuntu-policy-custom-missing-presets-negative",
      "ubuntu-repo-cloud-openclaw",
    ]);
    expect(plan.testMatrix).toEqual([]);
    expect(catalogueIds).toHaveLength(50);
    expect(catalogueIds).not.toEqual(
      expect.arrayContaining([
        "bootstrap-install-smoke",
        "gateway-guard-recovery",
        "rebuild-hermes",
        "rebuild-openclaw",
      ]),
    );
    expect(catalogueIds.some((id) => id.startsWith("openshell-gateway-upgrade-"))).toBe(false);
    expect(selectedWorkflowJobs(plan)).toEqual([
      "catalogue-brave-nvidia-inference",
      "catalogue-github-read",
      "catalogue-nvidia-api",
      "catalogue-nvidia-inference",
      "catalogue-standard",
      "cloud-onboard",
      "hermes-e2e",
      "hermes-gpu-startup",
      "live",
      "mcp-bridge",
      "mcp-bridge-dev",
      "messaging-providers",
      "openshell-credential-generation-window",
    ]);
  });
  it("omits only targets whose optional credential is unavailable", () => {
    const plan = withoutUnavailableOptionalCredentialTargets(buildE2eWorkflowPlan(), new Set());
    const braveRows = plan.catalogueMatrices["brave-nvidia-inference"].map((row) => row.id);

    expect(braveRows).not.toContain("brave-search");
    expect(braveRows).not.toContain("common-egress-agent-openclaw-balanced-weather");
    expect(braveRows).toContain("common-egress-agent-openclaw-open-reference");
    expect(braveRows).toContain("common-egress-agent-hermes-open-reference");
    expect(plan.coverageMatrix.map((row) => row.id)).not.toContain("brave-search");
    expect(() => validateE2eWorkflowPlan(plan)).not.toThrow();
  });

  it("keeps multiple inert declarations visibly unresolved without treating them as evidence (#9167)", () => {
    const plan = buildE2eWorkflowPlan({
      targets: "ubuntu-repo-cloud-hermes,ubuntu-repo-cloud-hermes-slack",
    });

    expect(plan.matrix).toHaveLength(2);
    expect(plan.matrix.every((row) => !row.supported)).toBe(true);
    expect(plan.coverageMatrix).toEqual([
      expect.objectContaining({ id: "ubuntu-repo-cloud-hermes", agentRuntime: "unresolved" }),
      expect.objectContaining({
        id: "ubuntu-repo-cloud-hermes-slack",
        agentRuntime: "unresolved",
      }),
    ]);
    expect(() => validateE2eWorkflowPlan(plan)).not.toThrow();
  });

  it("includes staging only when the execution plan selects it (#9167)", () => {
    const stagingPlan = buildE2eWorkflowPlan({ jobs: "staging-brev-launchable" });

    expect(stagingPlan.selectedJobs).toEqual(["staging-brev-launchable"]);
    expect(stagingPlan.coverageMatrix).toEqual([
      expect.objectContaining({ id: "staging-brev-launchable", source: "staging" }),
    ]);

    const hermesPlan = buildE2eWorkflowPlan({ jobs: "hermes-e2e" });
    const stagingRow = buildE2eWorkflowPlan().coverageMatrix.find(
      (row) => row.id === "staging-brev-launchable",
    )!;
    expect(() =>
      validateE2eWorkflowPlan({
        ...hermesPlan,
        coverageMatrix: [stagingRow, ...hermesPlan.coverageMatrix],
      }),
    ).toThrow("execution coverage that does not match its execution plan");
  });

  it("selects the Launchable identity smoke only when named explicitly (#9925)", () => {
    const plan = buildE2eWorkflowPlan({ jobs: "staging-brev-launchable-identity" });

    expect(plan.selectedJobs).toEqual(["staging-brev-launchable-identity"]);
    expect(plan.coverageMatrix).toEqual([
      expect.objectContaining({
        id: "staging-brev-launchable-identity",
        source: "staging",
        agentRuntime: "none",
      }),
    ]);
    expect(selectedWorkflowJobs(plan)).toEqual(["staging-brev-launchable-identity"]);
    expect(buildE2eWorkflowPlan().selectedJobs).not.toContain("staging-brev-launchable-identity");
    expect(() =>
      buildE2eWorkflowPlan({
        jobs: "staging-brev-launchable-identity,hermes-e2e",
      }),
    ).toThrow("staging-brev-launchable-identity must be selected by itself");
    expect(() =>
      buildE2eWorkflowPlan({
        jobs: "staging-brev-launchable-identity",
        targets: "ubuntu-repo-cloud-openclaw",
      }),
    ).toThrow("staging-brev-launchable-identity must be selected by itself");
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

  it("routes both Pi qualification targets through the NVIDIA API key profile", () => {
    const targetIds = ["pi-agent-qualification-amd64", "pi-agent-qualification-arm64"];
    const plan = buildE2eWorkflowPlan({ targets: targetIds.join(",") });

    expect(targetIds.map((id) => catalogueTarget(id).profile)).toEqual([
      "nvidia-api",
      "nvidia-api",
    ]);
    expect(plan.catalogueMatrices["nvidia-api"].map((row) => row.id)).toEqual(targetIds);
    expect(plan.catalogueMatrices["nvidia-inference"]).toEqual([]);
    expect(selectedWorkflowJobs(plan)).toEqual(["catalogue-nvidia-api"]);
  });

  it("emits required fields and catalogue workflow jobs for migrated targets", () => {
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
    expect(selectedWorkflowJobs(plan)).toEqual([
      "catalogue-nvidia-inference",
      "catalogue-standard",
    ]);
    const migratedTargetIds = ["hermes-slack", "openclaw-inference-switch", "sandbox-operations"];
    const retainedMigratedJobs = readFreeStandingJobsInventory().allowedJobs.filter((id) =>
      migratedTargetIds.includes(id),
    );

    expect(retainedMigratedJobs).toEqual([]);
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
    (["jobs", "targets"] as const).forEach((selector) => {
      expect(() => buildE2eWorkflowPlan({ [selector]: id })).toThrow(
        `E2E catalogue target ${id} is not scheduled: ${reason}`,
      );
    });
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
    expect(() => validateE2eTargetCatalogue([{ ...target, gatewayRuntimes: [] }])).toThrow(
      "invalid gateway runtime support",
    );
    expect(() =>
      validateE2eTargetCatalogue([{ ...target, gatewayRuntimes: ["docker", "docker"] as never }]),
    ).toThrow("invalid gateway runtime support");
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
      {
        profile: "nvidia-inference",
        restoreCli: false,
        compatibleApiKey: true,
        gatewayRuntimes: ["docker"],
      },
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

  it("requires explicit execution coverage for every catalogue target (#9167)", () => {
    expectExplicitCatalogueCoverage();

    const target = catalogueTarget("cloud-inference");
    expect(() =>
      validateE2eTargetCatalogue([{ ...target, agentRuntime: "unresolved", unresolvedReason: "" }]),
    ).toThrow("must declare an unresolved reason");
    expect(() =>
      validateE2eTargetCatalogue([
        { ...target, displayName: "Inference: preserves the operator's selected route" },
      ]),
    ).not.toThrow();
  });

  it("rejects inherited properties as credential-free coverage IDs (#9167)", () => {
    expect(() => credentialFreeTestCoverage("constructor")).toThrow(
      "Credential-free test constructor requires execution coverage metadata",
    );
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

  it.each([
    "Network: enforces network-policy rules",
    "Network: runs on ubuntu-latest",
    "Network: validates issue-2478 recovery",
  ])(
    "rejects malformed, implementation-derived, and duplicate display names [%s]",
    (displayName) => {
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

      expect(() => validateE2eTargetCatalogue([{ ...networkPolicy, displayName }])).toThrow(
        "invalid or duplicate display name",
      );

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
    },
  );

  it("includes every catalogue profile for an authorized NVIDIA-owned candidate", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-pr-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const plan = buildE2eWorkflowPlan();
    try {
      writeE2eWorkflowPlanCiOutput(
        {},
        {
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          NEMOCLAW_E2E_CREDENTIALS_ALLOWED: "true",
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
        },
      );

      expect(readFileSync(output, "utf8")).toBe(expectedWorkflowPlanCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("uses the explicit Podman planner in the CI output path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-podman-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    const plan = buildE2eWorkflowPlan({}, { gatewayRuntimes: ["podman"] });
    try {
      writeE2eWorkflowPlanCiOutput(
        {},
        {
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          NEMOCLAW_E2E_CREDENTIALS_ALLOWED: "true",
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
          NEMOCLAW_GATEWAY_RUNTIMES: "podman",
        },
      );

      expect(readFileSync(output, "utf8")).toBe(expectedWorkflowPlanCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("limits an unauthorized candidate without selectors to credential-free matrices", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-fork-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    try {
      writeE2eWorkflowPlanCiOutput(
        {},
        {
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          NEMOCLAW_E2E_CREDENTIALS_ALLOWED: "false",
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
        },
      );

      const outputLines = readFileSync(output, "utf8").split("\n");
      expect(outputLines).toEqual(
        expect.arrayContaining([
          "catalogue_nvidia_api_matrix=[]",
          "catalogue_nvidia_inference_matrix=[]",
          "catalogue_github_read_matrix=[]",
          "catalogue_brave_nvidia_inference_matrix=[]",
          "selected_jobs=[]",
          "hermes_selected=false",
        ]),
      );
      expect(outputLines).not.toContain("catalogue_standard_matrix=[]");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("retains controller-approved jobs for an unauthorized candidate", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-fork-jobs-"));
    const output = path.join(directory, "github-output");
    const summary = path.join(directory, "summary.md");
    try {
      writeE2eWorkflowPlanCiOutput(
        { jobs: "managed-image-protected-runtime" },
        {
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          NEMOCLAW_E2E_CREDENTIALS_ALLOWED: "false",
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
        },
      );

      const outputLines = readFileSync(output, "utf8").split("\n");
      expect(outputLines).toEqual(
        expect.arrayContaining([
          'selected_jobs=["managed-image-protected-runtime"]',
          "hermes_selected=false",
        ]),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("classifies only standard-profile targets as credential-free PR candidates", () => {
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

  it("routes homogeneous GPU targets through the standard workflow matrix", () => {
    const targetIds = ["gpu-double-onboard", "gpu-e2e", "llama-cpp-generic-gpu"];
    const expectedRunner = "linux-amd64-gpu-rtxpro6000-latest-1";
    const plan = buildE2eWorkflowPlan({ jobs: targetIds.join(",") });

    expect(plan.catalogueMatrices.standard).toEqual(
      targetIds.map((id) => expect.objectContaining({ id, runner: expectedRunner })),
    );
    expect(plan.catalogueMatrices.standard.find((row) => row.id === "gpu-e2e")).not.toHaveProperty(
      "selector",
    );
    expect(selectedWorkflowJobs(plan)).toEqual(["catalogue-standard"]);
  });

  it("selects the complete GPU reply target when its Hermes helper changes", () => {
    const plan = buildE2eWorkflowPlan(
      {},
      { changedFiles: ["test/e2e/live/hermes-cli-adapter-live.ts"] },
    );

    expect(plan.catalogueMatrices.standard.map((row) => row.id)).toEqual(["gpu-e2e"]);
    expect(selectedWorkflowJobs(plan)).toEqual(["catalogue-standard", "jetson-nvmap-gpu"]);
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

  it("selects only the catalogue Personal public-fetch owner for an assertion change", () => {
    const plan = buildE2eWorkflowPlan(
      {},
      { changedFiles: ["test/e2e/live/openclaw-agent-assertion.ts"] },
    );

    expect(plan.matrix.map((row) => row.id)).not.toContain("ubuntu-repo-cloud-openclaw");
    expect(plan.catalogueMatrices["nvidia-inference"].map((row) => row.id)).toContain(
      "common-egress-agent-openclaw-personal-public-fetch",
    );
  });

  it("maps the trusted main Personal stock selector to the candidate public-fetch target", () => {
    const legacyId = "common-egress-agent-openclaw-personal-stock-price";
    const canonicalId = "common-egress-agent-openclaw-personal-public-fetch";
    const target = catalogueTarget(legacyId);
    const plan = buildE2eWorkflowPlan({ targets: legacyId });

    expect(target).toMatchObject({
      id: canonicalId,
      selector: "^common-egress.+C4.+$",
      shard: "openclaw-personal-public-fetch",
      testFile: "test/e2e/live/common-egress-agent.test.ts",
    });
    expect(plan.catalogueMatrices["nvidia-inference"].map((row) => row.id)).toEqual([canonicalId]);
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
      runtimeProvidersByJob: {
        ...fullPlan.runtimeProvidersByJob,
        "jetson-nvmap-gpu": ["none"],
      },
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

  it("selects the full messaging proof set for messaging runtime changes", () => {
    const plan = buildE2eWorkflowPlan(
      {},
      { changedFiles: ["src/lib/messaging/applier/agent-config.ts"] },
    );

    expect(plan.catalogueMatrices.standard.map((row) => row.id)).toContain("channels-add-remove");
    expect(plan.catalogueMatrices["nvidia-inference"].map((row) => row.id)).toEqual(
      expect.arrayContaining([
        "channels-stop-start-openclaw",
        "channels-stop-start-hermes",
        "hermes-discord",
        "openclaw-discord-pairing",
        "openclaw-slack-pairing",
      ]),
    );
    expect(plan.selectedJobs).toContain("messaging-providers");
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
      const result = spawnSync(process.execPath, [...PLANNER_CLI_PREFIX, "--ci-output"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          JOBS: "launchable-smoke",
          NEMOCLAW_E2E_CREDENTIALS_ALLOWED: "true",
          TARGETS: "",
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
        },
        timeout: 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(expectedWorkflowPlanCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(
        renderE2eWorkflowPlanSummary(plan, { includeCoverageAudit: false }),
      );
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
      const result = spawnSync(process.execPath, [...PLANNER_CLI_PREFIX, "--ci-output"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          INFERENCE_MODE: "mock",
          JOBS: [activeJobs, ...retiredControllerSelectorIds()].join(","),
          NEMOCLAW_E2E_CREDENTIALS_ALLOWED: "true",
          TARGETS: "",
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
        },
        timeout: 30_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(expectedWorkflowPlanCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(
        renderE2eWorkflowPlanSummary(plan, { includeCoverageAudit: false }),
      );
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
        gatewayRuntimes: ["docker"],
        matrix: [],
        testMatrix: [],
        catalogueMatrices: {
          standard: [],
          "nvidia-api": [],
          "nvidia-inference": [],
          "github-read": [],
          "brave-nvidia-inference": [],
        },
        coverageMatrix: [],
        selectedJobs: [],
        runtimeProvidersByJob: {},
        hermesSelected: false,
        explicitOnlyJobs: readFreeStandingJobsInventory().explicitOnlyJobs,
      };
      try {
        const result = spawnSync(process.execPath, [...PLANNER_CLI_PREFIX, "--ci-output"], {
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
        expect(readFileSync(output, "utf8")).toBe(expectedWorkflowPlanCiOutput(plan));
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
        gatewayRuntimes: ["docker"],
        matrix: [],
        testMatrix: [],
        catalogueMatrices: {
          standard: [],
          "nvidia-api": [],
          "nvidia-inference": [],
          "github-read": [],
          "brave-nvidia-inference": [],
        },
        coverageMatrix: [],
        selectedJobs: ["jetson-nvmap-gpu"],
        runtimeProvidersByJob: { "jetson-nvmap-gpu": ["none"] },
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
      gatewayRuntimes: ["docker"],
      matrix: [],
      testMatrix: [],
      catalogueMatrices: {
        standard: [],
        "nvidia-api": [],
        "nvidia-inference": [],
        "github-read": [],
        "brave-nvidia-inference": [],
      },
      coverageMatrix: [],
      selectedJobs: [],
      runtimeProvidersByJob: {},
      hermesSelected: false,
      explicitOnlyJobs: readFreeStandingJobsInventory().explicitOnlyJobs,
    };
    try {
      const result = spawnSync(process.execPath, [...PLANNER_CLI_PREFIX, "--ci-output"], {
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
      expect(readFileSync(output, "utf8")).toBe(expectedWorkflowPlanCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(renderE2eWorkflowPlanSummary(plan));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects the retired bootstrap job outside a PR controller checkout", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-workflow-plan-cli-"));
    try {
      const result = spawnSync(process.execPath, [...PLANNER_CLI_PREFIX, "--ci-output"], {
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
    const [coverageRow] = validPlan.coverageMatrix;
    expect(registryRow).toBeDefined();
    expect(testRow).toBeDefined();
    expect(coverageRow).toBeDefined();
    const { timeout_minutes: _timeoutMinutes, ...registryRowWithoutTimeout } = registryRow!;
    const { explicitOnlyJobs: _omitted, ...missingField } = validPlan;
    const malformedPlans = [
      missingField,
      { ...validPlan, matrix: [...validPlan.matrix, { ...registryRow }] },
      {
        ...validPlan,
        matrix: [registryRowWithoutTimeout, ...validPlan.matrix.slice(1)],
      },
      {
        ...validPlan,
        matrix: validPlan.matrix.map((row, index) =>
          index === 0 ? { ...row, timeout_minutes: 0 } : row,
        ),
      },
      {
        ...validPlan,
        matrix: validPlan.matrix.map((row, index) =>
          index === 0 ? { ...row, timeout_minutes: 1.5 } : row,
        ),
      },
      { ...validPlan, testMatrix: [{ ...testRow, id: "invalid_id" }] },
      {
        ...validPlan,
        testMatrix: [{ ...testRow, project: "e2e-live", file: "test/e2e/live/../secret.test.ts" }],
      },
      { ...validPlan, testMatrix: [{ ...testRow, id: registryRow.id }] },
      { ...validPlan, coverageMatrix: [...validPlan.coverageMatrix, { ...coverageRow }] },
      {
        ...validPlan,
        coverageMatrix: [
          { ...coverageRow, observableOutcome: "Injected | Markdown row" },
          ...validPlan.coverageMatrix.slice(1),
        ],
      },
      { ...validPlan, hermesSelected: "false" },
    ];

    malformedPlans.forEach((plan) => {
      expect(() => validateE2eWorkflowPlan(plan)).toThrow(
        "E2E planner returned an invalid output schema",
      );
    });
  });

  it("rejects execution coverage that differs from its execution owner (#9167)", () => {
    const plan = buildE2eWorkflowPlan({ jobs: "cloud-inference" });
    const coverageMatrix = plan.coverageMatrix.map((row) =>
      row.id === "cloud-inference" ? { ...row, observableOutcome: "Different valid outcome" } : row,
    );

    expect(() => validateE2eWorkflowPlan({ ...plan, coverageMatrix })).toThrow(
      "execution coverage that does not match its execution plan",
    );
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

      expect(readFileSync(output, "utf8")).toBe(expectedWorkflowPlanCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(
        renderE2eWorkflowPlanSummary(plan, { includeCoverageAudit: false }),
      );
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

  it("rejects an unsupported gateway runtime before writing CI output", () => {
    expect(() =>
      writeE2eWorkflowPlanCiOutput(
        {},
        {
          INFERENCE_MODE: "mock",
          NEMOCLAW_GATEWAY_RUNTIME: "containerd",
        },
      ),
    ).toThrow("Invalid gateway runtimes: containerd");
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
      "gatewayRuntimes",
      "matrix",
      "testMatrix",
      "catalogueMatrices",
      "selectedJobs",
      "runtimeProvidersByJob",
      "hermesSelected",
      "explicitOnlyJobs",
      "coverageMatrix",
    ]);
    expect(output).toBe(`${JSON.stringify(parsed)}\n`);
  });

  it("renders the selected targets and workflow jobs as a readable plan", () => {
    const filtered = spawnSync(
      process.execPath,
      [...PLANNER_CLI_PREFIX, "--summary", "--jobs", "hermes-e2e"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(filtered.status, filtered.stderr).toBe(0);
    expect(filtered.stdout).toBe(`## E2E Execution Plan

| Target or job | Agent runtime | Observable outcome | Environment or inference endpoint | Source | Unresolved reason |
| --- | --- | --- | --- | --- | --- |
| \`hermes-e2e / docker\` | hermes | Install onboarding health inference lifecycle dashboard and security succeed | Ubuntu; mock or NVIDIA hosted inference | retained-workflow |  |
`);

    const complete = spawnSync(process.execPath, [...PLANNER_CLI_PREFIX, "--summary"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(complete.status, complete.stderr).toBe(0);
    expect(complete.stdout).toContain(
      "| `cloud-onboard / docker` | openclaw | Public install onboarding hosted inference and security checks succeed | Ubuntu; NVIDIA hosted inference | retained-workflow |  |",
    );
    expect(complete.stdout).toContain(
      "| `ubuntu-repo-cloud-openclaw / docker` | openclaw | Repository install onboarding and hosted inference succeed | Ubuntu managed-runtime host; NVIDIA hosted inference | typed-registry |  |",
    );
    expect(complete.stdout).toContain(
      "| `vllm-docker-storage / docker` | none | vLLM storage gate accepts and rejects the intended host states | Native Linux Docker host; no inference endpoint | shared-e2e |  |",
    );
    expect(complete.stdout).toContain(
      "| `channels-add-remove / default-docker` | openclaw | Messaging: adds and removes Telegram configuration | Ubuntu; no inference endpoint | catalogue |  |",
    );
    expect(complete.stdout).toContain(
      "| `model-router-provider-routed-inference / default-docker` | openclaw | Inference: Model Router returns a provider-routed response | Ubuntu; NVIDIA API and Model Router | catalogue |  |",
    );
    expect(complete.stdout).toContain(
      "| `spark-install / default-runtime-agnostic` | unresolved | Install: leaves NemoClaw and OpenShell usable after standard installation | Ubuntu; NVIDIA hosted inference | catalogue | The test asserts CLI usability but does not assert an agent runtime |",
    );
    expect(complete.stdout).toContain("### Repeated outcomes with distinct evidence");
    expect(complete.stdout).toContain(
      "| Repository install onboarding and hosted inference succeed | `ubuntu-repo-cloud-langchain-deepagents-code / docker`, `ubuntu-repo-cloud-openclaw / docker` | agent runtime and environment or inference endpoint |",
    );
    expect(complete.stdout).toContain("### Intentional exclusions");
    expect(complete.stdout).toContain(
      "| `llama-cpp-dgx-spark-qualification` | unresolved | Exact NemoClaw-built llama.cpp image produces protected DGX Spark evidence | NVIDIA DGX Spark GB10; local llama.cpp inference | Explicit dispatch only; excluded from the default release matrix | The protected plan can enable or skip its OpenClaw subqualification |",
    );
    expect(complete.stdout).toContain("### Unsupported or unresolved typed declarations");
    const inertDeclarationCount = listTargets().filter(
      (target) => !liveTargetSupport(target).supported,
    ).length;
    expect(complete.stdout).toContain(
      `The ${inertDeclarationCount} inert typed declarations above`,
    );
    expect(complete.stdout).toContain(
      "| `brev-launchable-cloud-openclaw` | unresolved | unresolved | unresolved | platform 'brev-launchable' is not wired for live fixtures; install 'launchable' is not wired for live fixtures |",
    );
    expect(complete.stdout).toContain("#8285");
    expect(complete.stdout).toContain("#8286");
  });

  it("keeps CI and readable summary output modes separate", () => {
    expect(() => runE2eWorkflowPlanCli(["--ci-output", "--summary"])).toThrow(
      "--ci-output and --summary cannot be combined",
    );
  });

  it("reports CLI failures as workflow annotations", () => {
    const result = spawnSync(
      process.execPath,
      [...PLANNER_CLI_PREFIX, "--jobs", "hermes-e2e", "--targets", "definitely-unknown-e2e-target"],
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
      const result = spawnSync(process.execPath, [...PLANNER_CLI_PREFIX, "--ci-output"], {
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
      expect(readFileSync(output, "utf8")).toBe(expectedWorkflowPlanCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(
        renderE2eWorkflowPlanSummary(plan, { includeCoverageAudit: false }),
      );
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
      const result = spawnSync(process.execPath, [...PLANNER_CLI_PREFIX, "--ci-output"], {
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
      expect(readFileSync(output, "utf8")).toBe(expectedWorkflowPlanCiOutput(plan));
      expect(readFileSync(summary, "utf8")).toBe(
        renderE2eWorkflowPlanSummary(plan, { includeCoverageAudit: false }),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
