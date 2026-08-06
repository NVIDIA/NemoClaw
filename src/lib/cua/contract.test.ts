// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import cuaLifecycleSchema from "../../../schemas/cua-lifecycle.schema.json" with { type: "json" };
import { getAgentChoices, loadAgent } from "../agent/defs.js";
import { getTerminalCommand } from "../agent/runtime.js";
import {
  CUA_ARTIFACT_CLEANUP_OPERATIONS,
  CUA_CAPABILITIES,
  CUA_DENIED_DESTINATIONS,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_MATERIAL_EXCLUSIONS,
  CUA_PRIVATE_MATERIALS,
  CUA_TASK_OPERATIONS,
  CUA_TARGET_OPERATIONS,
  CUA_UNTRUSTED_INPUTS,
  type CuaComponentIdentity,
  type CuaLifecycleRecord,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
  type CuaTaskResult,
  checkCuaLifecycleSchemaVersion,
  getCuaLifecycleSemanticErrors,
  getCuaRuntimeReadinessDigest,
} from "./contract.js";

const digest = `sha256:${"a".repeat(64)}`;
const secondDigest = `sha256:${"b".repeat(64)}`;
const thirdDigest = `sha256:${"c".repeat(64)}`;
const fourthDigest = `sha256:${"d".repeat(64)}`;
const fifthDigest = `sha256:${"e".repeat(64)}`;
const appliedPolicy = { revision: 17, digest: secondDigest } as const;
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
    agent: "nemocua",
    mode: "standalone",
    status: "available",
    sourceRevision: "d".repeat(40),
    sourceClean: true,
    runtimeManifestDigest: digest,
    providerAuthorityDigest: digest,
    qualification: {
      state: "qualified",
      candidateSourceRevision: "e".repeat(40),
      environmentDigest: digest,
      receiptDigest: secondDigest,
      bundleReceiptDigest: thirdDigest,
    },
    components: {
      openshell: component("openshell"),
      runtime: component("cua-runtime"),
      sandboxImage: component("cua-sandbox"),
      targetAdapter: component("cua-target-adapter"),
      policy: component("cua-policy"),
      taskProtocol: component("cua-task-protocol"),
      securityVerifier: component("cua-security-verifier"),
    },
    inference: {
      provider: "managed",
      model: "provider/model",
      routeDigest: digest,
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
    securityOperations: ["security.status", "security.verify"],
  };
}

function targetAttachment(): AttachedTargetAttachment {
  const runtimeReadinessDigest = getCuaRuntimeReadinessDigest(runtimeReadiness());
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "target-attachment",
    status: "attached",
    runtimeReadinessDigest,
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
  const runtimeReadinessDigest = getCuaRuntimeReadinessDigest(runtimeReadiness());
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "task-result",
    taskId: "task-1",
    status: "succeeded",
    targetIdentityDigest: secondDigest,
    runtimeReadinessDigest,
    components: {
      openshell: component("openshell"),
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
      routeDigest: digest,
    },
    appliedPolicy,
    capabilities: [{ id: "browser", protocolVersion: "1.0.0" }],
    agentResult: {
      status: "succeeded",
      resultDigest: thirdDigest,
    },
    verification: {
      status: "passed",
      checkIds: ["fixture.final-state"],
      evidenceDigests: [fourthDigest],
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
        digest: secondDigest,
        classification: "private",
        mediaType: "application/json",
        sizeBytes: 512,
      },
      {
        digest: thirdDigest,
        classification: "private",
        mediaType: "application/json",
        sizeBytes: 256,
      },
      {
        digest: fourthDigest,
        classification: "private",
        mediaType: "application/json",
        sizeBytes: 128,
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
      runtimeReadinessDigest: getCuaRuntimeReadinessDigest(readiness),
      targetIdentityDigest: attachment.identityDigest,
      components: {
        openshell: readiness.components.openshell,
        runtime: readiness.components.runtime,
        sandboxImage: readiness.components.sandboxImage,
        targetImage: attachment.image,
        serviceBundle: attachment.serviceBundle,
        policy: readiness.components.policy,
        taskProtocol: readiness.components.taskProtocol,
      },
      inference: readiness.inference,
      appliedPolicy,
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
      retention: "until-target-detach-or-destroy",
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

describe("first-class CUA contract", () => {
  it("validates each public lifecycle record shape (#7750)", () => {
    const validate = createValidator();
    const records: CuaLifecycleRecord[] = [
      runtimeReadiness(),
      targetAttachment(),
      securityAttestation(),
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
    const agentName = "langchain-deepagents-code";
    const choice = getAgentChoices().find((entry) => entry.name === agentName);
    const agent = loadAgent(agentName);

    expect(choice?.name).toBe(agentName);
    expect(agent.runtime).toEqual({
      kind: "terminal",
      interactive_command: "dcode",
      headless_command: "dcode -n",
      smoke_commands: [
        "dcode --version",
        "test -s /sandbox/.deepagents/config.toml && echo NEMOCLAW_DEEPAGENTS_CONFIG_OK",
        'empty_prompt=; output="$(timeout 10 dcode -n "$empty_prompt" 2>&1)"; status=$?; [ "$status" -eq 2 ] && [ "$output" = "NemoClaw: empty non-interactive prompt for -n; provide prompt text." ] && echo NEMOCLAW_DCODE_EMPTY_PROMPT_OK',
      ],
    });
    expect(agent.versionCommand).toBe("dcode --version");
    expect(getTerminalCommand(agent, "interactive")).toBe("dcode");
    expect(getTerminalCommand(agent, "headless")).toBe("dcode -n");
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

  it("advertises exactly the browser-slice task operations (#7755)", () => {
    const validate = createValidator();
    const readiness = runtimeReadiness();
    readiness.taskOperations = [...CUA_TASK_OPERATIONS];

    expect(validate(readiness), JSON.stringify(validate.errors)).toBe(true);
    expect(getCuaLifecycleSemanticErrors(readiness)).toEqual([]);
  });

  it("accepts namespaced models and rejects coordinate or credential-shaped inference values", () => {
    const namespaced = runtimeReadiness();
    namespaced.inference.model = "nvidia/nvidia/nemotron-3-ultra";
    expect(getCuaLifecycleSemanticErrors(namespaced)).toEqual([]);

    for (const provider of [
      "https://provider.invalid",
      "provider.invalid",
      "localhost",
      "127.0.0.1",
      "user@host",
      "ghp_example",
      "sk-test",
    ]) {
      const record = runtimeReadiness();
      record.inference.provider = provider;
      expect(getCuaLifecycleSemanticErrors(record)).toContain(
        "inference.provider must be a printable credential-free identity",
      );
    }
    for (const model of [
      "https://models.invalid/a",
      "models.invalid",
      "localhost/model",
      "127.0.0.1/model",
      "user@host/model",
      "model?token=value",
      "model#fragment",
      "model\nother",
      "sk-secret",
    ]) {
      const record = runtimeReadiness();
      record.inference.model = model;
      expect(getCuaLifecycleSemanticErrors(record)).toContain(
        "inference.model must be a printable coordinate-free model selector",
      );
    }
  });

  it("keeps component identities printable and free of coordinates and credentials", () => {
    const valid = runtimeReadiness();
    valid.components.taskProtocol.name = "task-runtime";
    valid.components.taskProtocol.version = "1.0.0+cuda12";
    expect(getCuaLifecycleSemanticErrors(valid)).toEqual([]);

    for (const [field, value] of [
      ["name", "ghp_example"],
      ["version", "https://artifacts.invalid/release"],
      ["owner", "operator@private.invalid"],
      ["owner", "localhost"],
      ["owner", "127.0.0.1"],
    ] as const) {
      const record = runtimeReadiness();
      record.components.runtime[field] = value;
      expect(getCuaLifecycleSemanticErrors(record)).toContain(
        `components.runtime.${field} must be a printable coordinate- and credential-free identity`,
      );
    }
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
    const readiness = runtimeReadiness() as unknown as Record<string, unknown>;
    const readinessComponents = {
      ...(readiness.components as Record<string, unknown>),
    };
    delete readinessComponents.securityVerifier;
    expect(validate({ ...readiness, components: readinessComponents })).toBe(false);

    const result = taskResult() as unknown as Record<string, unknown>;
    const components = { ...(result.components as Record<string, unknown>) };
    const runtime = { ...(components.runtime as Record<string, unknown>) };
    delete runtime.digest;
    components.runtime = runtime;

    expect(validate({ ...result, components })).toBe(false);
    expect(
      validate({
        ...result,
        capabilities: [],
      }),
    ).toBe(false);
    const capabilities = result.capabilities as unknown[];
    expect(
      validate({
        ...result,
        capabilities: [capabilities[0], capabilities[0]],
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
        evidenceDigests: [fifthDigest],
      },
    ];

    expect(getCuaLifecycleSemanticErrors(result)).toContain(
      "receipts contains duplicate capabilities: browser",
    );
    expect(getCuaLifecycleSemanticErrors(result)).toContain(
      `receipt browser references unknown evidence digest ${fifthDigest}`,
    );
  });

  it("requires complete capability receipts and independent proof for succeeded tasks (#7750)", () => {
    const validate = createValidator();
    const valid = taskResult();
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    expect(getCuaLifecycleSemanticErrors(valid)).toEqual([]);

    const missingReceipts = structuredClone(valid);
    missingReceipts.receipts = [];
    expect(validate(missingReceipts)).toBe(false);
    expect(getCuaLifecycleSemanticErrors(missingReceipts)).toContain(
      "receipts is missing: browser",
    );

    const failedReceipt = structuredClone(valid);
    failedReceipt.receipts[0]!.status = "failed";
    expect(validate(failedReceipt)).toBe(false);
    expect(getCuaLifecycleSemanticErrors(failedReceipt)).toContain(
      "a succeeded task requires every capability receipt to be completed",
    );

    const emptyReceiptEvidence = structuredClone(valid);
    emptyReceiptEvidence.receipts[0]!.evidenceDigests = [];
    expect(validate(emptyReceiptEvidence)).toBe(false);
    expect(getCuaLifecycleSemanticErrors(emptyReceiptEvidence)).toContain(
      "a succeeded task requires browser receipt evidence",
    );

    const noChecks = structuredClone(valid);
    noChecks.verification.checkIds = [];
    expect(validate(noChecks)).toBe(false);
    expect(getCuaLifecycleSemanticErrors(noChecks)).toContain(
      "a succeeded task requires at least one independent verification check",
    );

    const noVerificationEvidence = structuredClone(valid);
    noVerificationEvidence.verification.evidenceDigests = [];
    expect(validate(noVerificationEvidence)).toBe(false);
    expect(getCuaLifecycleSemanticErrors(noVerificationEvidence)).toContain(
      "a succeeded task requires independent verification evidence",
    );

    const replayedAgentOutput = structuredClone(valid);
    replayedAgentOutput.verification.evidenceDigests = [valid.agentResult.resultDigest];
    expect(validate(replayedAgentOutput)).toBe(true);
    expect(getCuaLifecycleSemanticErrors(replayedAgentOutput)).toContain(
      "verification evidence must be independent from the agent result",
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
