// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  buildRiskPlan,
  GATEWAY_TOPOLOGY_FILES,
  isPrE2eManualControllerJob,
  PR_E2E_TYPED_TARGET_IDS,
  RISK_RULES,
  riskPlanRequiredJobIds,
  riskPlanRequiredTargetIds,
} from "../tools/advisors/risk-plan.mts";
import {
  catalogueTargetsForChangedFiles,
  E2E_TARGET_CATALOGUE,
} from "../tools/e2e/target-catalogue.mts";
import {
  focusedE2eJobsForChangedFiles,
  readFreeStandingJobsInventory,
} from "../tools/e2e/workflow-boundary.mts";
import { classifyTestDepth } from "../tools/pr-review-advisor/deterministic-context.mts";

const HEAD_SHA = "a".repeat(40);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const GATEWAY_TOPOLOGY_INVARIANT =
  "An explicit sandbox-visible host address must be outside the sandbox network subnet, and every gateway-address projection must derive from the same authority.";
const HERMES_SANDBOX_BOUNDARY_JOBS = [
  "full-e2e",
  "hermes-e2e",
  "hermes-inference-switch",
  "managed-image-multiarch-startup",
  "security-posture",
];
const HERMES_CLI_ADAPTER_JOBS = ["channels-stop-start", "mcp-bridge"];
const HERMES_CRON_RESTORE_FILES = [
  "agents/hermes/cron-restore-control.py",
  "agents/hermes/patch-cron-restore-drain.py",
  "src/lib/actions/sandbox/rebuild-hermes-post-restore.ts",
  "src/lib/actions/sandbox/runtime/hermes-cron-restore-recovery.ts",
];
const HERMES_MANAGED_POLICY_JOBS = [
  "bedrock-runtime-compatible-anthropic",
  "channels-stop-start",
  "dashboard-remote-bind",
  "hermes-e2e",
  "hermes-inference-switch",
  "hermes-shields-config",
  "security-posture",
];
const HERMES_CLI_ADAPTER_REQUIRED_JOBS = [
  ...HERMES_SANDBOX_BOUNDARY_JOBS,
  ...HERMES_CLI_ADAPTER_JOBS,
];
const HERMES_MANAGED_POLICY_REQUIRED_JOBS = [
  ...HERMES_SANDBOX_BOUNDARY_JOBS,
  "bedrock-runtime-compatible-anthropic",
  "channels-stop-start",
  "dashboard-remote-bind",
  "hermes-shields-config",
];
const HERMES_WRAPPER_FOCUSED_JOBS = [
  "bedrock-runtime-compatible-anthropic",
  "channels-stop-start",
  "dashboard-remote-bind",
  "hermes-e2e",
  "hermes-inference-switch",
  "hermes-shields-config",
  "mcp-bridge",
  "security-posture",
];
const HERMES_WRAPPER_REQUIRED_JOBS = [...HERMES_MANAGED_POLICY_REQUIRED_JOBS, "mcp-bridge"];
const HERMES_MANAGED_POLICY_FILES = [
  "agents/hermes/config/managed-policy.ts",
  "agents/hermes/hermes-wrapper.py",
  "agents/hermes/image-build-probes.py",
  "agents/hermes/managed_policy.py",
  "agents/hermes/patch-profile-policy-defaults.py",
  "agents/hermes/seed-dashboard-config.py",
  "agents/hermes/start.sh",
  "src/lib/hermes-managed-route.ts",
];

function plan(...changedFiles: string[]) {
  return buildRiskPlan({ headSha: HEAD_SHA, changedFiles });
}

describe("deterministic PR risk plan", () => {
  it.each([
    "inference-routing",
    "managed-image-protected-runtime",
  ])("classifies the controller-accepted %s job for the commit under review", (jobId) => {
    expect(isPrE2eManualControllerJob(jobId)).toBe(true);
  });

  it.each([
    "cloud-inference",
    "security-posture",
    "network-policy",
    "jetson-nvmap-gpu",
  ])("classifies %s as manual-only when the controller rejects the job", (jobId) => {
    expect(isPrE2eManualControllerJob(jobId)).toBe(false);
  });

  it("emits a stable plan and digest for equivalent inputs", () => {
    const first = plan("src/lib/state/registry.ts", "src/lib/onboard.ts");
    const second = plan("src/lib/onboard.ts", "src/lib/state/registry.ts");

    expect(first).toEqual(second);
    expect(first.version).toBe(19);
    expect(first.headSha).toBe(HEAD_SHA);
    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.changedFiles).toEqual(["src/lib/onboard.ts", "src/lib/state/registry.ts"]);
  });

  it("does not require runtime E2E for docs and ordinary tests", () => {
    const result = plan("docs/get-started/quickstart.mdx", "test/onboard.test.ts");

    expect(result.tier).toBe(0);
    expect(result.families).toEqual([]);
    expect(result.requiredJobs).toEqual([]);
    expect(result.requiredTargets).toEqual([]);
  });

  it.each(GATEWAY_TOPOLOGY_FILES)(
    "selects gateway topology review for %s (#10058)",
    (changedFile) => {
      const result = plan(changedFile);

      expect(result.families).toContainEqual({
        id: "gateway-topology",
        summary:
          "Gateway topology changes must keep sandbox-visible host addresses outside sandbox network subnets and use one address authority.",
        tier: 2,
        matchedFiles: [changedFile],
        invariants: [GATEWAY_TOPOLOGY_INVARIANT],
        requiredJobs: [],
        requiredTargets: [],
      });
    },
  );

  it("combines gateway topology projections into one focused family (#10058)", () => {
    const result = plan(...GATEWAY_TOPOLOGY_FILES);
    const topologyFamilies = result.families.filter(
      (family) => family.id === "gateway-topology",
    );

    expect(topologyFamilies).toEqual([
      expect.objectContaining({
        matchedFiles: GATEWAY_TOPOLOGY_FILES,
        invariants: [GATEWAY_TOPOLOGY_INVARIANT],
        requiredJobs: [],
      }),
    ]);
  });

  it.each([
    "src/lib/onboard/experimental/hermes-portable-build-context.ts",
    "src/lib/onboard/experimental/portable-agent-lifecycle.ts",
    "docs/get-started/portable.mdx",
    "src/lib/onboard/experimental/portable-host-preparation.test.ts",
    "src/lib/onboard/runtime-provider/podman-host-local-inference.test.ts",
  ])("keeps gateway topology review scoped away from %s (#10058)", (changedFile) => {
    const result = plan(changedFile);

    expect(result.families).not.toContainEqual(
      expect.objectContaining({ id: "gateway-topology" }),
    );
  });

  it("keeps an unmapped live test behind the control-plane exception and cloud floor (#6446)", () => {
    const result = plan("test/e2e/live/full.test.ts");

    expect(result.families.map((family) => family.id)).toEqual(["e2e-control-plane"]);
    expect(riskPlanRequiredJobIds(result)).toEqual([
      "cloud-inference",
      "cloud-onboard",
      "security-posture",
    ]);
  });

  it("maps a catalogue live test only to its canonical target (#7921)", () => {
    const changedFiles = ["test/e2e/live/token-rotation.test.ts"];
    const focusedE2eJobs = catalogueTargetsForChangedFiles(changedFiles).map((target) => ({
      id: target.id,
      matchedFiles: changedFiles,
    }));
    const result = buildRiskPlan({ headSha: HEAD_SHA, changedFiles, focusedE2eJobs });
    const withoutFocusedSelection = buildRiskPlan({ headSha: HEAD_SHA, changedFiles });

    expect(focusedE2eJobs).toEqual([
      {
        id: "token-rotation",
        matchedFiles: ["test/e2e/live/token-rotation.test.ts"],
      },
    ]);
    expect(result.families).toContainEqual(
      expect.objectContaining({
        id: "focused-e2e",
        matchedFiles: ["test/e2e/live/token-rotation.test.ts"],
        requiredJobs: ["token-rotation"],
      }),
    );
    expect(result.requiredJobs).toContainEqual(
      expect.objectContaining({
        id: "token-rotation",
        families: ["focused-e2e"],
        matchedFiles: ["test/e2e/live/token-rotation.test.ts"],
      }),
    );
    expect(riskPlanRequiredJobIds(result)).toEqual(["token-rotation"]);
    expect(result.families.map((family) => family.id)).toEqual(["focused-e2e"]);
    expect(result.planHash).not.toBe(withoutFocusedSelection.planHash);
  });

  it("selects startup and auth E2E for managed startup delivery changes (#8016)", () => {
    const changedFiles = [
      "scripts/lib/entrypoint-env-wrapper.sh",
      "src/lib/onboard/managed-startup/agent-environment.ts",
      "src/lib/onboard/sandbox-create-launch.ts",
    ];
    const result = plan(...changedFiles);
    const adjacentOnboardChange = plan("src/lib/onboard/provider-selection.ts");

    expect(result.families).toContainEqual(
      expect.objectContaining({
        id: "focused-e2e",
        matchedFiles: changedFiles,
        requiredJobs: [
          "device-auth-health",
          "issue-4462-scope-upgrade-approval",
          "openclaw-inference-switch",
        ],
      }),
    );
    expect(riskPlanRequiredJobIds(result)).toEqual(
      expect.arrayContaining([
        "device-auth-health",
        "issue-4462-scope-upgrade-approval",
        "openclaw-inference-switch",
      ]),
    );
    expect(riskPlanRequiredJobIds(adjacentOnboardChange)).toEqual([
      "onboard-repair",
      "onboard-resume",
    ]);
  });

  it.each([
    "agents/hermes/hermes-cli-adapter-v1.json",
    "agents/hermes/hermes-wrapper.py",
    "agents/hermes/validate-cli-adapter.py",
  ])("selects Hermes MCP and channel lifecycle E2E for %s (#8011)", (changedFile) => {
    const result = plan(changedFile);
    const isWrapper = changedFile === "agents/hermes/hermes-wrapper.py";
    const expectedFocusedJobs = isWrapper ? HERMES_WRAPPER_FOCUSED_JOBS : HERMES_CLI_ADAPTER_JOBS;
    const expectedRequiredJobs = isWrapper
      ? HERMES_WRAPPER_REQUIRED_JOBS
      : HERMES_CLI_ADAPTER_REQUIRED_JOBS;

    const focusedFamily = result.families.find((family) => family.id === "focused-e2e");
    expect(focusedFamily).toEqual(
      expect.objectContaining({
        matchedFiles: [changedFile],
        requiredJobs: expectedFocusedJobs,
      }),
    );
    expect(riskPlanRequiredJobIds(result)).toEqual(expectedRequiredJobs);
  });

  it.each(
    HERMES_CRON_RESTORE_FILES,
  )("selects Hermes rebuild E2E for cron restore and drain changes in %s (#7806)", (changedFile) => {
    const result = plan(changedFile);
    const expectedRequiredJobs = changedFile.startsWith("agents/hermes/")
      ? [...HERMES_SANDBOX_BOUNDARY_JOBS, "rebuild-hermes"]
      : changedFile === "src/lib/actions/sandbox/rebuild-hermes-post-restore.ts"
        ? [
            "managed-image-multiarch-startup",
            "managed-image-protected-runtime",
            "onboard-repair",
            "onboard-resume",
            "rebuild-hermes",
            "rebuild-openclaw",
            "state-backup-restore",
          ]
        : [
            "onboard-repair",
            "onboard-resume",
            "rebuild-hermes",
            "rebuild-openclaw",
            "state-backup-restore",
          ];

    expect(result.families).toContainEqual(
      expect.objectContaining({
        id: "focused-e2e",
        matchedFiles: [changedFile],
        requiredJobs: ["rebuild-hermes"],
      }),
    );
    expect(riskPlanRequiredJobIds(result)).toEqual(expectedRequiredJobs);
  });

  it("does not select Hermes rebuild E2E for the generic recovery command (#7806)", () => {
    const result = plan("src/commands/sandbox/recover.ts");

    expect(result.families).not.toContainEqual(expect.objectContaining({ id: "focused-e2e" }));
    expect(riskPlanRequiredJobIds(result)).not.toContain("rebuild-hermes");
  });

  it.each(
    HERMES_MANAGED_POLICY_FILES,
  )("selects every Hermes managed-policy live E2E job for %s (#8008)", (changedFile) => {
    const result = plan(changedFile);
    const isWrapper = changedFile === "agents/hermes/hermes-wrapper.py";
    const expectedFocusedJobs = isWrapper
      ? HERMES_WRAPPER_FOCUSED_JOBS
      : HERMES_MANAGED_POLICY_JOBS;
    const expectedRequiredJobs = isWrapper
      ? HERMES_WRAPPER_REQUIRED_JOBS
      : changedFile === "src/lib/hermes-managed-route.ts"
        ? HERMES_MANAGED_POLICY_JOBS
        : HERMES_MANAGED_POLICY_REQUIRED_JOBS;

    const focusedFamily = result.families.find((family) => family.id === "focused-e2e");
    expect(focusedFamily).toEqual(
      expect.objectContaining({
        matchedFiles: [changedFile],
        requiredJobs: expectedFocusedJobs,
      }),
    );
    expect(riskPlanRequiredJobIds(result)).toEqual(expectedRequiredJobs);
  });

  it("does not select managed-policy E2E for an unrelated Hermes runtime file (#8008)", () => {
    const result = plan("agents/hermes/runtime-version.py");

    expect(result.families).not.toContainEqual(expect.objectContaining({ id: "focused-e2e" }));
    expect(riskPlanRequiredJobIds(result)).toEqual([
      "full-e2e",
      "hermes-e2e",
      "hermes-inference-switch",
      "managed-image-multiarch-startup",
      "security-posture",
    ]);
  });

  it("combines CLI adapter and managed-policy E2E for the Hermes wrapper (#8011)", () => {
    const result = plan("agents/hermes/hermes-wrapper.py");

    expect(result.families).toContainEqual(
      expect.objectContaining({
        id: "focused-e2e",
        matchedFiles: ["agents/hermes/hermes-wrapper.py"],
        requiredJobs: HERMES_WRAPPER_FOCUSED_JOBS,
      }),
    );
    expect(riskPlanRequiredJobIds(result)).toEqual(HERMES_WRAPPER_REQUIRED_JOBS);
  });
  it("leaves E2E support-only changes in the fast e2e-support project (#7921)", () => {
    const changedFiles = ["test/e2e/support/workflow-plan.test.ts"];
    const focusedE2eJobs = focusedE2eJobsForChangedFiles(changedFiles);
    const result = buildRiskPlan({ headSha: HEAD_SHA, changedFiles, focusedE2eJobs });

    expect(focusedE2eJobs).toEqual([]);
    expect(result.tier).toBe(0);
    expect(result.families).toEqual([]);
    expect(result.requiredJobs).toEqual([]);
  });

  it("maps a shared gateway live test to every catalogue fixture (#7921)", () => {
    const changedFiles = ["test/e2e/live/openshell-gateway-upgrade.test.ts"];
    const focusedE2eJobs = catalogueTargetsForChangedFiles(changedFiles).map((target) => ({
      id: target.id,
      matchedFiles: changedFiles,
    }));
    const result = buildRiskPlan({ headSha: HEAD_SHA, changedFiles, focusedE2eJobs });

    const expectedTargets = E2E_TARGET_CATALOGUE.filter(
      (target) => target.targetId === "openshell-gateway-upgrade",
    ).map((target) => target.id);
    expect(focusedE2eJobs.map((selection) => selection.id)).toEqual(expectedTargets);
    expect(riskPlanRequiredJobIds(result)).toEqual([...expectedTargets].sort());
  });

  it("keeps an unknown live test behind the broad control-plane floor (#7921)", () => {
    const changedFiles = ["test/e2e/live/new-retained-journey.test.ts"];
    const focusedE2eJobs = focusedE2eJobsForChangedFiles(changedFiles);
    const result = buildRiskPlan({ headSha: HEAD_SHA, changedFiles, focusedE2eJobs });

    expect(focusedE2eJobs).toEqual([]);
    expect(riskPlanRequiredJobIds(result)).toEqual([
      "cloud-inference",
      "cloud-onboard",
      "security-posture",
    ]);
    expect(result.families.map((family) => family.id)).toEqual(["e2e-control-plane"]);
  });

  it("keeps a renamed live test broad until the new path has an owning job (#7921)", () => {
    const changedFiles = [
      "test/e2e/live/token-rotation.test.ts",
      "test/e2e/live/token-rotation-renamed.test.ts",
    ];
    const focusedE2eJobs = catalogueTargetsForChangedFiles(changedFiles).map((target) => ({
      id: target.id,
      matchedFiles: changedFiles.filter((file) => target.owningPaths.includes(file)),
    }));
    const result = buildRiskPlan({ headSha: HEAD_SHA, changedFiles, focusedE2eJobs });

    expect(focusedE2eJobs).toEqual([
      {
        id: "token-rotation",
        matchedFiles: ["test/e2e/live/token-rotation.test.ts"],
      },
    ]);
    expect(riskPlanRequiredJobIds(result)).toEqual([
      "cloud-inference",
      "cloud-onboard",
      "security-posture",
      "token-rotation",
    ]);
    expect(
      result.families.find((family) => family.id === "e2e-control-plane")?.matchedFiles,
    ).toEqual(["test/e2e/live/token-rotation-renamed.test.ts"]);
  });

  it("keeps a shared E2E workflow change behind the broad control-plane floor (#7921)", () => {
    const result = plan(".github/workflows/e2e.yaml");

    expect(riskPlanRequiredJobIds(result)).toEqual([
      "cloud-inference",
      "cloud-onboard",
      "security-posture",
    ]);
    expect(result.families.map((family) => family.id)).toEqual([
      "platform-install",
      "e2e-control-plane",
    ]);
  });

  it("activates protected multiarch qualification for every managed-image build input (#7744)", () => {
    const activation = "ci/protected-managed-image-multiarch-activation-v1.json";
    const managedImageInputs = [
      activation,
      ".github/workflows/managed-images.yaml",
      "Dockerfile",
      "agents/hermes/Dockerfile",
      "agents/langchain-deepagents-code/Dockerfile",
      "scripts/checks/run-managed-image-direct-e2e.ts",
      "src/lib/actions/sandbox/mcp-bridge-adapter-openclaw.ts",
      "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.106.json",
      "src/lib/onboard/managed-startup/image-runtime.ts",
    ];
    const result = plan(...managedImageInputs);
    const adjacentOnboardChange = plan("src/lib/onboard/provider-selection.ts");

    expect(result.families).toContainEqual(
      expect.objectContaining({
        id: "managed-image-multiarch",
        matchedFiles: [...managedImageInputs].sort((left, right) => left.localeCompare(right)),
        requiredJobs: ["managed-image-multiarch-startup"],
      }),
    );
    expect(riskPlanRequiredJobIds(result)).toContain("managed-image-multiarch-startup");
    expect(riskPlanRequiredJobIds(plan(activation))).toEqual(["managed-image-multiarch-startup"]);
    expect(
      adjacentOnboardChange.families.some((family) => family.id === "managed-image-multiarch"),
    ).toBe(false);
  });

  it.each([
    ".github/workflows/managed-images.yaml",
    ".dockerignore",
    "Dockerfile",
    "agents/hermes/Dockerfile",
    "ci/npm-audit-exceptions.json",
    "nemoclaw/src/index.ts",
    "nemoclaw-blueprint/blueprint.yaml",
    "scripts/checks/build-protected-managed-images.sh",
    "src/lib/actions/sandbox/mcp-bridge-adapter-openclaw.ts",
    "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.106.json",
    "src/lib/core/json-types.ts",
    "src/lib/core/ports.ts",
    "src/lib/messaging/runtime.ts",
    "src/lib/onboard/managed-bootstrap/envelope.ts",
    "src/lib/onboard/managed-startup/image-runtime.ts",
    "src/lib/security/credential-hash.ts",
    "src/lib/state/paths.ts",
    "src/lib/state/state-root.ts",
    "src/lib/tool-disclosure.ts",
    "tools/mcp-tool-discovery-runtime/index.ts",
    "tsconfig.runtime-preloads.json",
  ])("selects protected multiarch qualification for managed-image input %s (#7744)", (file) => {
    expect(riskPlanRequiredJobIds(plan(file))).toContain("managed-image-multiarch-startup");
  });

  it("does not select protected multiarch qualification for adjacent changes (#7744)", () => {
    expect(
      plan(
        ".github/workflows/e2e.yaml",
        "docs/get-started/quickstart.mdx",
        "src/lib/onboard/provider-selection.ts",
      ).families.some((family) => family.id === "managed-image-multiarch"),
    ).toBe(false);
  });

  it("selects protected GPU, local-inference, and multiarch qualification for activated runtime inputs (#7744)", () => {
    const activation = "ci/protected-managed-image-runtime-activation-v1.json";
    const result = plan(activation);
    const activatedImplementation = plan(
      "scripts/checks/run-managed-image-openshell-e2e.ts",
      "src/lib/onboard/managed-bootstrap/docker.ts",
      "src/lib/onboard/managed-workload/onboard-orchestration.ts",
      "test/e2e/live/managed-image-protected-runtime.test.ts",
    );

    expect(result.families).toContainEqual(
      expect.objectContaining({
        id: "managed-image-protected-runtime",
        matchedFiles: [activation],
        requiredJobs: ["managed-image-protected-runtime", "managed-image-multiarch-startup"],
      }),
    );
    expect(riskPlanRequiredJobIds(result)).toEqual([
      "managed-image-multiarch-startup",
      "managed-image-protected-runtime",
    ]);
    expect(
      activatedImplementation.families.some(
        (family) => family.id === "managed-image-protected-runtime",
      ),
    ).toBe(true);
    expect(riskPlanRequiredJobIds(activatedImplementation)).toEqual(
      expect.arrayContaining([
        "managed-image-multiarch-startup",
        "managed-image-protected-runtime",
      ]),
    );
    expect(
      plan("src/lib/actions/sandbox/rebuilding-status.ts").families.some(
        (family) => family.id === "managed-image-protected-runtime",
      ),
    ).toBe(false);
  });

  it("keeps protected llama.cpp DGX Spark qualification activation-only until trusted (#8260)", () => {
    const activation = "ci/llama-cpp-dgx-spark-qualification-v1.yaml";
    const agentQualification =
      "managed-inference/qualifications/llama-cpp.openclaw.spark-single.v1.yaml";
    const result = plan(activation);
    const dormantImplementation = plan(
      "scripts/checks/run-llama-cpp-dgx-spark-qualification.mts",
      "test/e2e/live/llama-cpp-dgx-spark-qualification.test.ts",
    );

    expect(result.families).toContainEqual(
      expect.objectContaining({
        id: "llama-cpp-dgx-spark-qualification",
        matchedFiles: [activation],
        requiredJobs: ["llama-cpp-dgx-spark-qualification"],
      }),
    );
    expect(riskPlanRequiredJobIds(result)).toEqual(["llama-cpp-dgx-spark-qualification"]);
    expect(riskPlanRequiredJobIds(plan(agentQualification))).toContain(
      "llama-cpp-dgx-spark-qualification",
    );
    expect(
      riskPlanRequiredJobIds(
        plan("managed-inference/qualifications/llama-cpp.other.spark-single.v1.yaml"),
      ),
    ).not.toContain("llama-cpp-dgx-spark-qualification");
    expect(
      dormantImplementation.families.some(
        (family) => family.id === "llama-cpp-dgx-spark-qualification",
      ),
    ).toBe(false);
  });

  it("loads protected multiarch identifiers through the workflow node loader (#7744)", () => {
    const source = [
      'const risk = await import("./tools/advisors/risk-plan.mts");',
      'const boundary = await import("./tools/e2e/managed-image-multiarch-workflow-boundary.mts");',
      'const activation = "ci/protected-managed-image-multiarch-activation-v1.json";',
      'const job = "managed-image-multiarch-startup";',
      'const plan = risk.buildRiskPlan({ headSha: "a".repeat(40), changedFiles: [activation] });',
      'if (!plan.requiredJobs.some((value) => value.id === job)) throw new Error("risk plan loader contract failed");',
      'const errors = boundary.validateManagedImageMultiarchWorkflow({ jobs: { [job]: { steps: [{ name: "Validate candidate activation contract", run: "" }] } } });',
      'if (!errors.some((value) => value.includes(activation))) throw new Error("workflow boundary loader contract failed");',
      "console.log(JSON.stringify({ activation, job }));",
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      activation: "ci/protected-managed-image-multiarch-activation-v1.json",
      job: "managed-image-multiarch-startup",
    });
  });

  it("runs snapshot commands for restored-gateway pairing runtime changes (#7431)", () => {
    const runtimeFiles = [
      "src/lib/actions/sandbox/restore-gateway-pairing.ts",
      "src/lib/adapters/openshell/restore-gateway-pairing.ts",
    ];
    const changedFiles = [
      ...runtimeFiles,
      "src/lib/actions/sandbox/restore-gateway-pairing.test.ts",
    ];
    const focusedE2eJobs = focusedE2eJobsForChangedFiles(changedFiles);
    const result = buildRiskPlan({ headSha: HEAD_SHA, changedFiles, focusedE2eJobs });

    expect(focusedE2eJobs).toEqual([
      {
        id: "snapshot-commands",
        matchedFiles: runtimeFiles,
      },
    ]);
    expect(result.families).toContainEqual(
      expect.objectContaining({
        id: "focused-e2e",
        matchedFiles: runtimeFiles,
        requiredJobs: ["snapshot-commands"],
      }),
    );
    expect(result.requiredJobs).toContainEqual(
      expect.objectContaining({
        id: "snapshot-commands",
        families: ["focused-e2e"],
        matchedFiles: runtimeFiles,
      }),
    );
  });

  it("runs snapshot commands for restored-clone pairing approval changes (#7608)", () => {
    const runtimeFile = "src/lib/actions/sandbox/auto-pair-approval.ts";
    const changedFiles = [runtimeFile, "src/lib/actions/sandbox/auto-pair-approval.test.ts"];
    const focusedE2eJobs = focusedE2eJobsForChangedFiles(changedFiles);
    const result = buildRiskPlan({ headSha: HEAD_SHA, changedFiles, focusedE2eJobs });

    expect(focusedE2eJobs).toEqual([
      {
        id: "snapshot-commands",
        matchedFiles: [runtimeFile],
      },
    ]);
    expect(result.requiredJobs).toContainEqual(
      expect.objectContaining({
        id: "snapshot-commands",
        families: ["focused-e2e"],
        matchedFiles: [runtimeFile],
      }),
    );
  });

  it("hashes the Deep Agents headless check into its exact typed target", () => {
    const changedFile =
      "test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh";
    const result = plan(changedFile);
    const adjacentCheck = plan(
      "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
    );

    expect(PR_E2E_TYPED_TARGET_IDS).toEqual([
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "ubuntu-repo-docker-post-reboot-recovery",
    ]);
    expect(riskPlanRequiredTargetIds(result)).toEqual([PR_E2E_TYPED_TARGET_IDS[0]]);
    expect(result.requiredTargets).toEqual([
      expect.objectContaining({
        id: PR_E2E_TYPED_TARGET_IDS[0],
        families: ["focused-e2e"],
        matchedFiles: [changedFile],
      }),
    ]);
    expect(result.families).toContainEqual(
      expect.objectContaining({
        id: "focused-e2e",
        requiredTargets: [PR_E2E_TYPED_TARGET_IDS[0]],
      }),
    );
    expect(riskPlanRequiredTargetIds(adjacentCheck)).toEqual([]);
    expect(result.planHash).not.toBe(adjacentCheck.planHash);
  });

  it.each([
    "src/lib/onboard/machine/handlers/sandbox-resume.ts",
    "src/lib/onboard/machine/handlers/sandbox.ts",
  ])("selects gateway upgrade and the Deep Agents Code target for journaled recreation changes in %s", (file) => {
    const result = plan(file);

    expect(result.requiredJobs).toContainEqual(
      expect.objectContaining({
        id: "openshell-gateway-upgrade",
        families: ["focused-e2e"],
        matchedFiles: [file],
      }),
    );
    expect(result.requiredTargets).toContainEqual(
      expect.objectContaining({
        id: PR_E2E_TYPED_TARGET_IDS[0],
        families: ["focused-e2e"],
        matchedFiles: [file],
      }),
    );
  });

  it("does not select the journaled recreation lanes for an adjacent sandbox handler", () => {
    const result = plan("src/lib/onboard/machine/handlers/sandbox-messaging.ts");

    expect(riskPlanRequiredJobIds(result)).not.toContain("openshell-gateway-upgrade");
    expect(riskPlanRequiredTargetIds(result)).not.toContain(PR_E2E_TYPED_TARGET_IDS[0]);
  });

  it("selects the Deep Agents Code target for its managed runtime changes (#7463)", () => {
    const changedFiles = [
      "agents/langchain-deepagents-code/dependency-review.md",
      "agents/langchain-deepagents-code/patch-managed-deepagents-code.py",
      "test/langchain-deepagents-code-managed-model-params.test.ts",
      "test/langchain-deepagents-code-nemotron-profile-plugin.test.ts",
    ];
    const result = buildRiskPlan({ headSha: HEAD_SHA, changedFiles });
    const docsAndTestsOnly = plan(
      "agents/langchain-deepagents-code/dependency-review.md",
      "agents/langchain-deepagents-code/runtime-notes.mdx",
      "agents/langchain-deepagents-code/resolver.test.ts",
      "test/langchain-deepagents-code-managed-model-params.test.ts",
    );

    expect(riskPlanRequiredTargetIds(result)).toEqual([PR_E2E_TYPED_TARGET_IDS[0]]);
    expect(result.requiredTargets).toEqual([
      expect.objectContaining({
        id: PR_E2E_TYPED_TARGET_IDS[0],
        families: ["focused-e2e"],
        matchedFiles: ["agents/langchain-deepagents-code/patch-managed-deepagents-code.py"],
      }),
    ]);
    expect(result.tier).toBe(3);
    expect(riskPlanRequiredJobIds(result)).toContain("managed-image-multiarch-startup");
    expect(riskPlanRequiredTargetIds(docsAndTestsOnly)).toEqual([]);
  });

  it.each([
    "src/lib/actions/sandbox/status-snapshot.ts",
    "src/lib/onboard/docker-driver-sandbox-recovery.ts",
    "src/lib/onboard/docker-startup-command-agent.ts",
    "src/lib/onboard/sandbox-create-step.ts",
  ])("selects post-reboot recovery for Docker delivery changes in %s (#7824)", (changedFile) => {
    const result = plan(changedFile);
    const adjacentStatusFile = plan("src/lib/actions/sandbox/status-text.ts");

    expect(riskPlanRequiredTargetIds(result)).toEqual([PR_E2E_TYPED_TARGET_IDS[1]]);
    expect(result.requiredTargets).toEqual([
      expect.objectContaining({
        id: PR_E2E_TYPED_TARGET_IDS[1],
        families: ["focused-e2e"],
        matchedFiles: [changedFile],
      }),
    ]);
    expect(riskPlanRequiredTargetIds(adjacentStatusFile)).toEqual([]);
    expect(result.planHash).not.toBe(adjacentStatusFile.planHash);
  });

  it("selects post-reboot recovery when its shared timeout contract changes (#9622)", () => {
    const changedFile = "tools/e2e/onboard-timeout-contract.mts";
    const result = plan(changedFile);

    expect(riskPlanRequiredTargetIds(result)).toEqual([
      "ubuntu-repo-docker-post-reboot-recovery",
    ]);
    expect(result.requiredTargets).toEqual([
      expect.objectContaining({
        id: "ubuntu-repo-docker-post-reboot-recovery",
        families: ["focused-e2e"],
        matchedFiles: [changedFile],
      }),
    ]);
  });

  it("does not infer security or inference risk from unrelated path substrings", () => {
    const result = plan("src/lib/actions/sandbox/mcp-bridge-provider.ts", "src/lib/secretary.ts");

    expect(result.families.map((family) => family.id)).toEqual(
      expect.arrayContaining(["lifecycle-state", "shared-agent"]),
    );
    expect(result.families.map((family) => family.id)).not.toContain("credentials-security");
    expect(result.families.map((family) => family.id)).not.toContain("inference-policy");
    expect(riskPlanRequiredJobIds(result)).toEqual(
      expect.arrayContaining(["full-e2e", "hermes-e2e", "onboard-repair", "onboard-resume"]),
    );
  });

  it.each([
    "src/lib/actions/sandbox/connect-flow.ts",
    "src/lib/actions/sandbox/destroy-flow.ts",
    "src/lib/actions/sandbox/sessions/export.ts",
    "src/lib/actions/sandbox/terminal-connect-probe.ts",
  ])("keeps every sandbox action under the lifecycle-state floor: %s", (file) => {
    const result = plan(file);

    expect(result.families.map((family) => family.id)).toContain("lifecycle-state");
    expect(riskPlanRequiredJobIds(result)).toEqual(
      expect.arrayContaining(["onboard-repair", "onboard-resume"]),
    );
  });

  it.each([
    {
      file: "src/lib/onboard.ts",
      family: "lifecycle-state",
      jobs: ["onboard-resume", "onboard-repair"],
    },
    {
      file: "src/lib/actions/upgrade-sandboxes.ts",
      family: "upgrade-rebuild",
      jobs: ["rebuild-openclaw", "state-backup-restore"],
    },
    {
      file: "src/lib/actions/sandbox/agents/apply.ts",
      family: "shared-agent",
      jobs: ["full-e2e", "hermes-e2e"],
    },
    {
      file: "src/lib/inference/health.ts",
      family: "inference-policy",
      jobs: ["inference-routing", "network-policy"],
    },
    {
      file: "nemoclaw-blueprint/policies/presets/brew.yaml",
      family: "inference-policy",
      jobs: ["inference-routing", "network-policy"],
    },
    {
      file: "src/lib/messaging/applier/agent-config.ts",
      family: "messaging-lifecycle",
      jobs: ["channels-add-remove", "channels-stop-start"],
    },
    {
      file: "install.sh",
      family: "platform-install",
      jobs: ["cloud-onboard"],
    },
    {
      file: "src/lib/credentials/provider-list.ts",
      family: "credentials-security",
      jobs: ["cloud-inference", "security-posture"],
    },
  ])("maps $family changes to a reviewed E2E floor", ({ file, family, jobs }) => {
    const result = plan(file);

    expect(result.families.map((item) => item.id)).toContain(family);
    expect(riskPlanRequiredJobIds(result)).toEqual(expect.arrayContaining(jobs));
  });

  it("selects cold full E2E for repository-root OpenClaw image changes (#6660)", () => {
    const rootImage = plan("Dockerfile");
    const adjacentImage = plan("Dockerfile.base");

    expect(rootImage.families.map((family) => family.id)).toEqual([
      "platform-install",
      "openclaw-image",
      "managed-image-multiarch",
    ]);
    expect(riskPlanRequiredJobIds(rootImage)).toEqual([
      "cloud-onboard",
      "full-e2e",
      "managed-image-multiarch-startup",
    ]);
    expect(adjacentImage.families.map((family) => family.id)).toEqual(["platform-install"]);
    expect(riskPlanRequiredJobIds(adjacentImage)).toEqual(["cloud-onboard"]);
  });

  it.each([
    {
      file: "nemoclaw-blueprint/private-networks.yaml",
      families: ["inference-policy", "credentials-security"],
      jobs: ["inference-routing", "network-policy", "cloud-inference", "security-posture"],
    },
    {
      file: "nemoclaw/src/blueprint/private-networks.ts",
      families: ["inference-policy", "credentials-security"],
      jobs: ["inference-routing", "network-policy", "cloud-inference", "security-posture"],
    },
    {
      file: "src/lib/policy/managed-policy-binding.ts",
      families: ["inference-policy", "credentials-security"],
      jobs: ["inference-routing", "network-policy", "cloud-inference", "security-posture"],
    },
    {
      file: "src/lib/shields/verify-lock.ts",
      families: ["credentials-security"],
      jobs: ["cloud-inference", "security-posture"],
    },
  ])("keeps the $file security boundary in the deterministic floor", ({ file, families, jobs }) => {
    const result = plan(file);

    expect(result.families.map((family) => family.id)).toEqual(expect.arrayContaining(families));
    expect(riskPlanRequiredJobIds(result)).toEqual(expect.arrayContaining(jobs));
  });

  it.each([
    ".github/workflows/e2e.yaml",
    ".github/workflows/pr.yaml",
    ".github/actions/prepare-e2e/action.yaml",
    ".github/actions/upload-e2e-artifacts/action.yaml",
    "package-lock.json",
    "package.json",
    "vitest.config.ts",
    "scripts/scorecard/coordinate-scorecard.mts",
    "tools/advisors/github.mts",
    "tools/advisors/io.mts",
    "tools/advisors/risk-plan.mts",
    "tools/e2e/risk-signal.ts",
    "tools/e2e/private-file.mts",
    "tools/e2e/workflow-plan.mts",
    "tools/e2e/workflow-boundary.mts",
    "tools/e2e/job-map.txt",
    "test/e2e/registry/runtime-support.ts",
    "test/e2e/risk-signal-reporter.ts",
    "test/e2e/lib/security-posture-assertions.sh",
    "test/e2e/lib/redact-text.py",
    "test/e2e/lib/fake-slack-api.cjs",
    "test/e2e/fixtures/runtime-input.txt",
    "test/e2e/e2e-cloud-experimental/full-e2e",
    "test/e2e/live/registry-targets.test.ts",
    "test/e2e/live/runtime-overrides.test.ts",
    "test/e2e/live/dashboard-remote-bind.test.ts",
  ])("keeps the E2E control plane in a fail-closed runtime floor: %s", (file) => {
    const result = plan(file);

    expect(result.families.map((family) => family.id)).toContain("e2e-control-plane");
    expect(riskPlanRequiredJobIds(result)).toEqual(
      expect.arrayContaining(["cloud-onboard", "cloud-inference", "security-posture"]),
    );
  });

  it("keeps E2E documentation outside the credentialed control-plane exception", () => {
    const result = plan("test/e2e/README.md", "test/e2e/docs/README.md");

    expect(result.families).toEqual([]);
    expect(result.requiredJobs).toEqual([]);
    expect(result.requiredTargets).toEqual([]);
  });

  it.each([
    "nemoclaw/src/blueprint/runner.ts",
    "nemoclaw-blueprint/blueprint.yaml",
    "agents/hermes/config/build.ts",
  ])("keeps the shared sandbox boundary in both agent and security floors: %s", (file) => {
    const result = plan(file);

    expect(result.families.map((family) => family.id)).toContain("sandbox-boundary");
    expect(riskPlanRequiredJobIds(result)).toEqual(
      expect.arrayContaining([
        "full-e2e",
        "hermes-e2e",
        "hermes-inference-switch",
        "security-posture",
      ]),
    );
  });

  it("keeps every required job selected for broad runtime changes (#6446)", () => {
    const result = plan(
      "src/lib/onboard.ts",
      "src/lib/actions/upgrade-sandboxes.ts",
      "src/lib/actions/sandbox/agents/apply.ts",
      "src/lib/messaging/applier/agent-config.ts",
      "src/lib/inference/health.ts",
      "install.sh",
      "src/lib/credentials/provider-list.ts",
    );

    expect(riskPlanRequiredJobIds(result)).toEqual([
      "cloud-inference",
      "cloud-onboard",
      "managed-image-multiarch-startup",
      "managed-image-protected-runtime",
      "security-posture",
      "channels-add-remove",
      "channels-stop-start",
      "full-e2e",
      "hermes-e2e",
      "inference-routing",
      "network-policy",
      "onboard-repair",
      "onboard-resume",
      "rebuild-openclaw",
      "state-backup-restore",
    ]);
  });

  it("raises PR review test depth for a matched runtime risk", () => {
    const result = classifyTestDepth(["src/lib/state/registry.ts"]);

    expect(result.verdict).toBe("runtime_validation_recommended");
    expect(result.suggestedTests.join("\n")).toContain("onboard-resume");
    expect(result.suggestedTests.join("\n")).toContain("`src/lib/state/registry.ts`");
  });

  it("keeps every risk-plan job wired into the canonical E2E workflow", () => {
    const allowedJobs = new Set([
      ...readFreeStandingJobsInventory().allowedJobs,
      ...E2E_TARGET_CATALOGUE.flatMap(({ id, targetId }) => [id, targetId]),
    ]);
    const configuredJobs = new Set(RISK_RULES.flatMap((rule) => rule.requiredJobs));

    expect([...configuredJobs].filter((job) => !allowedJobs.has(job))).toEqual([]);
  });
});
