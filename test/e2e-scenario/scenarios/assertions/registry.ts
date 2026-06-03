// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { environmentBaseline } from "./environment.ts";
import type { AssertionGroup, AssertionStep, PhaseName, ScenarioDefinition } from "../types.ts";

type Reliability = AssertionStep["reliability"];

interface ShellStepInput {
  id: string;
  phase: PhaseName;
  ref: string;
  reliability?: Reliability;
}

function shellStep(input: ShellStepInput): AssertionStep {
  return {
    id: input.id,
    phase: input.phase,
    implementation: { kind: "shell", ref: input.ref },
    evidencePath: `.e2e/assertions/${input.id}.log`,
    reliability: input.reliability,
  };
}

function probeStep(id: string, phase: PhaseName, ref: string, reliability?: Reliability): AssertionStep {
  return {
    id,
    phase,
    implementation: { kind: "probe", ref },
    evidencePath: `.e2e/assertions/${id}.json`,
    reliability,
  };
}

function pendingStep(id: string, phase: PhaseName, ref: string): AssertionStep {
  return {
    id,
    phase,
    implementation: { kind: "pending", ref },
    evidencePath: `.e2e/assertions/${id}.json`,
  };
}

function group(input: {
  id: string;
  phase: PhaseName;
  steps: AssertionStep[];
  suiteId?: string;
  onboardingAssertionId?: string;
  description?: string;
}): AssertionGroup {
  return { ...input, migrationStatus: "complete" };
}

function suiteGroup(suiteId: string, steps: AssertionStep[], phase: PhaseName = "runtime"): AssertionGroup {
  return group({ id: `suite.${suiteId}`, suiteId, phase, steps, description: `Converted suite ${suiteId}.` });
}

export const onboardingAssertionGroups: AssertionGroup[] = [
  group({
    id: "onboarding.base-installed",
    onboardingAssertionId: "base-installed",
    phase: "onboarding",
    steps: [
      shellStep({
        id: "onboarding.base.cli-installed",
        phase: "onboarding",
        ref: "test/e2e-scenario/onboarding_assertions/base/00-cli-installed.sh",
      }),
    ],
  }),
  group({
    id: "onboarding.preflight-passed",
    onboardingAssertionId: "preflight-passed",
    phase: "onboarding",
    steps: [
      shellStep({
        id: "onboarding.preflight.passed",
        phase: "onboarding",
        ref: "test/e2e-scenario/onboarding_assertions/preflight/00-preflight-passed.sh",
        reliability: { timeoutSeconds: 60 },
      }),
    ],
  }),
  group({
    id: "onboarding.preflight-expected-failed",
    onboardingAssertionId: "preflight-expected-failed",
    phase: "onboarding",
    steps: [
      shellStep({
        id: "onboarding.preflight.expected-failed",
        phase: "onboarding",
        ref: "test/e2e-scenario/onboarding_assertions/preflight/00-preflight-expected-failed.sh",
      }),
    ],
  }),
];

const smokeSteps = [
  shellStep({ id: "runtime.smoke.cli-available", phase: "runtime", ref: "test/e2e-scenario/validation_suites/smoke/00-cli-available.sh" }),
  shellStep({
    id: "runtime.smoke.gateway-health",
    phase: "runtime",
    ref: "test/e2e-scenario/validation_suites/smoke/01-gateway-health.sh",
    reliability: { timeoutSeconds: 30, retry: { attempts: 2, on: ["gateway-transient"] } },
  }),
  shellStep({ id: "runtime.smoke.sandbox-listed", phase: "runtime", ref: "test/e2e-scenario/validation_suites/smoke/02-sandbox-listed.sh" }),
  shellStep({ id: "runtime.smoke.sandbox-shell", phase: "runtime", ref: "test/e2e-scenario/validation_suites/smoke/03-sandbox-shell.sh", reliability: { timeoutSeconds: 30 } }),
];

const cloudInferenceSteps = [
  shellStep({
    id: "runtime.inference.models-health",
    phase: "runtime",
    ref: "test/e2e-scenario/validation_suites/inference/cloud/00-models-health.sh",
    reliability: { timeoutSeconds: 30, retry: { attempts: 2, on: ["provider-transient"] } },
  }),
  shellStep({
    id: "runtime.inference.chat-completion",
    phase: "runtime",
    ref: "test/e2e-scenario/validation_suites/inference/cloud/01-chat-completion.sh",
    reliability: { timeoutSeconds: 60, retry: { attempts: 2, on: ["provider-transient", "model-toolcall-transient"] } },
  }),
  shellStep({
    id: "runtime.inference.sandbox-local",
    phase: "runtime",
    ref: "test/e2e-scenario/validation_suites/inference/cloud/02-inference-local-from-sandbox.sh",
    reliability: { timeoutSeconds: 45, retry: { attempts: 2, on: ["gateway-transient"] } },
  }),
];

const credentialsSteps = [
  shellStep({
    id: "security.credentials.present",
    phase: "runtime",
    ref: "test/e2e-scenario/validation_suites/security/credentials/00-credentials-present.sh",
  }),
  shellStep({
    id: "security.credentials.no-plaintext-host-store",
    phase: "runtime",
    ref: "test/e2e-scenario/validation_suites/security/credentials/01-no-plaintext-host-store.sh",
  }),
];

const baselineOnboardingSteps = [
  shellStep({ id: "baseline.cli-and-openshell", phase: "runtime", ref: "test/e2e-scenario/validation_suites/baseline-onboarding/00-cli-and-openshell.sh" }),
  shellStep({ id: "baseline.sandbox-state", phase: "runtime", ref: "test/e2e-scenario/validation_suites/baseline-onboarding/01-sandbox-state.sh" }),
  shellStep({ id: "baseline.route-and-smoke", phase: "runtime", ref: "test/e2e-scenario/validation_suites/baseline-onboarding/02-route-and-smoke.sh" }),
];

const onboardingStateSteps = [
  shellStep({ id: "onboarding.state.registry", phase: "runtime", ref: "test/e2e-scenario/validation_suites/onboarding/state/00-registry-provider-model-policies.sh" }),
  shellStep({ id: "onboarding.state.session", phase: "runtime", ref: "test/e2e-scenario/validation_suites/onboarding/state/01-session-provider-model-policies.sh" }),
];

const ollamaSteps = [
  shellStep({
    id: "runtime.ollama.models-health",
    phase: "runtime",
    ref: "test/e2e-scenario/validation_suites/inference/ollama-gpu/00-ollama-models-health.sh",
    reliability: { timeoutSeconds: 45, retry: { attempts: 2, on: ["provider-transient"] } },
  }),
  shellStep({
    id: "runtime.ollama.chat-completion",
    phase: "runtime",
    ref: "test/e2e-scenario/validation_suites/inference/ollama-gpu/01-ollama-chat-completion.sh",
    reliability: { timeoutSeconds: 60, retry: { attempts: 2, on: ["provider-transient"] } },
  }),
];

const ollamaProxySteps = [
  shellStep({
    id: "runtime.ollama-auth-proxy.reachable",
    phase: "runtime",
    ref: "test/e2e-scenario/validation_suites/inference/ollama-auth-proxy/00-proxy-reachable.sh",
    reliability: { timeoutSeconds: 30, retry: { attempts: 2, on: ["gateway-transient"] } },
  }),
];

export const runtimeControlGroups: AssertionGroup[] = [
  {
    id: "runtime.expected-failure.no-side-effects",
    phase: "runtime",
    description: "Negative scenario runtime check ensuring forbidden side effects did not occur.",
    migrationStatus: "complete",
    steps: [pendingStep("runtime.expected-failure.no-side-effects", "runtime", "expectedFailureNoSideEffectsProbe")],
  },
];

export const validationSuiteGroups: AssertionGroup[] = [
  suiteGroup("smoke", smokeSteps),
  suiteGroup("gateway-health", [smokeSteps[1]]),
  suiteGroup("sandbox-shell", [smokeSteps[3]]),
  suiteGroup("platform-macos", [shellStep({ id: "platform.macos.smoke", phase: "runtime", ref: "test/e2e-scenario/validation_suites/platform/macos/00-macos-smoke.sh" })]),
  suiteGroup("platform-wsl", [shellStep({ id: "platform.wsl.smoke", phase: "runtime", ref: "test/e2e-scenario/validation_suites/platform/wsl/00-wsl-smoke.sh" })]),
  suiteGroup("inference", cloudInferenceSteps),
  suiteGroup("cloud-inference", cloudInferenceSteps),
  suiteGroup("local-ollama-inference", ollamaSteps),
  suiteGroup("ollama-proxy", ollamaProxySteps),
  suiteGroup("ollama-auth-proxy", [
    ...ollamaProxySteps,
    shellStep({ id: "runtime.ollama-auth-proxy.auth-enforcement", phase: "runtime", ref: "test/e2e-scenario/validation_suites/inference/ollama-auth-proxy/01-auth-enforcement.sh" }),
  ]),
  suiteGroup("baseline-onboarding", baselineOnboardingSteps),
  suiteGroup("onboarding-state", onboardingStateSteps),
  suiteGroup("model-router", [
    shellStep({ id: "runtime.model-router.healthy-endpoint", phase: "runtime", ref: "test/e2e-scenario/validation_suites/inference/model-router/00-healthy-endpoint.sh" }),
    shellStep({ id: "runtime.model-router.provider-routed-completion", phase: "runtime", ref: "test/e2e-scenario/validation_suites/inference/model-router/01-provider-routed-completion.sh" }),
  ]),
  suiteGroup("openai-compatible-inference", cloudInferenceSteps),
  suiteGroup("inference-routing", cloudInferenceSteps),
  suiteGroup("inference-switch", cloudInferenceSteps),
  suiteGroup("kimi-compatibility", [
    shellStep({ id: "runtime.kimi.plugin-wiring", phase: "runtime", ref: "test/e2e-scenario/validation_suites/inference/kimi-compatibility/00-plugin-wiring.sh", reliability: { timeoutSeconds: 30, retry: { attempts: 2, on: ["model-toolcall-transient"] } } }),
    shellStep({ id: "runtime.kimi.compatible-models-route", phase: "runtime", ref: "test/e2e-scenario/validation_suites/inference/kimi-compatibility/01-kimi-compatible-models-route.sh", reliability: { timeoutSeconds: 30, retry: { attempts: 2, on: ["model-toolcall-transient"] } } }),
  ]),
  suiteGroup("credentials", credentialsSteps),
  suiteGroup("security-credentials", credentialsSteps),
  suiteGroup("security-shields", [probeStep("security.shields.config", "runtime", "shieldsConfigProbe")]),
  suiteGroup("security-policy", [probeStep("security.policy.enforced", "runtime", "networkPolicyProbe")]),
  suiteGroup("security-injection", [probeStep("security.injection.blocked", "runtime", "injectionBlockedProbe")]),
  suiteGroup("messaging-telegram", [
    shellStep({ id: "messaging.telegram.injection-safety", phase: "runtime", ref: "test/e2e-scenario/validation_suites/messaging/telegram/00-telegram-injection-safety.sh", reliability: { timeoutSeconds: 30, retry: { attempts: 2, on: ["external-tunnel"] } } }),
    shellStep({ id: "messaging.telegram.injection-payload-classes", phase: "runtime", ref: "test/e2e-scenario/validation_suites/messaging/telegram/01-telegram-injection-payload-classes.sh", reliability: { timeoutSeconds: 30, retry: { attempts: 2, on: ["external-tunnel"] } } }),
  ]),
  suiteGroup("messaging-discord", [shellStep({ id: "messaging.discord.gateway-path", phase: "runtime", ref: "test/e2e-scenario/validation_suites/messaging/discord/00-discord-gateway-path.sh", reliability: { timeoutSeconds: 30, retry: { attempts: 2, on: ["external-tunnel"] } } })]),
  suiteGroup("messaging-slack", [shellStep({ id: "messaging.slack.provider-state", phase: "runtime", ref: "test/e2e-scenario/validation_suites/messaging/slack/00-slack-provider-state.sh", reliability: { timeoutSeconds: 30, retry: { attempts: 2, on: ["external-tunnel"] } } })]),
  suiteGroup("messaging-token-rotation", [shellStep({ id: "messaging.token-rotation", phase: "runtime", ref: "test/e2e-scenario/validation_suites/messaging/token-rotation/00-provider-rotation-isolated.sh" })]),
  suiteGroup("sandbox-lifecycle", [
    shellStep({ id: "lifecycle.sandbox.gateway-health", phase: "runtime", ref: "test/e2e-scenario/validation_suites/sandbox/lifecycle/00-gateway-health.sh" }),
    shellStep({ id: "lifecycle.sandbox.gateway-recovery", phase: "runtime", ref: "test/e2e-scenario/validation_suites/sandbox/lifecycle/01-gateway-recovery.sh" }),
  ]),
  suiteGroup("sandbox-operations", [
    shellStep({ id: "lifecycle.sandbox.list-and-status", phase: "runtime", ref: "test/e2e-scenario/validation_suites/sandbox/operations/00-list-and-status.sh" }),
    shellStep({ id: "lifecycle.sandbox.logs-and-exec", phase: "runtime", ref: "test/e2e-scenario/validation_suites/sandbox/operations/01-logs-and-exec.sh" }),
  ]),
  suiteGroup("snapshot", [shellStep({ id: "lifecycle.snapshot.create-list-restore", phase: "runtime", ref: "test/e2e-scenario/validation_suites/sandbox/snapshot/00-create-list-restore.sh" })]),
  suiteGroup("snapshot-lifecycle", [shellStep({ id: "lifecycle.snapshot.create-list-restore", phase: "runtime", ref: "test/e2e-scenario/validation_suites/sandbox/snapshot/00-create-list-restore.sh" })]),
  suiteGroup("rebuild", [
    shellStep({ id: "lifecycle.rebuild.state-preserved", phase: "runtime", ref: "test/e2e-scenario/validation_suites/rebuild_upgrade/00-state-preserved.sh", reliability: { timeoutSeconds: 120, retry: { attempts: 2, on: ["runner-infra"] } } }),
    shellStep({ id: "lifecycle.rebuild.agent-version-upgraded", phase: "runtime", ref: "test/e2e-scenario/validation_suites/rebuild_upgrade/01-agent-version-upgraded.sh", reliability: { timeoutSeconds: 120, retry: { attempts: 2, on: ["runner-infra"] } } }),
    shellStep({ id: "lifecycle.rebuild.post-rebuild-inference", phase: "runtime", ref: "test/e2e-scenario/validation_suites/rebuild_upgrade/02-post-rebuild-inference.sh", reliability: { timeoutSeconds: 120, retry: { attempts: 2, on: ["runner-infra"] } } }),
  ]),
  suiteGroup("upgrade", [
    shellStep({ id: "lifecycle.upgrade.policy-config-preserved", phase: "runtime", ref: "test/e2e-scenario/validation_suites/rebuild_upgrade/03-policy-config-preserved.sh", reliability: { timeoutSeconds: 120, retry: { attempts: 2, on: ["wrong-installed-ref"] } } }),
    shellStep({ id: "lifecycle.upgrade.survivor-reachable", phase: "runtime", ref: "test/e2e-scenario/validation_suites/rebuild_upgrade/04-upgrade-survivor-reachable.sh", reliability: { timeoutSeconds: 120, retry: { attempts: 2, on: ["wrong-installed-ref"] } } }),
  ]),
  suiteGroup("diagnostics", [probeStep("diagnostics.bundle", "runtime", "diagnosticsProbe")]),
  suiteGroup("docs-validation", [probeStep("docs.validation", "runtime", "docsValidationProbe")]),
  suiteGroup("hermes-specific", [shellStep({ id: "runtime.hermes.health", phase: "runtime", ref: "test/e2e-scenario/validation_suites/hermes/00-hermes-health.sh", reliability: { timeoutSeconds: 30, retry: { attempts: 2, on: ["gateway-transient"] } } })]),
];

export const assertionRegistry = {
  groups: [environmentBaseline(), ...onboardingAssertionGroups, ...runtimeControlGroups, ...validationSuiteGroups],
};

export function assertionGroupForSuite(suiteId: string): AssertionGroup | undefined {
  return validationSuiteGroups.find((group) => group.suiteId === suiteId);
}

export function assertionGroupForOnboardingAssertion(assertionId: string): AssertionGroup | undefined {
  return onboardingAssertionGroups.find((group) => group.onboardingAssertionId === assertionId);
}

function supplementalSuiteIdsForScenario(scenario: ScenarioDefinition): string[] {
  const ids: string[] = [];
  if (scenario.id === "ubuntu-repo-cloud-openclaw") {
    ids.push(
      "gateway-health",
      "sandbox-shell",
      "cloud-inference",
      "inference-routing",
      "inference-switch",
      "kimi-compatibility",
      "security-credentials",
      "security-shields",
      "security-policy",
      "security-injection",
      "sandbox-lifecycle",
      "sandbox-operations",
      "snapshot",
      "rebuild",
      "upgrade",
      "diagnostics",
      "docs-validation",
    );
  }
  if (scenario.id === "gpu-repo-local-ollama-openclaw") {
    ids.push("ollama-auth-proxy");
  }
  if (scenario.id === "ubuntu-repo-openai-compatible-openclaw") {
    ids.push("openai-compatible-inference");
  }
  if (scenario.id.includes("telegram")) {
    ids.push("messaging-telegram");
  }
  if (scenario.id.includes("discord")) {
    ids.push("messaging-discord");
  }
  if (scenario.id.includes("slack")) {
    ids.push("messaging-slack");
  }
  if (scenario.id.includes("token-rotation")) {
    ids.push("messaging-token-rotation");
  }
  return ids;
}

function uniqueGroups(groups: AssertionGroup[]): AssertionGroup[] {
  const seen = new Set<string>();
  return groups.filter((group) => {
    if (seen.has(group.id)) {
      return false;
    }
    seen.add(group.id);
    return true;
  });
}

export function assertionGroupsForScenario(scenario: ScenarioDefinition): AssertionGroup[] {
  const onboardingGroups = (scenario.onboardingAssertionIds ?? []).map((id) => {
    const group = assertionGroupForOnboardingAssertion(id);
    if (!group) {
      throw new Error(
        `Unknown onboarding assertion id '${id}' on scenario '${scenario.id}'. Add it to onboardingAssertionGroups or fix the scenario reference.`,
      );
    }
    return group;
  });
  const suiteGroups = (scenario.suiteIds ?? []).map((id) => {
    const group = assertionGroupForSuite(id);
    if (!group) {
      throw new Error(
        `Unknown suite id '${id}' on scenario '${scenario.id}'. Add it to validationSuiteGroups or fix the scenario reference.`,
      );
    }
    return group;
  });
  const supplementalGroups = supplementalSuiteIdsForScenario(scenario).map((id) => {
    const group = assertionGroupForSuite(id);
    if (!group) {
      throw new Error(
        `Unknown supplemental suite id '${id}' on scenario '${scenario.id}'. Add it to validationSuiteGroups or fix supplementalSuiteIdsForScenario.`,
      );
    }
    return group;
  });

  const groups: (AssertionGroup | undefined)[] = [
    environmentBaseline(),
    ...onboardingGroups,
    ...suiteGroups,
    ...supplementalGroups,
    scenario.expectedFailure ? runtimeControlGroups[0] : undefined,
  ];
  return uniqueGroups(groups.filter((entry): entry is AssertionGroup => Boolean(entry)));
}

export function validateAssertionGroups(groups: AssertionGroup[], repoRoot: string): void {
  for (const group of groups) {
    if (!group.id) {
      throw new Error("Assertion group is missing stable ID");
    }
    if (!group.phase) {
      throw new Error(`Assertion group ${group.id} is missing phase owner`);
    }
    if (group.migrationStatus && group.migrationStatus !== "complete") {
      throw new Error(`Assertion group ${group.id} is not complete`);
    }
    if (group.steps.length === 0) {
      throw new Error(`Assertion group ${group.id} has no steps`);
    }
    for (const step of group.steps) {
      if (!step.id) {
        throw new Error(`Assertion group ${group.id} has a step without stable ID`);
      }
      if (!step.phase) {
        throw new Error(`Assertion step ${step.id} is missing phase owner`);
      }
      if (step.phase !== group.phase) {
        throw new Error(
          `Assertion step ${step.id} phase '${step.phase}' does not match group ${group.id} phase '${group.phase}'`,
        );
      }
      if (!step.implementation?.ref) {
        throw new Error(`Assertion step ${step.id} is missing implementation reference`);
      }
      if (!step.evidencePath) {
        throw new Error(`Assertion step ${step.id} is missing evidence path`);
      }
      if ((step.reliability?.retry?.attempts ?? 1) > 1 && (step.reliability?.retry?.on.length ?? 0) === 0) {
        throw new Error(`Assertion step ${step.id} retries without a named classifier`);
      }
      if (step.implementation.kind === "shell") {
        const scriptPath = path.resolve(repoRoot, step.implementation.ref);
        const cwdScriptPath = path.resolve(process.cwd(), step.implementation.ref);
        if (!fs.existsSync(scriptPath) && !fs.existsSync(cwdScriptPath)) {
          throw new Error(`Assertion step ${step.id} references missing script ${step.implementation.ref}`);
        }
      }
    }
  }
}
