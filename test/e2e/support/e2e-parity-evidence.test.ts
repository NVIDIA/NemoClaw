// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  assertParityEvidence,
  buildExecutionEvidence,
  compareParityEvidence,
  type ExecutionEvidenceInput,
  fingerprintDesiredState,
  type NonEmptyProviderReceipts,
  type ProviderReceipt,
} from "../registry/parity-evidence.ts";
import {
  compileRuntimeMatrix,
  type ResolvedRuntimeCase,
  resolveRuntimeCase,
} from "../registry/runtime-matrix.ts";
import { foundationDefinition } from "./cross-runtime-foundation-fixtures.ts";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;

function evidenceInput(
  provider: "docker" | "test-mxc",
  agent: "dcode" | "hermes" | "openclaw" = "openclaw",
): ExecutionEvidenceInput {
  const matrix = compileRuntimeMatrix(foundationDefinition());
  const runtimeCase = matrix.cases.find(
    (entry) => entry.scenario.agent === agent && entry.profile.provider === provider,
  );
  assert.ok(runtimeCase, `Missing ${agent} fixture runtime case for ${provider}`);
  const resolved = resolveRuntimeCase(matrix, {
    scenarioId: runtimeCase.scenario.id,
    profileId: runtimeCase.profile.id,
  });

  return {
    resolved,
    source: { headSha: HEAD_SHA, baseSha: BASE_SHA },
    engine: {
      name: provider === "docker" ? "docker-engine" : "fake-mxc-engine",
      version: provider === "docker" ? "29.1.0" : "0.0.0-fixture",
    },
    workload: {
      logicalId: runtimeCase.identities.sandbox,
      providerResourceId: `${provider}://fixture/${runtimeCase.identities.sandbox}`,
      managedImages: [{ role: "agent", digest: IMAGE_DIGEST }],
    },
    observed: {
      desiredState: runtimeCase.scenario.assertions.desiredState,
      fsmTrace: runtimeCase.scenario.assertions.fsmTrace,
      terminalOutcome: runtimeCase.scenario.assertions.terminalOutcome,
      userVisibleState: runtimeCase.scenario.assertions.userVisibleState,
    },
    providerReceipts: [
      {
        kind: "prepare",
        operationId: `${provider}.prepare`,
        value: { diagnostic: `${provider}-private` },
      },
    ],
  };
}

describe("cross-runtime parity evidence", () => {
  it("normalizes desired-state fingerprints and exact execution evidence", () => {
    expect(fingerprintDesiredState({ b: 2, a: { y: 2, x: 1 } })).toBe(
      fingerprintDesiredState({ a: { x: 1, y: 2 }, b: 2 }),
    );

    const evidence = buildExecutionEvidence(evidenceInput("docker"));
    expect(evidence).toMatchObject({
      source: { headSha: HEAD_SHA, baseSha: BASE_SHA },
      runtime: {
        provider: "docker",
        architecture: "amd64",
        capabilities: expect.arrayContaining(["transport.docker-socket"]),
      },
      workload: {
        logicalId: expect.stringMatching(/^e2e-/),
        providerResourceId: expect.stringMatching(/^docker:/),
        managedImages: [{ role: "agent", digest: IMAGE_DIGEST }],
      },
      parity: {
        terminalOutcome: { status: "succeeded", state: "completed" },
      },
    });
  });

  it("ignores provider runtime identity and opaque receipts when comparing parity", () => {
    const docker = buildExecutionEvidence(evidenceInput("docker"));
    const mxc = buildExecutionEvidence(evidenceInput("test-mxc"));

    expect(compareParityEvidence(docker, mxc)).toEqual([]);
    expect(() => assertParityEvidence(docker, mxc)).not.toThrow();
  });

  it("reports parity differences between valid evidence for different scenarios", () => {
    const openclaw = buildExecutionEvidence(evidenceInput("docker", "openclaw"));
    const hermes = buildExecutionEvidence(evidenceInput("test-mxc", "hermes"));

    expect(compareParityEvidence(openclaw, hermes).map((mismatch) => mismatch.field)).toEqual([
      "scenarioId",
      "desiredStateFingerprint",
    ]);
    expect(() => assertParityEvidence(openclaw, hermes)).toThrow(
      /scenarioId, desiredStateFingerprint/,
    );
  });

  it("rejects executions that do not satisfy the scenario before parity comparison", () => {
    const mismatchInput = evidenceInput("test-mxc");
    mismatchInput.observed.userVisibleState = {
      status: "degraded",
      response: "fixture response",
    };
    expect(() => buildExecutionEvidence(mismatchInput)).toThrow(
      /observed userVisibleState does not satisfy its scenario assertion/,
    );

    const wrongTrace = evidenceInput("docker");
    wrongTrace.observed.fsmTrace = [
      { from: "requested", event: "skip provision", to: "ready" },
      { from: "ready", event: "complete turn", to: "completed" },
    ];
    expect(() => buildExecutionEvidence(wrongTrace)).toThrow(
      /observed fsmTrace does not satisfy its scenario assertion/,
    );
  });

  it("rejects incomplete source, image, and provider receipt evidence", () => {
    const badSource = evidenceInput("docker");
    badSource.source.headSha = "not-a-sha";
    expect(() => buildExecutionEvidence(badSource)).toThrow(/40-character commit SHA/);

    const badImage = evidenceInput("docker");
    badImage.workload.managedImages = [{ role: "agent", digest: "latest" }];
    expect(() => buildExecutionEvidence(badImage)).toThrow(/exact sha256 digest/);

    const missingReceipt = evidenceInput("docker");
    missingReceipt.providerReceipts = [] as unknown as NonEmptyProviderReceipts;
    expect(() => buildExecutionEvidence(missingReceipt)).toThrow(/provider receipt/);

    const wrongWorkload = evidenceInput("docker");
    wrongWorkload.workload.logicalId = "some-other-sandbox";
    expect(() => buildExecutionEvidence(wrongWorkload)).toThrow(
      /does not match case sandbox identity/,
    );

    const wrongTerminal = evidenceInput("docker");
    wrongTerminal.observed.terminalOutcome = {
      status: "succeeded",
      state: "not-the-trace-terminal",
    };
    expect(() => buildExecutionEvidence(wrongTerminal)).toThrow(
      /does not match FSM terminal state/,
    );

    const wrongDesiredState = evidenceInput("docker");
    wrongDesiredState.observed.desiredState = { configured: false };
    expect(() => buildExecutionEvidence(wrongDesiredState)).toThrow(
      /observed desiredState does not satisfy its scenario assertion/,
    );

    const forgedResolution = evidenceInput("docker");
    forgedResolution.resolved = {
      case: forgedResolution.resolved.case,
      shard: {
        ...forgedResolution.resolved.shard,
        id: "attacker-chosen-shard-id",
      },
    } as unknown as ResolvedRuntimeCase;
    expect(() => buildExecutionEvidence(forgedResolution)).toThrow(
      /resolution was not issued by resolveRuntimeCase/,
    );
  });

  it("rejects non-string receipt identities and omits unknown receipt fields", () => {
    const missingKind = evidenceInput("docker");
    missingKind.providerReceipts = [
      {
        kind: undefined,
        operationId: "docker.prepare",
        value: {},
      } as unknown as ProviderReceipt,
    ];
    expect(() => buildExecutionEvidence(missingKind)).toThrow(
      /provider receipt kind must be a string/,
    );

    const missingOperationId = evidenceInput("docker");
    missingOperationId.providerReceipts = [
      {
        kind: "prepare",
        operationId: undefined,
        value: {},
      } as unknown as ProviderReceipt,
    ];
    expect(() => buildExecutionEvidence(missingOperationId)).toThrow(
      /provider receipt operationId must be a string/,
    );

    const extraField = evidenceInput("docker");
    extraField.providerReceipts = [
      {
        kind: "prepare",
        operationId: "docker.prepare",
        value: { fixture: true },
        providerPrivateField: "must-not-persist",
      } as ProviderReceipt,
    ];
    const evidence = buildExecutionEvidence(extraField);
    expect(evidence.providerReceipts).toEqual([
      {
        kind: "prepare",
        operationId: "docker.prepare",
        value: { fixture: true },
      },
    ]);
    expect(evidence.providerReceipts[0]).not.toHaveProperty("providerPrivateField");
  });

  it("publishes provider receipts through the redacting artifact boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-execution-evidence-"));
    try {
      const secret = "provider-private-secret";
      const input = evidenceInput("test-mxc");
      input.providerReceipts = [
        {
          kind: "prepare",
          operationId: "test-mxc.prepare",
          value: { diagnostic: secret },
        },
      ];
      const sink = new ArtifactSink(root, [secret]);
      const evidence = buildExecutionEvidence(input);
      const file = await sink.writeExecutionEvidence(
        input.resolved.case.identities.result,
        evidence,
      );

      expect(file).toBe(
        path.join(sink.rootDir, "execution", `${input.resolved.case.identities.result}.json`),
      );
      const published = fs.readFileSync(file, "utf8");
      expect(published).toContain("[REDACTED]");
      expect(published).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
