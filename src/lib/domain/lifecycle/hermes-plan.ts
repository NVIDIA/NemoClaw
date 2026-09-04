// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../sandbox-name-contract";
import {
  NEMOCLAW_LIFECYCLE_API_VERSION,
  type HermesLifecycleCheck,
  type HermesLifecyclePlan,
  type HermesLifecyclePlanRequest,
  type LifecycleRequestField,
  type LifecycleResult,
} from "./contract";
import { HERMES_LIFECYCLE_DEFINITION } from "./hermes-definition";

type UnknownRecord = Record<string, unknown>;

const REQUEST_KEYS = new Set(["apiVersion", "target", "sandbox"]);
const TARGET_KEYS = new Set(["gatewayIdentity", "workspace", "openshellVersion"]);
const SANDBOX_KEYS = new Set([
  "name",
  "resourceIdentity",
  "imageDigest",
  "configurationFingerprint",
]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CHECKS = Object.freeze<HermesLifecycleCheck[]>([
  "target",
  "resource-identity",
  "image",
  "agent",
  "configuration",
  "sandbox-readiness",
  "agent-readiness",
]);

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: UnknownRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function invalid(field: LifecycleRequestField): LifecycleResult<never> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "invalid-request",
      field,
      message: `Invalid lifecycle request field: ${field}.`,
    }),
  });
}

/** Build a deterministic, credential-free observation plan for Hermes. */
export function planHermesLifecycle(
  request: HermesLifecyclePlanRequest,
): LifecycleResult<HermesLifecyclePlan> {
  try {
    if (!isRecord(request) || !hasOnlyKeys(request, REQUEST_KEYS)) return invalid("request");
    const apiVersion = request.apiVersion;
    const requestedTarget = request.target;
    const requestedSandbox = request.sandbox;
    if (apiVersion !== NEMOCLAW_LIFECYCLE_API_VERSION) return invalid("apiVersion");

    if (!isRecord(requestedTarget) || !hasOnlyKeys(requestedTarget, TARGET_KEYS)) {
      return invalid("target");
    }
    const gatewayIdentity = requestedTarget.gatewayIdentity;
    const workspace = requestedTarget.workspace;
    const openshellVersion = requestedTarget.openshellVersion;
    if (!isDigest(gatewayIdentity)) return invalid("target.gatewayIdentity");
    if (!isValidName(workspace)) return invalid("target.workspace");
    if (openshellVersion !== HERMES_LIFECYCLE_DEFINITION.openshellVersion) {
      return invalid("target.openshellVersion");
    }

    if (!isRecord(requestedSandbox) || !hasOnlyKeys(requestedSandbox, SANDBOX_KEYS)) {
      return invalid("sandbox");
    }
    const sandboxName = requestedSandbox.name;
    const resourceIdentity = requestedSandbox.resourceIdentity;
    const imageDigest = requestedSandbox.imageDigest;
    const configurationFingerprint = requestedSandbox.configurationFingerprint;
    if (!isValidName(sandboxName)) return invalid("sandbox.name");
    if (!isDigest(resourceIdentity)) return invalid("sandbox.resourceIdentity");
    if (!isDigest(imageDigest)) return invalid("sandbox.imageDigest");
    if (!isDigest(configurationFingerprint)) {
      return invalid("sandbox.configurationFingerprint");
    }

    const target = Object.freeze({ gatewayIdentity, workspace, openshellVersion });
    const sandbox = Object.freeze({
      name: sandboxName,
      resourceIdentity,
      imageDigest,
      configurationFingerprint,
    });
    const plan = Object.freeze({
      apiVersion: NEMOCLAW_LIFECYCLE_API_VERSION,
      operation: "observe" as const,
      agent: Object.freeze({
        name: HERMES_LIFECYCLE_DEFINITION.agent,
        version: HERMES_LIFECYCLE_DEFINITION.agentVersion,
      }),
      target,
      sandbox,
      checks: CHECKS,
    });
    return Object.freeze({ ok: true, value: plan });
  } catch {
    return invalid("request");
  }
}
