// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistry } from "../hooks";
import type {
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingBuildStepPlan,
  SandboxMessagingPlan,
  SandboxMessagingStateUpdatePlan,
} from "../manifest";
import {
  assertBoolean,
  assertRecord,
  assertSerializableValue,
  assertString,
  assertStringArray,
  fail,
  isAgent,
} from "./assertions";
import {
  buildStepMatches,
  buildStepsForManifest,
  renderEntriesForManifest,
  renderEntryMatches,
  requirePlanManifest,
  stateUpdateMatches,
  stateUpdatesForManifest,
} from "./manifest-matchers";
import { assertHookHandlerRegistered } from "./registered-hooks";
import type { PlanManifestMap } from "./types";

export function validateAgentRender(plan: SandboxMessagingPlan, manifests: PlanManifestMap): void {
  plan.agentRender.forEach((render, index) => {
    const path = `$.agentRender[${index}]`;
    assertAgentRenderShape(render, path);
    const manifest = requirePlanManifest(manifests, render.channelId, `${path}.channelId`);
    const expected = renderEntriesForManifest(manifest, plan.agent).find((candidate) =>
      renderEntryMatches(render, candidate),
    );
    if (!expected) fail(path, "render entry is not declared by the channel manifest");
  });
}

export function validateBuildSteps(
  plan: SandboxMessagingPlan,
  manifests: PlanManifestMap,
  hooks: MessagingHookRegistry,
): void {
  plan.buildSteps.forEach((step, index) => {
    const path = `$.buildSteps[${index}]`;
    assertBuildStepShape(step, path);
    const manifest = requirePlanManifest(manifests, step.channelId, `${path}.channelId`);
    const expected = buildStepsForManifest(manifest, plan.agent).find((candidate) =>
      buildStepMatches(step, candidate),
    );
    if (!expected) fail(path, "build step is not declared by the channel manifest");
    assertHookHandlerRegistered(hooks, step.handler, `${path}.handler`);
  });
}

export function validateStateUpdates(plan: SandboxMessagingPlan, manifests: PlanManifestMap): void {
  plan.stateUpdates.forEach((update, index) => {
    const path = `$.stateUpdates[${index}]`;
    assertStateUpdateShape(update, path);
    const manifest = requirePlanManifest(manifests, update.channelId, `${path}.channelId`);
    const expected = stateUpdatesForManifest(manifest).find((candidate) =>
      stateUpdateMatches(update, candidate),
    );
    if (!expected) fail(path, "state update is not declared by the channel manifest");
  });
}

function assertAgentRenderShape(
  render: unknown,
  path: string,
): asserts render is SandboxMessagingAgentRenderPlan {
  const record = assertRecord(render, path);
  assertString(record.channelId, `${path}.channelId`);
  if (record.renderId !== undefined) assertString(record.renderId, `${path}.renderId`);
  if (!isAgent(record.agent)) fail(`${path}.agent`, "expected supported messaging agent");
  assertString(record.target, `${path}.target`);
  if (record.kind === "json-fragment") {
    assertString(record.path, `${path}.path`);
    assertSerializableValue(record.value, `${path}.value`);
    assertStringArray(record.templateRefs, `${path}.templateRefs`);
    return;
  }
  if (record.kind === "env-lines") {
    assertStringArray(record.lines, `${path}.lines`);
    assertStringArray(record.templateRefs, `${path}.templateRefs`);
    return;
  }
  fail(`${path}.kind`, "expected supported render kind");
}

function assertBuildStepShape(
  step: unknown,
  path: string,
): asserts step is SandboxMessagingBuildStepPlan {
  const record = assertRecord(step, path);
  assertString(record.channelId, `${path}.channelId`);
  if (record.kind !== "build-arg" && record.kind !== "build-file") {
    fail(`${path}.kind`, "expected build-arg or build-file");
  }
  assertString(record.hookId, `${path}.hookId`);
  assertString(record.handler, `${path}.handler`);
  assertString(record.outputId, `${path}.outputId`);
  assertBoolean(record.required, `${path}.required`);
}

function assertStateUpdateShape(
  update: unknown,
  path: string,
): asserts update is SandboxMessagingStateUpdatePlan {
  const record = assertRecord(update, path);
  assertString(record.channelId, `${path}.channelId`);
  if (record.kind === "persist-inputs") {
    assertString(record.stateKey, `${path}.stateKey`);
    assertStringArray(record.inputIds, `${path}.inputIds`);
    return;
  }
  if (record.kind === "rebuild-hydration") {
    assertString(record.statePath, `${path}.statePath`);
    assertString(record.env, `${path}.env`);
    return;
  }
  fail(`${path}.kind`, "expected supported state update kind");
}
