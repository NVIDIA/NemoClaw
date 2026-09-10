// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

import { fingerprintOpenShellSandboxId } from "../../../src/lib/adapters/openshell/sandbox-identity.ts";
import {
  namedOpenShellGateway,
  syncCliOpenShellSandboxPolicyReader,
} from "../../../src/lib/adapters/openshell/sandbox-policy-cli.ts";
import { validateNemoClawConfig } from "../../../src/lib/config/schema.ts";
import { load, save } from "../../../src/lib/state/registry/persistence.ts";
import type { ArtifactSink } from "./artifacts.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { CleanupRegistry } from "./cleanup.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "./paths.ts";

interface HermesConfigExportLiveInput {
  readonly artifacts: ArtifactSink;
  readonly cleanup: CleanupRegistry;
  readonly enabled: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly host: HostCliClient;
  readonly redactionValues: readonly string[];
  readonly sandboxName: string;
}

export interface HermesConfigExportLiveResult {
  readonly checked: boolean;
  readonly passed: boolean;
}

export interface HermesConfigExportLiveEvidence {
  readonly agent: string | undefined;
  readonly aliasesEquivalent: boolean;
  readonly checked: true;
  readonly credentialReferenceMatches: boolean;
  readonly credentialValuesOmitted: boolean;
  readonly identityDriftPreventedPublication: boolean;
  readonly identityDriftReported: boolean;
  readonly immutableManagedImageMatches: boolean;
  readonly inferenceEndpointMatches: boolean;
  readonly launchersSucceeded: boolean;
  readonly policyMatches: boolean;
  readonly sandboxNameMatches: boolean;
}

/** Decide the live contract from redacted, serializable observations. */
export function passesHermesConfigExportLiveEvidence(
  evidence: HermesConfigExportLiveEvidence,
): boolean {
  return (
    evidence.agent === "hermes" &&
    evidence.aliasesEquivalent &&
    evidence.credentialReferenceMatches &&
    evidence.credentialValuesOmitted &&
    evidence.identityDriftPreventedPublication &&
    evidence.identityDriftReported &&
    evidence.immutableManagedImageMatches &&
    evidence.inferenceEndpointMatches &&
    evidence.launchersSucceeded &&
    evidence.policyMatches &&
    evidence.sandboxNameMatches
  );
}

/** Exercise both public CLI names against one live, canonical Hermes source. */
export async function verifyHermesConfigExportLive(
  input: HermesConfigExportLiveInput,
): Promise<HermesConfigExportLiveResult> {
  if (!input.enabled) return { checked: false, passed: true };

  const exportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-export-"));
  input.cleanup.trackDisposable("remove private Hermes config export files", () =>
    fs.rmSync(exportDirectory, { recursive: true, force: true }),
  );

  const registry = load();
  const entry = registry.sandboxes[input.sandboxName]!;
  const policy = syncCliOpenShellSandboxPolicyReader.readSandboxPolicy({
    target: namedOpenShellGateway(entry.gatewayName ?? ""),
    sandboxName: input.sandboxName,
    scope: "effective",
  });
  const nemoclawPath = path.join(exportDirectory, "nemoclaw.yaml");
  const nemohermesPath = path.join(exportDirectory, "nemohermes.yaml");
  const commonOptions = {
    env: input.env,
    timeoutMs: 120_000,
    redactionValues: [...input.redactionValues],
  };
  const nemoclaw = await input.host.command(
    "node",
    [CLI_ENTRYPOINT, "config", "export", input.sandboxName, "--output", nemoclawPath],
    { ...commonOptions, artifactName: "phase-6-hermes-config-export-nemoclaw" },
  );
  const nemohermes = await input.host.command(
    "node",
    [
      path.join(REPO_ROOT, "bin", "nemohermes.js"),
      "config",
      "export",
      input.sandboxName,
      "--output",
      nemohermesPath,
    ],
    { ...commonOptions, artifactName: "phase-6-hermes-config-export-nemohermes" },
  );

  const launchersSucceeded = nemoclaw.exitCode === 0 && nemohermes.exitCode === 0;
  const nemoclawRaw = nemoclaw.exitCode === 0 ? fs.readFileSync(nemoclawPath, "utf8") : "";
  const nemohermesRaw = nemohermes.exitCode === 0 ? fs.readFileSync(nemohermesPath, "utf8") : "";
  const containsCredential = input.redactionValues.some(
    (value) => value.length > 0 && (nemoclawRaw.includes(value) || nemohermesRaw.includes(value)),
  );
  if (!launchersSucceeded) {
    const evidence: HermesConfigExportLiveEvidence = {
      agent: undefined,
      aliasesEquivalent: false,
      checked: true,
      credentialReferenceMatches: false,
      credentialValuesOmitted: !containsCredential,
      identityDriftPreventedPublication: false,
      identityDriftReported: false,
      immutableManagedImageMatches: false,
      inferenceEndpointMatches: false,
      launchersSucceeded,
      policyMatches: false,
      sandboxNameMatches: false,
    };
    await input.artifacts.writeJson("hermes-config-export-live-evidence.json", evidence);
    return { checked: true, passed: false };
  }

  const nemoclawDocument = validateNemoClawConfig(YAML.parse(nemoclawRaw));
  const nemohermesDocument = validateNemoClawConfig(YAML.parse(nemohermesRaw));
  const sandbox = nemoclawDocument.spec.sandboxes[0]!;
  const expectedPolicy = policy.ok ? YAML.parse(policy.value.document) : null;
  const expectedImage = entry.workload?.kind === "managed-image" ? entry.workload.reference : null;

  const nemoclawMismatchPath = path.join(exportDirectory, "nemoclaw-mismatch.yaml");
  const nemohermesMismatchPath = path.join(exportDirectory, "nemohermes-mismatch.yaml");
  let nemoclawDriftExitCode: number | null = 0;
  let nemohermesDriftExitCode: number | null = 0;
  let nemoclawDriftDiagnostics = "";
  let nemohermesDriftDiagnostics = "";
  try {
    save({
      ...registry,
      sandboxes: {
        ...registry.sandboxes,
        [input.sandboxName]: {
          ...entry,
          lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId(randomUUID())!,
        },
      },
    });
    const nemoclawDrift = await input.host.command(
      "node",
      [CLI_ENTRYPOINT, "config", "export", input.sandboxName, "--output", nemoclawMismatchPath],
      { ...commonOptions, artifactName: "phase-6-hermes-config-export-nemoclaw-drift" },
    );
    const nemohermesDrift = await input.host.command(
      "node",
      [
        path.join(REPO_ROOT, "bin", "nemohermes.js"),
        "config",
        "export",
        input.sandboxName,
        "--output",
        nemohermesMismatchPath,
      ],
      { ...commonOptions, artifactName: "phase-6-hermes-config-export-nemohermes-drift" },
    );
    nemoclawDriftExitCode = nemoclawDrift.exitCode;
    nemohermesDriftExitCode = nemohermesDrift.exitCode;
    nemoclawDriftDiagnostics = [nemoclawDrift.stdout, nemoclawDrift.stderr].join("\n");
    nemohermesDriftDiagnostics = [nemohermesDrift.stdout, nemohermesDrift.stderr].join("\n");
  } finally {
    save(registry);
  }

  const evidence: HermesConfigExportLiveEvidence = {
    aliasesEquivalent: isDeepStrictEqual(nemohermesDocument.spec, nemoclawDocument.spec),
    agent: sandbox.agents[0]?.type,
    checked: true,
    credentialValuesOmitted: !containsCredential,
    credentialReferenceMatches:
      nemoclawDocument.spec.inferenceProviders[0]?.credential?.env === entry.credentialEnv,
    identityDriftPreventedPublication:
      typeof nemoclawDriftExitCode === "number" &&
      nemoclawDriftExitCode !== 0 &&
      typeof nemohermesDriftExitCode === "number" &&
      nemohermesDriftExitCode !== 0 &&
      !fs.existsSync(nemoclawMismatchPath) &&
      !fs.existsSync(nemohermesMismatchPath),
    identityDriftReported:
      nemoclawDriftDiagnostics.includes("drifted") &&
      nemohermesDriftDiagnostics.includes("drifted"),
    immutableManagedImageMatches: sandbox.runtime.image.ref === expectedImage,
    inferenceEndpointMatches:
      nemoclawDocument.spec.inferenceProviders[0]?.endpoint === entry.endpointUrl,
    launchersSucceeded,
    policyMatches: isDeepStrictEqual(sandbox.network.policy.explicit, expectedPolicy),
    sandboxNameMatches: sandbox.name === input.sandboxName,
  };
  await input.artifacts.writeJson("hermes-config-export-live-evidence.json", evidence);
  return { checked: true, passed: passesHermesConfigExportLiveEvidence(evidence) };
}
