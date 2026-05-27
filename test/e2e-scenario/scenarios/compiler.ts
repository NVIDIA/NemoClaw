// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./manifests.ts";
import { requireScenarios } from "./registry.ts";
import type { AssertionGroup, NemoClawInstanceManifest, PhaseName, RunPlan, ScenarioDefinition, SutBoundary } from "./types.ts";

const PHASES: PhaseName[] = ["environment", "onboarding", "runtime"];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function groupsForPhase(scenario: ScenarioDefinition, phase: PhaseName): AssertionGroup[] {
  return scenario.assertionGroups.filter((group) => group.phase === phase);
}

function resolveScenarioInputs(inputs: Array<string | ScenarioDefinition>): ScenarioDefinition[] {
  const ids = inputs.filter((input): input is string => typeof input === "string");
  const resolvedById = requireScenarios(ids);
  let idCursor = 0;
  return inputs.map((input) => (typeof input === "string" ? resolvedById[idCursor++] : input));
}

function expectedPlatform(platformId: string): { os: string; executionTarget: string } | undefined {
  const mapping: Record<string, { os: string; executionTarget: string }> = {
    "ubuntu-local": { os: "ubuntu", executionTarget: "local" },
    "gpu-runner": { os: "ubuntu", executionTarget: "local" },
    "macos-local": { os: "macos", executionTarget: "local" },
    "wsl-local": { os: "wsl", executionTarget: "local" },
    "brev-launchable": { os: "ubuntu", executionTarget: "remote" },
  };
  return mapping[platformId];
}

function expectedRuntime(runtimeId: string): { containerEngine: string; containerDaemon: string } | undefined {
  const mapping: Record<string, { containerEngine: string; containerDaemon: string }> = {
    "docker-running": { containerEngine: "docker", containerDaemon: "running" },
    "gpu-docker-cdi": { containerEngine: "docker", containerDaemon: "running" },
    "macos-docker-optional": { containerEngine: "docker", containerDaemon: "optional" },
    "docker-missing": { containerEngine: "docker", containerDaemon: "missing" },
  };
  return mapping[runtimeId];
}

function validateManifestCompatibility(scenario: ScenarioDefinition, manifest?: NemoClawInstanceManifest) {
  if (!manifest || !scenario.environment) {
    return;
  }
  const platform = expectedPlatform(scenario.environment.platform);
  if (platform) {
    const actual = manifest.spec.setup.platform;
    if (actual.os !== platform.os || actual.executionTarget !== platform.executionTarget) {
      throw new Error(
        `Scenario ${scenario.id} incompatible with manifest platform: expected ${platform.os}/${platform.executionTarget}, got ${actual.os}/${actual.executionTarget}`,
      );
    }
  }
  const runtime = expectedRuntime(scenario.environment.runtime);
  if (runtime) {
    const actual = manifest.spec.setup.runtime;
    if (actual.containerEngine !== runtime.containerEngine || actual.containerDaemon !== runtime.containerDaemon) {
      throw new Error(
        `Scenario ${scenario.id} incompatible with manifest runtime: expected ${runtime.containerEngine}/${runtime.containerDaemon}, got ${actual.containerEngine}/${actual.containerDaemon}`,
      );
    }
  }
}

function phaseActions(phase: PhaseName, scenario: ScenarioDefinition): string[] {
  if (phase === "environment") {
    return [
      `install:${scenario.environment?.install ?? "unknown"}`,
      `runtime:${scenario.environment?.runtime ?? "unknown"}`,
    ];
  }
  if (phase === "onboarding") {
    return [`onboard:${scenario.environment?.onboarding ?? "unknown"}`];
  }
  return (scenario.suiteIds ?? []).map((suiteId) => `suite:${suiteId}`);
}

const SUT_BOUNDARIES: SutBoundary[] = [
  { id: "host-cli", client: "HostCliClient" },
  { id: "gateway", client: "GatewayClient" },
  { id: "sandbox", client: "SandboxClient" },
  { id: "agent", client: "AgentClient" },
  { id: "provider", client: "ProviderClient" },
  { id: "state", client: "StateClient" },
];

export function validateRunPlan(plan: RunPlan): void {
  if (!plan.scenarioId) {
    throw new Error("RunPlan missing scenarioId");
  }
  for (const phase of PHASES) {
    if (!plan.phases.some((entry) => entry.name === phase)) {
      throw new Error(`RunPlan ${plan.scenarioId} missing phase ${phase}`);
    }
  }
  if (plan.sutBoundaries.length === 0) {
    throw new Error(`RunPlan ${plan.scenarioId} missing SUT boundaries`);
  }
}

export function compileRunPlans(inputs: Array<string | ScenarioDefinition>): RunPlan[] {
  return resolveScenarioInputs(inputs).map((scenario) => {
    const manifest = scenario.manifestPath
      ? loadManifest(path.resolve(REPO_ROOT, scenario.manifestPath)).document
      : undefined;
    validateManifestCompatibility(scenario, manifest);
    const plan: RunPlan = {
      scenarioId: scenario.id,
      status: "compiled",
      note: "compiled plan-only preview; live execution lands in later phases",
      manifestPath: scenario.manifestPath,
      manifest,
      environment: scenario.environment,
      expectedStateId: scenario.expectedStateId,
      suiteIds: scenario.suiteIds ?? [],
      onboardingAssertionIds: scenario.onboardingAssertionIds ?? [],
      phases: PHASES.map((phase) => ({
        name: phase,
        actions: phaseActions(phase, scenario),
        assertionGroups: groupsForPhase(scenario, phase),
      })),
      runnerRequirements: scenario.runnerRequirements ?? [],
      requiredSecrets: scenario.requiredSecrets ?? [],
      skippedCapabilities: scenario.skippedCapabilities ?? [],
      expectedFailure: scenario.expectedFailure,
      sutBoundaries: SUT_BOUNDARIES,
    };
    validateRunPlan(plan);
    return plan;
  });
}

export function renderPlanText(plans: RunPlan[]): string {
  const lines = ["Hybrid scenario run plan", ""];
  for (const plan of plans) {
    lines.push(`Scenario: ${plan.scenarioId}`);
    lines.push(`Status: ${plan.status}`);
    lines.push(`Note: ${plan.note ?? ""}`);
    lines.push(`Manifest: ${plan.manifestPath ?? "not-yet-defined"}`);
    if (plan.environment) {
      lines.push(
        `Environment: platform=${plan.environment.platform} install=${plan.environment.install} runtime=${plan.environment.runtime} onboarding=${plan.environment.onboarding}`,
      );
    }
    if (plan.expectedStateId) {
      lines.push(`Expected state: ${plan.expectedStateId}`);
    }
    if (plan.suiteIds.length > 0) {
      lines.push(`Suites: ${plan.suiteIds.join(", ")}`);
    }
    if (plan.requiredSecrets.length > 0) {
      lines.push(`Required secrets: ${plan.requiredSecrets.join(", ")}`);
    }
    if (plan.runnerRequirements.length > 0) {
      lines.push(`Runner requirements: ${plan.runnerRequirements.join(", ")}`);
    }
    if (plan.skippedCapabilities.length > 0) {
      lines.push(`Skipped capabilities: ${plan.skippedCapabilities.map((entry) => entry.id ?? "unnamed").join(", ")}`);
    }
    if (plan.expectedFailure) {
      lines.push(`Expected failure: ${JSON.stringify(plan.expectedFailure)}`);
    }
    if (plan.sutBoundaries.length > 0) {
      lines.push(
        `SUT boundaries: ${plan.sutBoundaries.map((boundary) => `${boundary.id}:${boundary.client}`).join(", ")}`,
      );
    }
    if (plan.manifest) {
      const setup = plan.manifest.spec.setup;
      const onboarding = plan.manifest.spec.onboarding;
      lines.push(
        `Setup: install=${setup.install.source ?? "unknown"} runtime=${setup.runtime.containerEngine ?? "unknown"}/${setup.runtime.containerDaemon ?? "unknown"} platform=${setup.platform.os ?? "unknown"}/${setup.platform.executionTarget ?? "unknown"}`,
      );
      lines.push(
        `Onboarding: agent=${onboarding.agent} provider=${onboarding.provider} modelRoute=${onboarding.modelRoute ?? "unknown"}`,
      );
    }
    for (const phase of plan.phases) {
      lines.push(`Phase: ${phase.name}`);
      for (const group of phase.assertionGroups) {
        lines.push(`  Group: ${group.id}`);
        for (const step of group.steps) {
          const policy: string[] = [];
          if (step.reliability?.timeoutSeconds) {
            policy.push(`timeout=${step.reliability.timeoutSeconds}s`);
          }
          if (step.reliability?.retry && step.reliability.retry.attempts > 1) {
            policy.push(
              `retry=${step.reliability.retry.attempts} on ${step.reliability.retry.on.join("+")}`,
            );
          }
          lines.push(`    Step: ${step.id}${policy.length > 0 ? ` (${policy.join(", ")})` : ""}`);
        }
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function writePlanArtifacts(plans: RunPlan[], contextDir: string): { jsonPath: string; summaryPath: string } {
  const outputDir = path.join(contextDir, ".e2e");
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "run-plan.json");
  const summaryPath = path.join(outputDir, "plan.txt");
  fs.writeFileSync(jsonPath, `${JSON.stringify(plans, null, 2)}\n`);
  fs.writeFileSync(summaryPath, renderPlanText(plans));
  return { jsonPath, summaryPath };
}
