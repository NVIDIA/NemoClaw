// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  CUA_ARTIFACT_CLEANUP_OPERATIONS,
  CUA_CAPABILITIES,
  CUA_DENIED_DESTINATIONS,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_MATERIAL_EXCLUSIONS,
  CUA_PRIVATE_MATERIALS,
  CUA_REQUIRED_TASK_OPERATIONS,
  CUA_TARGET_OPERATIONS,
  CUA_UNTRUSTED_INPUTS,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
  type CuaTaskResult,
} from "../cua/contract";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-cua-"));
process.env.HOME = testHome;
const registry = await import("./registry");

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const component = (name: string, value: string) => ({
  name,
  version: "1.0.0",
  digest: digest(value),
  owner: "fixture",
});

const readiness: CuaRuntimeReadiness = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "runtime-readiness",
  mode: "standalone",
  status: "available",
  components: {
    runtime: component("cua-fixture", "1"),
    sandboxImage: component("sandbox-fixture", "2"),
    policy: component("policy-fixture", "3"),
    taskProtocol: component("task-fixture", "4"),
  },
  inference: { provider: "fixture", model: "fixture-model" },
  commands: { interactive: true, headless: true, version: true, smoke: true },
  limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
  requiredCapabilities: CUA_CAPABILITIES,
  targetOperations: CUA_TARGET_OPERATIONS,
  taskOperations: CUA_REQUIRED_TASK_OPERATIONS,
};

const attachment: CuaTargetAttachment = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "target-attachment",
  status: "attached",
  target: {
    identityDigest: digest("5"),
    platform: "fixture-linux-amd64",
    image: component("desktop-fixture", "6"),
    serviceBundle: component("service-fixture", "7"),
    capabilities: CUA_CAPABILITIES.map((id) => ({
      id,
      protocolVersion: "1.0.0",
      health: "healthy" as const,
    })),
  },
  activeTask: null,
};

const completedResult: CuaTaskResult = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "task-result",
  taskId: "task-1",
  status: "succeeded",
  targetIdentityDigest: digest("5"),
  components: {
    runtime: readiness.components.runtime,
    sandboxImage: readiness.components.sandboxImage,
    targetImage: attachment.target!.image,
    serviceBundle: attachment.target!.serviceBundle,
    policy: readiness.components.policy,
    taskProtocol: readiness.components.taskProtocol,
  },
  inference: readiness.inference,
  capabilities: CUA_CAPABILITIES.map((id) => ({ id, protocolVersion: "1.0.0" })),
  agentResult: { status: "succeeded", resultDigest: digest("8") },
  verification: {
    status: "passed",
    checkIds: ["fixture-check"],
    evidenceDigests: [digest("9")],
  },
  receipts: [{ capability: "browser", status: "completed", evidenceDigests: [digest("9")] }],
  evidence: [
    { digest: digest("8"), classification: "private", mediaType: "application/json" },
    { digest: digest("9"), classification: "private", mediaType: "image/png" },
  ],
};

const securityAttestation: CuaSecurityAttestation = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "security-attestation",
  status: "enforced",
  bindings: {
    targetIdentityDigest: attachment.target!.identityDigest,
    components: completedResult.components,
    inference: readiness.inference,
    capabilities: completedResult.capabilities,
  },
  network: {
    defaultAction: "deny",
    managedInference: "only",
    targetServices: CUA_CAPABILITIES,
    deniedDestinations: CUA_DENIED_DESTINATIONS,
  },
  materialBoundary: {
    delivery: "host-side-secret-boundary",
    sandboxMaterial: "absent",
    excludedFrom: CUA_MATERIAL_EXCLUSIONS,
  },
  isolation: {
    runAs: "non-root",
    privileged: false,
    hostDockerSocket: false,
    hostDesktop: false,
    broadWritableHostMounts: false,
  },
  artifacts: {
    materials: CUA_PRIVATE_MATERIALS,
    classification: "private",
    contentIdentity: "sha256",
    access: "owner-only",
    metadata: "bounded",
    retention: "until-target-reset-or-destroy",
    cleanupOperations: CUA_ARTIFACT_CLEANUP_OPERATIONS,
    backup: "excluded",
  },
  authority: {
    fixtureScope: "synthetic-local",
    externalSideEffects: "denied",
    untrustedInputs: CUA_UNTRUSTED_INPUTS,
    mayExpand: false,
  },
  verifier: component("security-verifier", "a"),
};

beforeEach(() => {
  registry.clearAll();
});

afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("CUA canonical registry state (#7751)", () => {
  it("round-trips only versioned runtime and target projections", () => {
    registry.registerSandbox({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });

    expect(registry.getSandbox("alpha")).toMatchObject({
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    expect(JSON.stringify(disk.sandboxes.alpha.cuaTarget)).not.toMatch(
      /credential|password|secret|token|endpoint|hostName|ssh|vnc/i,
    );
  });

  it("fails closed when persisted target health does not match the schema", () => {
    registry.registerSandbox({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    disk.sandboxes.alpha.cuaTarget.target.capabilities[0].health = "unchecked";
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(disk));

    expect(() => registry.load()).toThrow("CUA lifecycle record does not match its schema");
    fs.rmSync(registry.REGISTRY_FILE);
  });
});

describe("CUA completed-task registry state (#7752)", () => {
  it("round-trips bounded secret-free task results for reconnect", () => {
    const completedResults = Array.from({ length: 17 }, (_, index) => ({
      ...completedResult,
      taskId: `task-${String(index + 1)}`,
    }));
    registry.registerSandbox({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaTaskResults: completedResults,
    });

    expect(registry.getSandbox("alpha")?.cuaTaskResults).toHaveLength(16);
    expect(registry.getSandbox("alpha")?.cuaTaskResults?.[0].taskId).toBe("task-2");
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    expect(disk.sandboxes.alpha.cuaTaskResults).toHaveLength(16);
    expect(disk.sandboxes.alpha.cuaTaskResults[15].taskId).toBe("task-17");
    expect(JSON.stringify(disk.sandboxes.alpha.cuaTaskResults)).not.toMatch(
      /credential|password|secret|token|endpoint|hostName|ssh|vnc|path|url/i,
    );
  });
});

describe("CUA security registry state (#7754)", () => {
  it("round-trips only a content-free attestation and rejects authority fields", () => {
    registry.registerSandbox({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaSecurityAttestation: securityAttestation,
    });

    expect(registry.getSandbox("alpha")?.cuaSecurityAttestation).toEqual(securityAttestation);
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    expect(JSON.stringify(disk.sandboxes.alpha.cuaSecurityAttestation)).not.toMatch(
      /"(endpoint|hostname|cookie|password|token|credential|ssh|vnc|path|url)"\s*:/i,
    );
    disk.sandboxes.alpha.cuaSecurityAttestation.endpoint = "https://host.invalid";
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(disk));

    expect(() => registry.load()).toThrow("CUA lifecycle record does not match its schema");
  });
});
