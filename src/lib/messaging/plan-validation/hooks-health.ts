// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistry } from "../hooks";
import type {
  SandboxMessagingHealthCheckPlan,
  SandboxMessagingHookReferencePlan,
  SandboxMessagingPlan,
} from "../manifest";
import {
  assertArray,
  assertBoolean,
  assertRecord,
  assertString,
  assertStringArray,
  fail,
} from "./assertions";
import {
  healthCheckForManifest,
  healthCheckMatches,
  hooksEqual,
  isHookForAgent,
  requirePlanManifest,
} from "./manifest-matchers";
import { assertHookHandlerRegistered } from "./registered-hooks";
import type { PlanManifestMap } from "./types";

const HOOK_PHASES = new Set([
  "enroll",
  "reachability-check",
  "apply",
  "post-agent-install",
  "health-check",
  "diagnostic",
  "status",
]);

export function validateChannelHooks(
  plan: SandboxMessagingPlan,
  manifests: PlanManifestMap,
  hooks: MessagingHookRegistry,
): void {
  plan.channels.forEach((channel, channelIndex) => {
    const manifest = manifests.get(channel.channelId);
    if (!manifest) return;
    const expectedHooks = manifest.hooks.filter((hook) => isHookForAgent(hook, plan.agent));
    channel.hooks.forEach((hook, hookIndex) => {
      const path = `$.channels[${channelIndex}].hooks[${hookIndex}]`;
      assertHookShape(hook, path);
      if (hook.channelId !== channel.channelId) {
        fail(`${path}.channelId`, "hook channel does not match parent channel");
      }
      const expected = expectedHooks.find((candidate) => hooksEqual(hook, candidate));
      if (!expected) fail(path, "hook is not declared by the channel manifest");
      assertHookHandlerRegistered(hooks, hook.handler, `${path}.handler`);
    });
  });
}

export function validateHealthChecks(
  plan: SandboxMessagingPlan,
  manifests: PlanManifestMap,
  hooks: MessagingHookRegistry,
): void {
  plan.healthChecks.forEach((check, index) => {
    const path = `$.healthChecks[${index}]`;
    assertHealthCheckShape(check, path);
    const manifest = requirePlanManifest(manifests, check.channelId, `${path}.channelId`);
    const expected = healthCheckForManifest(manifest);
    if (!healthCheckMatches(check, expected)) {
      fail(path, "health check is not declared by the channel manifest");
    }
    const manifestHooks = new Map(manifest.hooks.map((hook) => [hook.id, hook]));
    check.hookIds.forEach((hookId, hookIndex) => {
      const hook = manifestHooks.get(hookId);
      if (hook) assertHookHandlerRegistered(hooks, hook.handler, `${path}.hookIds[${hookIndex}]`);
    });
  });
}

function assertHookShape(
  hook: unknown,
  path: string,
): asserts hook is SandboxMessagingHookReferencePlan {
  const record = assertRecord(hook, path);
  assertString(record.channelId, `${path}.channelId`);
  assertString(record.id, `${path}.id`);
  if (typeof record.phase !== "string" || !HOOK_PHASES.has(record.phase)) {
    fail(`${path}.phase`, "expected supported hook phase");
  }
  assertString(record.handler, `${path}.handler`);
  if (record.agents !== undefined) assertStringArray(record.agents, `${path}.agents`);
  if (record.inputs !== undefined) assertStringArray(record.inputs, `${path}.inputs`);
  if (record.outputs !== undefined) {
    assertArray(record.outputs, `${path}.outputs`);
    record.outputs.forEach((output, index) => {
      const outputPath = `${path}.outputs[${index}]`;
      const outputRecord = assertRecord(output, outputPath);
      assertString(outputRecord.id, `${outputPath}.id`);
      if (
        outputRecord.kind !== "secret" &&
        outputRecord.kind !== "config" &&
        outputRecord.kind !== "build-arg" &&
        outputRecord.kind !== "build-file"
      ) {
        fail(`${outputPath}.kind`, "expected supported hook output kind");
      }
      if (outputRecord.required !== undefined) {
        assertBoolean(outputRecord.required, `${outputPath}.required`);
      }
    });
  }
  if (
    record.onFailure !== undefined &&
    record.onFailure !== "abort" &&
    record.onFailure !== "skip-channel"
  ) {
    fail(`${path}.onFailure`, "expected supported failure mode");
  }
}

function assertHealthCheckShape(
  check: unknown,
  path: string,
): asserts check is SandboxMessagingHealthCheckPlan {
  const record = assertRecord(check, path);
  assertString(record.channelId, `${path}.channelId`);
  if (record.phase !== "health-check") fail(`${path}.phase`, "expected health-check");
  if (record.requiredBefore !== "lifecycle-success") {
    fail(`${path}.requiredBefore`, "expected lifecycle-success");
  }
  assertStringArray(record.hookIds, `${path}.hookIds`);
}
