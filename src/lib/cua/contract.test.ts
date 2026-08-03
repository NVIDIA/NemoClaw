// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { afterAll, describe, expect, it } from "vitest";
import cuaLifecycleSchema from "../../../schemas/cua-lifecycle.schema.json" with { type: "json" };
import { AGENTS_DIR, getAgentChoices, loadAgent } from "../agent/defs.js";
import { getTerminalCommand } from "../agent/runtime.js";
import {
  CUA_ARTIFACT_CLEANUP_OPERATIONS,
  CUA_CAPABILITIES,
  CUA_DENIED_DESTINATIONS,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_MATERIAL_EXCLUSIONS,
  CUA_PRIVATE_MATERIALS,
  CUA_REQUIRED_TASK_OPERATIONS,
  CUA_TARGET_OPERATIONS,
  CUA_TASK_OPERATIONS,
  CUA_UNTRUSTED_INPUTS,
  type CuaComponentIdentity,
  type CuaLifecycleRecord,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
  type CuaTaskEvidenceIndex,
  type CuaTaskResult,
  checkCuaLifecycleSchemaVersion,
  getCuaLifecycleSemanticErrors,
} from "./contract.js";

const digest = `sha256:${"a".repeat(64)}`;
const secondDigest = `sha256:${"b".repeat(64)}`;
const thirdDigest = `sha256:${"c".repeat(64)}`;
const temporaryAgentName = `cua-contract-fixture-${String(process.pid)}`;
const temporaryAgentDir = path.join(AGENTS_DIR, temporaryAgentName);

type AttachedTargetAttachment = CuaTargetAttachment & {
  target: NonNullable<CuaTargetAttachment["target"]>;
};

function component(name: string, componentDigest = digest): CuaComponentIdentity {
  return {
    name,
    version: "1.2.3",
    digest: componentDigest,
    owner: "NVIDIA",
  };
}

function runtimeReadiness(): CuaRuntimeReadiness {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "runtime-readiness",
    mode: "standalone",
    status: "available",
    components: {
      runtime: component("cua-runtime"),
      sandboxImage: component("cua-sandbox"),
      policy: component("cua-policy"),
      taskProtocol: component("cua-task-protocol"),
    },
    inference: {
      provider: "managed",
      model: "provider/model",
    },
    commands: {
      interactive: true,
      headless: true,
      version: true,
      smoke: true,
    },
    limits: {
      targetsPerWorker: 1,
      activeTasksPerTarget: 1,
    },
    requiredCapabilities: [...CUA_CAPABILITIES],
    targetOperations: [...CUA_TARGET_OPERATIONS],
    taskOperations: [...CUA_TASK_OPERATIONS],
  };
}

function targetAttachment(): AttachedTargetAttachment {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "target-attachment",
    status: "attached",
    target: {
      identityDigest: secondDigest,
      platform: "linux/amd64",
      image: component("target-image"),
      serviceBundle: component("target-services"),
      capabilities: CUA_CAPABILITIES.map((id) => ({
        id,
        protocolVersion: "1.0.0",
        health: "healthy" as const,
      })),
    },
    activeTask: null,
  };
}

function taskResult(): CuaTaskResult {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "task-result",
    taskId: "task-1",
    status: "succeeded",
    targetIdentityDigest: secondDigest,
    components: {
      runtime: component("cua-runtime"),
      sandboxImage: component("cua-sandbox"),
      targetImage: component("target-image"),
      serviceBundle: component("target-services"),
      policy: component("cua-policy"),
      taskProtocol: component("cua-task-protocol"),
    },
    inference: {
      provider: "managed",
      model: "provider/model",
    },
    capabilities: CUA_CAPABILITIES.map((id) => ({
      id,
      protocolVersion: "1.0.0",
    })),
    agentResult: {
      status: "succeeded",
      resultDigest: thirdDigest,
    },
    verification: {
      status: "passed",
      checkIds: ["fixture.final-state"],
      evidenceDigests: [thirdDigest],
    },
    receipts: [
      {
        capability: "browser",
        status: "completed",
        evidenceDigests: [digest],
      },
    ],
    evidence: [
      {
        digest,
        classification: "private",
        mediaType: "image/png",
        sizeBytes: 1024,
      },
      {
        digest: thirdDigest,
        classification: "private",
        mediaType: "application/json",
        sizeBytes: 256,
      },
    ],
  };
}

function taskEvidenceIndex(): CuaTaskEvidenceIndex {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "task-evidence-index",
    taskId: "task-1",
    category: "events",
    targetIdentityDigest: secondDigest,
    evidence: [
      {
        digest,
        classification: "private",
        mediaType: "application/json",
        sizeBytes: 256,
      },
    ],
  };
}

function securityAttestation(): CuaSecurityAttestation {
  const readiness = runtimeReadiness();
  const attachment = targetAttachment().target;
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "security-attestation",
    status: "enforced",
    bindings: {
      targetIdentityDigest: attachment.identityDigest,
      components: {
        runtime: readiness.components.runtime,
        sandboxImage: readiness.components.sandboxImage,
        targetImage: attachment.image,
        serviceBundle: attachment.serviceBundle,
        policy: readiness.components.policy,
        taskProtocol: readiness.components.taskProtocol,
      },
      inference: readiness.inference,
      capabilities: attachment.capabilities.map(({ id, protocolVersion }) => ({
        id,
        protocolVersion,
      })),
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
    verifier: component("security-verifier", thirdDigest),
  };
}

function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(cuaLifecycleSchema as AnySchema);
}

afterAll(() => {
  fs.rmSync(temporaryAgentDir, { recursive: true, force: true });
});

describe("first-class CUA contract", () => {
  it("validates each public lifecycle record shape (#7750)", () => {
    const validate = createValidator();
    const records: CuaLifecycleRecord[] = [
      runtimeReadiness(),
      targetAttachment(),
      securityAttestation(),
      taskEvidenceIndex(),
      taskResult(),
      {
        schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
        kind: "failure",
        operation: "task.start",
        family: "task_conflict",
        retryable: true,
        component: "target",
      },
    ];

    for (const record of records) {
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
      expect(getCuaLifecycleSemanticErrors(record)).toEqual([]);
    }
  });

  it("uses the ordinary terminal manifest path for CUA discovery and commands (#7750)", () => {
    fs.mkdirSync(temporaryAgentDir, { recursive: true });
    fs.writeFileSync(
      path.join(temporaryAgentDir, "manifest.yaml"),
      [
        `name: ${temporaryAgentName}`,
        'display_name: "CUA contract fixture"',
        "binary_path: /usr/local/bin/cua-fixture",
        'version_command: "cua-fixture version"',
        'expected_version: "1.2.3"',
        "version_scheme: semver",
        "runtime:",
        "  kind: terminal",
        '  interactive_command: "cua-fixture interactive"',
        '  headless_command: "cua-fixture headless"',
        "  smoke_commands:",
        '    - "cua-fixture version"',
        '    - "cua-fixture smoke"',
        "",
      ].join("\n"),
      "utf8",
    );

    const choice = getAgentChoices().find((entry) => entry.name === temporaryAgentName);
    const agent = loadAgent(temporaryAgentName);

    expect(choice?.name).toBe(temporaryAgentName);
    expect(agent.runtime).toEqual({
      kind: "terminal",
      interactive_command: "cua-fixture interactive",
      headless_command: "cua-fixture headless",
      smoke_commands: ["cua-fixture version", "cua-fixture smoke"],
    });
    expect(agent.versionCommand).toBe("cua-fixture version");
    expect(getTerminalCommand(agent, "interactive")).toBe("cua-fixture interactive");
    expect(getTerminalCommand(agent, "headless")).toBe("cua-fixture headless");
  });

  it("rejects unknown schema majors before consuming a lifecycle record (#7750)", () => {
    expect(checkCuaLifecycleSchemaVersion("1.7.4")).toEqual({ compatible: true, major: 1 });
    expect(checkCuaLifecycleSchemaVersion("2.0.0")).toEqual({
      compatible: false,
      major: 2,
      reason: "unsupported CUA lifecycle schema major 2",
    });
    expect(checkCuaLifecycleSchemaVersion("1.01.0").compatible).toBe(false);
    expect(checkCuaLifecycleSchemaVersion(null).compatible).toBe(false);
  });

  it("requires core task operations and advertises optional operations by presence (#7750)", () => {
    const validate = createValidator();
    const readiness = runtimeReadiness();
    readiness.taskOperations = [...CUA_REQUIRED_TASK_OPERATIONS];

    expect(validate(readiness), JSON.stringify(validate.errors)).toBe(true);
    expect(getCuaLifecycleSemanticErrors(readiness)).toEqual([]);
  });

  it("rejects missing, duplicate, and unhealthy required capabilities (#7750)", () => {
    const missing = runtimeReadiness();
    missing.requiredCapabilities = ["browser", "computer"];
    expect(getCuaLifecycleSemanticErrors(missing)).toContain(
      "requiredCapabilities is missing: terminal",
    );

    const duplicate = targetAttachment();
    const duplicateTarget = duplicate.target;
    duplicateTarget.capabilities = [
      ...duplicateTarget.capabilities.slice(0, 2),
      {
        id: "computer",
        protocolVersion: "1.0.0",
        health: "healthy",
      },
    ];
    expect(getCuaLifecycleSemanticErrors(duplicate)).toContain(
      "target.capabilities contains duplicate values: computer",
    );
    expect(getCuaLifecycleSemanticErrors(duplicate)).toContain(
      "target.capabilities is missing: terminal",
    );

    const unhealthy = targetAttachment();
    const unhealthyTarget = unhealthy.target;
    unhealthyTarget.capabilities = unhealthyTarget.capabilities.map((capability) =>
      capability.id === "computer" ? { ...capability, health: "unhealthy" } : capability,
    );
    expect(getCuaLifecycleSemanticErrors(unhealthy)).toContain(
      "an attached target requires healthy browser, computer, and terminal capabilities",
    );
  });

  it("rejects a detached record that retains its target projection (#7750)", () => {
    const detached = {
      ...targetAttachment(),
      status: "detached" as const,
      target: null,
      activeTask: null,
    };
    expect(getCuaLifecycleSemanticErrors(detached)).toEqual([]);

    const staleProjection = {
      ...targetAttachment(),
      status: "detached" as const,
    };
    expect(getCuaLifecycleSemanticErrors(staleProjection)).toContain(
      "a detached target must clear its public projection",
    );
  });

  it("rejects authority-bearing extensions on public lifecycle records (#7750)", () => {
    const validate = createValidator();
    const record = targetAttachment() as unknown as Record<string, unknown>;

    for (const forbidden of [
      { token: "not-a-real-secret" },
      { endpoint: "https://target.invalid" },
      { host: "target.internal" },
      { ssh: { user: "operator" } },
      { path: "/private/target" },
    ]) {
      expect(validate({ ...record, ...forbidden })).toBe(false);
    }

    const credentialRecord = {
      ...runtimeReadiness(),
      inference: {
        ...runtimeReadiness().inference,
        authToken: "not-a-real-secret",
      },
    } as unknown as CuaLifecycleRecord;
    expect(getCuaLifecycleSemanticErrors(credentialRecord)).toContain(
      "$.inference.authToken is credential-shaped and cannot enter the public CUA contract",
    );
  });

  it("rejects missing component digests, duplicate capabilities, and path-bearing evidence (#7750)", () => {
    const validate = createValidator();
    const result = taskResult() as unknown as Record<string, unknown>;
    const components = { ...(result.components as Record<string, unknown>) };
    const runtime = { ...(components.runtime as Record<string, unknown>) };
    delete runtime.digest;
    components.runtime = runtime;

    expect(validate({ ...result, components })).toBe(false);
    expect(
      validate({
        ...result,
        capabilities: (result.capabilities as unknown[]).slice(0, 2),
      }),
    ).toBe(false);
    const capabilities = result.capabilities as unknown[];
    expect(
      validate({
        ...result,
        capabilities: [capabilities[0], capabilities[0], capabilities[2]],
      }),
    ).toBe(false);
    expect(
      validate({
        ...result,
        evidence: [{ digest, classification: "private", path: "/tmp/screenshot.png" }],
      }),
    ).toBe(false);
    expect(
      validate({
        ...result,
        evidence: [{ digest, classification: "public", mediaType: "image/png" }],
      }),
    ).toBe(false);
  });

  it("rejects duplicate receipts and unresolved evidence references (#7750)", () => {
    const result = taskResult();
    result.receipts = [
      ...result.receipts,
      {
        capability: "browser",
        status: "completed",
        evidenceDigests: [secondDigest],
      },
    ];

    expect(getCuaLifecycleSemanticErrors(result)).toContain(
      "receipts contains duplicate capabilities: browser",
    );
    expect(getCuaLifecycleSemanticErrors(result)).toContain(
      `receipt browser references unknown evidence digest ${secondDigest}`,
    );
  });

  it("keeps task results terminal and rejects contradictory statuses (#7750)", () => {
    const validate = createValidator();
    expect(validate({ ...taskResult(), status: "input-required" })).toBe(false);

    const contradictory = taskResult();
    contradictory.status = "failed";
    expect(getCuaLifecycleSemanticErrors(contradictory)).toContain(
      "a failed task cannot contain both a succeeded agent result and passed verification",
    );

    const cancelled = taskResult();
    cancelled.status = "cancelled";
    expect(getCuaLifecycleSemanticErrors(cancelled)).toContain(
      "task and agent result cancellation status must match",
    );
  });

  it("rejects unsupported operations, cardinality, and failure families (#7750)", () => {
    const validate = createValidator();
    const readiness = runtimeReadiness() as unknown as Record<string, unknown>;
    const limits = { ...(readiness.limits as Record<string, unknown>), activeTasksPerTarget: 2 };

    expect(validate({ ...readiness, limits })).toBe(false);
    expect(
      validate({
        schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
        kind: "failure",
        operation: "task.shell",
        family: "unknown_failure",
        retryable: false,
      }),
    ).toBe(false);
  });
});
