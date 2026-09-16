// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

import type { ValidatedNemoClawConfig } from "../../../../src/lib/config/model.ts";
import { validateNemoClawConfig } from "../../../../src/lib/config/schema.ts";
import { load as loadSandboxRegistry } from "../../../../src/lib/state/registry/persistence.ts";
import type { SandboxRegistry } from "../../../../src/lib/state/registry/types.ts";
import { type LoadedManifest, loadManifest } from "../../registry/manifests.ts";
import type {
  ConfigExportExpectation,
  ConfigExportRefusalCategory,
  TargetDefinition,
} from "../../registry/types.ts";
import type { ArtifactSink } from "../artifacts.ts";
import type { CleanupRegistry } from "../cleanup.ts";
import { resultText } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import { CLI_DIST_ENTRYPOINT, REPO_ROOT } from "../paths.ts";
import type { SecretStore } from "../secrets.ts";
import type { NemoClawInstance } from "./onboarding.ts";

export const CONFIG_EXPORT_EVIDENCE_CONTRACT = "nemoclaw.config-export-evidence/v1" as const;
const EVIDENCE_FILE = "config-export-evidence.v1.json";
const MAX_DIAGNOSTIC_LENGTH = 2_048;
const INTERNAL_TRANSPORT_PATTERN = /NEMOCLAW_[A-Z0-9_]+|openshell:resolve:env:/u;

export type ConfigExportClassification =
  | "success"
  | "expected-refusal"
  | "no-usable-sandbox"
  | "failure";

export type ConfigExportFailureStage =
  | "transport"
  | "export"
  | "security"
  | "observation"
  | "verification"
  | "cleanup";

export interface ConfigExportProducer {
  sourceRevision: string;
  cliVersion: string;
  cliArtifactSha256: string;
}

export interface ConfigExportSemantics {
  sandboxName: string | null;
  agent: string | null;
  runtimeProvider: string | null;
  imageRef: string | null;
  inferenceProviderName: string | null;
  inferenceProvider: string | null;
  inferenceApi: string | null;
  inferenceEndpoint: string | null;
  model: string | null;
  credentialReference: string | null;
  routeName: string | null;
  routeProviderReference: string | null;
  policySha256: string | null;
  enabledFeatures: string[];
}

export interface ConfigExportVerification {
  id: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface ConfigExportCommandOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputPublished: boolean;
}

export interface ConfigExportEvidenceEnvelope {
  contract: typeof CONFIG_EXPORT_EVIDENCE_CONTRACT;
  scenarioId: string;
  expectation: ConfigExportExpectation;
  classification: ConfigExportClassification;
  passed: boolean;
  producer: ConfigExportProducer;
  expectedRefusalCategory?: ConfigExportRefusalCategory;
  observedRefusalCategory?: string;
  expected?: ConfigExportSemantics;
  observed?: ConfigExportSemantics;
  verifications: ConfigExportVerification[];
  command?: ConfigExportCommandOutcome;
  export?: {
    bytes: string;
    sha256: string;
  };
  security: {
    knownSecretsAbsent: boolean | null;
    internalTransportsAbsent: boolean | null;
  };
  cleanup: {
    registeredBeforeExport: boolean;
    succeeded: boolean;
  };
  elapsedMs: number;
  failureStage?: ConfigExportFailureStage;
  diagnostic?: string;
}

export interface PolicyReadResult {
  ok: boolean;
  value?: { document: string };
}

export interface ConfigExportValidationDependencies {
  exists(filePath: string): boolean;
  loadManifest(filePath: string): LoadedManifest;
  loadRegistry(): SandboxRegistry;
  makeTempDirectory(prefix: string): string;
  now(): number;
  parseConfig(raw: string): ValidatedNemoClawConfig;
  producer(): ConfigExportProducer;
  readFile(filePath: string): string;
  readPolicy(gatewayName: string, sandboxName: string): Promise<PolicyReadResult>;
  removeDirectory(directory: string): void;
}

const DEFAULT_DEPENDENCIES: ConfigExportValidationDependencies = {
  exists: fs.existsSync,
  loadManifest,
  loadRegistry: loadSandboxRegistry,
  makeTempDirectory: (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  now: Date.now,
  parseConfig: (raw) => validateNemoClawConfig(YAML.parse(raw)),
  producer: readProducer,
  readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
  readPolicy: async (gatewayName, sandboxName) => {
    const { cliOpenShellSandboxPolicyReader, namedOpenShellGateway } =
      await import("../../../../src/lib/adapters/openshell/sandbox-policy-cli.ts");
    return cliOpenShellSandboxPolicyReader.readSandboxPolicy({
      target: namedOpenShellGateway(gatewayName),
      sandboxName,
      scope: "effective",
    });
  },
  removeDirectory: (directory) => fs.rmSync(directory, { force: true, recursive: true }),
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function readProducer(): ConfigExportProducer {
  const buildIdentity = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "dist", "build-identity.json"), "utf8"),
  ) as { nemoclawVersion?: unknown; sourceRevision?: unknown };
  if (
    typeof buildIdentity.sourceRevision !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(buildIdentity.sourceRevision)
  ) {
    throw new Error("config export evidence requires an exact source revision");
  }
  if (
    typeof buildIdentity.nemoclawVersion !== "string" ||
    buildIdentity.nemoclawVersion.trim() === ""
  ) {
    throw new Error("config export evidence requires an exact CLI version");
  }
  return {
    sourceRevision: buildIdentity.sourceRevision,
    cliVersion: buildIdentity.nemoclawVersion,
    cliArtifactSha256: sha256(fs.readFileSync(CLI_DIST_ENTRYPOINT)),
  };
}

function enabledManifestFeatures(manifest: LoadedManifest): string[] {
  return Object.entries(manifest.document.spec.onboarding.features ?? {})
    .filter(([, value]) => value === true)
    .map(([name]) => name)
    .sort();
}

function observedFeatures(
  sandbox: ValidatedNemoClawConfig["spec"]["sandboxes"][number] | undefined,
  agent: ValidatedNemoClawConfig["spec"]["sandboxes"][number]["agents"][number] | undefined,
): string[] {
  const features: string[] = [];
  if (sandbox?.integrations?.webSearch) features.push("webSearch");
  if (agent?.type === "openclaw" && agent.observability) features.push("observability");
  return features.sort();
}

function semanticsFromDocument(document: ValidatedNemoClawConfig): ConfigExportSemantics {
  const sandbox = document.spec.sandboxes[0];
  const agent = sandbox?.agents[0];
  const route = agent?.inference.routes[0];
  const provider = document.spec.inferenceProviders.find(
    (candidate) => candidate.name === route?.providerRef,
  );
  const hostedProvider = provider && !("serving" in provider) ? provider : undefined;
  return {
    sandboxName: sandbox?.name ?? null,
    agent: agent?.type ?? null,
    runtimeProvider: sandbox?.runtime.provider ?? null,
    imageRef: sandbox?.runtime.image.ref ?? null,
    inferenceProviderName: provider?.name ?? null,
    inferenceProvider: provider?.provider ?? null,
    inferenceApi: provider?.api ?? null,
    inferenceEndpoint: hostedProvider?.endpoint ?? null,
    model: route?.overrides.model ?? null,
    credentialReference: hostedProvider?.credential?.env ?? null,
    routeName: route?.name ?? null,
    routeProviderReference: route?.providerRef ?? null,
    policySha256: sandbox ? sha256(canonicalJson(sandbox.network.policy.explicit)) : null,
    enabledFeatures: observedFeatures(sandbox, agent),
  };
}

async function expectedSemantics(
  target: TargetDefinition,
  instance: NemoClawInstance,
  dependencies: ConfigExportValidationDependencies,
): Promise<ConfigExportSemantics> {
  const manifest = dependencies.loadManifest(path.join(REPO_ROOT, target.manifestPath));
  const entry = dependencies.loadRegistry().sandboxes[instance.sandboxName];
  if (!entry) throw new Error("the live sandbox is missing from the NemoClaw registry");
  if (entry.workload?.kind !== "managed-image") {
    throw new Error("automatic config export validation requires an immutable managed image");
  }
  if (!entry.gatewayName) throw new Error("the live sandbox is missing its gateway binding");
  const policy = await dependencies.readPolicy(entry.gatewayName, instance.sandboxName);
  if (!policy.ok || !policy.value) {
    throw new Error("the effective sandbox policy could not be read");
  }
  const credentialReference = entry.credentialEnv ?? null;
  const declaredCredentialReferences = manifest.document.spec.state?.credentialRefs ?? [];
  if (credentialReference && !declaredCredentialReferences.includes(credentialReference)) {
    throw new Error("the live credential reference is not declared by the target manifest");
  }
  return {
    sandboxName: instance.sandboxName,
    agent: manifest.document.spec.onboarding.agent,
    runtimeProvider: entry.openshellDriver ?? null,
    imageRef: entry.workload.reference,
    inferenceProviderName: null,
    inferenceProvider: entry.provider ?? null,
    inferenceApi: entry.preferredInferenceApi ?? null,
    inferenceEndpoint: entry.endpointUrl ?? null,
    model: entry.model ?? null,
    credentialReference,
    routeName: "primary",
    routeProviderReference: null,
    policySha256: sha256(canonicalJson(YAML.parse(policy.value.document))),
    enabledFeatures: enabledManifestFeatures(manifest),
  };
}

function compareSemantics(
  expected: ConfigExportSemantics,
  observed: ConfigExportSemantics,
): ConfigExportVerification[] {
  const scalarFields = [
    "sandboxName",
    "agent",
    "runtimeProvider",
    "imageRef",
    "inferenceProvider",
    "inferenceApi",
    "inferenceEndpoint",
    "model",
    "credentialReference",
    "routeName",
    "policySha256",
    "enabledFeatures",
  ] as const;
  const checks: ConfigExportVerification[] = scalarFields.map((field) => ({
    id: field,
    passed: isDeepStrictEqual(observed[field], expected[field]),
    expected: expected[field],
    actual: observed[field],
  }));
  checks.push({
    id: "routeProviderReference",
    passed:
      observed.routeProviderReference !== null &&
      observed.routeProviderReference === observed.inferenceProviderName,
    expected: "the selected provider name",
    actual: observed.routeProviderReference,
  });
  return checks;
}

function boundedDiagnostic(secretStore: SecretStore, value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return secretStore.redact(raw).slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function refusalCategory(output: string): string | undefined {
  return /Config export failed \(([a-z-]+)\)/u.exec(output)?.[1];
}

export class ConfigExportValidationPhaseFixture {
  constructor(
    private readonly host: HostCliClient,
    private readonly secrets: SecretStore,
    private readonly cleanup: CleanupRegistry,
    private readonly artifacts: ArtifactSink,
    private readonly dependencies: ConfigExportValidationDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  async from(
    target: TargetDefinition,
    instance: NemoClawInstance,
  ): Promise<ConfigExportEvidenceEnvelope> {
    const startedAt = this.dependencies.now();
    const producer = this.dependencies.producer();
    const expectation = target.configExport.expectation;
    if (expectation === "no-usable-sandbox") {
      if (!instance.expectedFailure) {
        throw new Error(
          `target '${target.id}' declared no-usable-sandbox but onboarding did not record its expected failure`,
        );
      }
      const evidence: ConfigExportEvidenceEnvelope = {
        contract: CONFIG_EXPORT_EVIDENCE_CONTRACT,
        scenarioId: target.id,
        expectation,
        classification: "no-usable-sandbox",
        passed: true,
        producer,
        verifications: [],
        security: { knownSecretsAbsent: null, internalTransportsAbsent: null },
        cleanup: { registeredBeforeExport: false, succeeded: true },
        elapsedMs: this.dependencies.now() - startedAt,
      };
      await this.artifacts.writeJson(EVIDENCE_FILE, evidence);
      return evidence;
    }

    const directory = this.dependencies.makeTempDirectory("nemoclaw-config-export-");
    const outputPath = path.join(directory, "config.yaml");
    let removed = false;
    this.cleanup.trackDisposable("remove private automatic config export files", () => {
      if (!removed) this.dependencies.removeDirectory(directory);
      removed = true;
    });

    let expected: ConfigExportSemantics | undefined;
    let observed: ConfigExportSemantics | undefined;
    let raw: string | undefined;
    let verifications: ConfigExportVerification[] = [];
    let classification: ConfigExportClassification = "failure";
    let diagnostic: string | undefined;
    let knownSecretsAbsent: boolean | null = null;
    let internalTransportsAbsent: boolean | null = null;
    let failureStage: ConfigExportFailureStage = "transport";
    let observedRefusalCategory: string | undefined;
    let command: ConfigExportCommandOutcome | undefined;

    try {
      const result = await this.host.nemoclaw(
        ["config", "export", instance.sandboxName, "--output", outputPath, "--json"],
        {
          artifactName: "config-export-automatic",
          redactionValues: this.secrets.redactionValues(),
          timeoutMs: 120_000,
        },
      );
      const outputExists = this.dependencies.exists(outputPath);
      command = {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        outputPublished: outputExists,
      };
      failureStage =
        result.timedOut || result.signal !== null || result.exitCode === null
          ? "transport"
          : "export";
      if (expectation === "expected-refusal") {
        observedRefusalCategory = refusalCategory(resultText(result)) ?? "unclassified";
        if (result.exitCode === 0 || outputExists) {
          throw new Error("config export unexpectedly succeeded or published a file");
        }
        if (observedRefusalCategory !== target.configExport.failureCategory) {
          throw new Error(
            `config export refused with '${observedRefusalCategory ?? "unclassified"}', expected '${target.configExport.failureCategory}'`,
          );
        }
        classification = "expected-refusal";
        diagnostic = boundedDiagnostic(this.secrets, resultText(result));
      } else {
        if (result.exitCode !== 0 || !outputExists) {
          throw new Error(`config export failed: ${resultText(result)}`);
        }
        raw = this.dependencies.readFile(outputPath);
        failureStage = "security";
        const secretValues = this.secrets.redactionValues();
        knownSecretsAbsent = !secretValues.some((value) => value && raw!.includes(value));
        internalTransportsAbsent = !INTERNAL_TRANSPORT_PATTERN.test(raw);
        if (!knownSecretsAbsent) throw new Error("config export exposed a known fixture secret");
        if (!internalTransportsAbsent) {
          throw new Error("config export exposed an internal credential transport");
        }
        failureStage = "verification";
        const document = this.dependencies.parseConfig(raw);
        observed = semanticsFromDocument(document);
        failureStage = "observation";
        expected = await expectedSemantics(target, instance, this.dependencies);
        failureStage = "verification";
        verifications = compareSemantics(expected, observed);
        const failed = verifications.filter((verification) => !verification.passed);
        if (failed.length > 0) {
          throw new Error(
            `config export omitted or changed expected semantics: ${failed.map((entry) => entry.id).join(", ")}`,
          );
        }
        classification = "success";
      }
    } catch (error) {
      diagnostic = boundedDiagnostic(this.secrets, error);
      classification = "failure";
    }

    let cleanupSucceeded = false;
    try {
      this.dependencies.removeDirectory(directory);
      removed = true;
      cleanupSucceeded = true;
    } catch (error) {
      diagnostic = boundedDiagnostic(this.secrets, error);
      classification = "failure";
      failureStage = "cleanup";
    }

    const passed = classification === "success" || classification === "expected-refusal";
    const evidence: ConfigExportEvidenceEnvelope = {
      contract: CONFIG_EXPORT_EVIDENCE_CONTRACT,
      scenarioId: target.id,
      expectation,
      classification,
      passed: passed && cleanupSucceeded,
      producer,
      ...(target.configExport.expectation === "expected-refusal"
        ? { expectedRefusalCategory: target.configExport.failureCategory }
        : {}),
      ...(observedRefusalCategory ? { observedRefusalCategory } : {}),
      ...(expected ? { expected } : {}),
      ...(observed ? { observed } : {}),
      verifications,
      ...(command ? { command } : {}),
      ...(passed && cleanupSucceeded && raw ? { export: { bytes: raw, sha256: sha256(raw) } } : {}),
      security: { knownSecretsAbsent, internalTransportsAbsent },
      cleanup: { registeredBeforeExport: true, succeeded: cleanupSucceeded },
      elapsedMs: this.dependencies.now() - startedAt,
      ...(classification === "failure" ? { failureStage } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
    await this.artifacts.writeJson(EVIDENCE_FILE, evidence);
    if (!evidence.passed) {
      throw new Error(
        `automatic config export validation failed for '${target.id}': ${diagnostic ?? "unknown failure"}`,
      );
    }
    return evidence;
  }
}
