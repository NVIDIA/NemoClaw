// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";
import {
  CONFIG_EXPORT_COMMAND_TIMEOUT_MS,
  CONFIG_EXPORT_POLICY_TIMEOUT_MS,
} from "../../../../tools/e2e/onboard-timeout-contract.mts";
import { type LoadedManifest, loadManifest } from "../../registry/manifests.ts";
import type {
  ConfigExportExpectation,
  ConfigExportRefusalCategory,
  TargetDefinition,
} from "../../registry/types.ts";
import type { ArtifactSink } from "../artifacts.ts";
import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import type { CleanupRegistry } from "../cleanup.ts";
import { resultText } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import type { SandboxClient } from "../clients/sandbox.ts";
import { CLI_DIST_ENTRYPOINT, REPO_ROOT } from "../paths.ts";
import type { SecretStore } from "../secrets.ts";
import type { NemoClawInstance } from "./onboarding.ts";

export const CONFIG_EXPORT_EVIDENCE_CONTRACT = "nemoclaw.config-export-evidence/v1" as const;
const EVIDENCE_FILE = "config-export-evidence.v1.json";
const CONFIG_EXPORT_CAPTURE_LIMIT_BYTES = 64 * 1024;
const CONFIG_EXPORT_FILE_LIMIT_BYTES = 1024 * 1024;
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
    byteLength: number;
    sha256: string;
  };
  security: {
    knownSecretsAbsent: boolean | null;
    internalTransportsAbsent: boolean | null;
  };
  cleanup: {
    registeredBeforeExport: boolean;
    succeeded: boolean;
    diagnostic?: string;
  };
  elapsedMs: number;
  failureStage?: ConfigExportFailureStage;
  diagnostic?: string;
}

export interface PolicyReadResult {
  ok: boolean;
  value?: { document: string };
}

export interface ConfigExportRegistryEntry {
  name?: string;
  agent?: string;
  openshellDriver?: string;
  gatewayName?: string;
  provider?: string;
  preferredInferenceApi?: string;
  endpointUrl?: string;
  model?: string;
  credentialEnv?: string;
  workload?: {
    kind?: string;
    reference?: string;
  };
}

export interface ConfigExportRegistry {
  sandboxes: Record<string, ConfigExportRegistryEntry>;
}

interface ConfigExportProviderDocument {
  name: string;
  provider: string;
  api: string;
  endpoint?: string;
  credential?: { env?: string };
}

interface ConfigExportRouteDocument {
  name: string;
  providerRef: string;
  overrides?: { model?: string };
}

interface ConfigExportAgentDocument {
  name?: string;
  type: string;
  inference: { routes: ConfigExportRouteDocument[] };
  observability?: unknown;
}

interface ConfigExportSandboxDocument {
  name: string;
  runtime: { provider: string; image: { ref: string } };
  network: { policy: { explicit: unknown } };
  agents: ConfigExportAgentDocument[];
  integrations?: { webSearch?: unknown };
}

export interface ConfigExportDocument {
  spec: {
    inferenceProviders: ConfigExportProviderDocument[];
    sandboxes: ConfigExportSandboxDocument[];
  };
}

export interface ConfigExportValidationDependencies {
  closeFile(file: number): void;
  exists(filePath: string): boolean;
  inspectFile(filePath: string): { device: number; inode: number; isFile: boolean; size: number };
  inspectOpenFile(file: number): { device: number; inode: number; isFile: boolean; size: number };
  loadManifest(filePath: string): LoadedManifest;
  loadRegistry(): ConfigExportRegistry;
  makeTempDirectory(prefix: string): string;
  now(): number;
  openFileNoFollow(filePath: string): number;
  parseConfig(raw: string): ConfigExportDocument;
  producer(): ConfigExportProducer;
  readOpenFile(file: number, limitBytes: number): string;
  readPolicy?(gatewayName: string, sandboxName: string): Promise<PolicyReadResult>;
  removeDirectory(directory: string): void;
}

const DEFAULT_DEPENDENCIES: ConfigExportValidationDependencies = {
  closeFile: fs.closeSync,
  exists: fs.existsSync,
  inspectFile: (filePath) => {
    const stat = fs.lstatSync(filePath);
    return { device: stat.dev, inode: stat.ino, isFile: stat.isFile(), size: stat.size };
  },
  inspectOpenFile: (file) => {
    const stat = fs.fstatSync(file);
    return { device: stat.dev, inode: stat.ino, isFile: stat.isFile(), size: stat.size };
  },
  loadManifest,
  loadRegistry: readRegistry,
  makeTempDirectory: (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  now: Date.now,
  openFileNoFollow: (filePath) =>
    fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
  parseConfig: parseConfigExport,
  producer: readProducer,
  readOpenFile: (file, limitBytes) => {
    const buffer = Buffer.alloc(limitBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = fs.readSync(file, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
  },
  removeDirectory: (directory) => fs.rmSync(directory, { force: true, recursive: true }),
};

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`exported configuration field '${field}' must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`exported configuration field '${field}' must be an array`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`exported configuration field '${field}' must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function parseProvider(value: unknown, index: number): ConfigExportProviderDocument {
  const provider = requiredRecord(value, `spec.inferenceProviders[${index}]`);
  const credential =
    provider.credential === undefined
      ? undefined
      : requiredRecord(provider.credential, `spec.inferenceProviders[${index}].credential`);
  return {
    name: requiredString(provider.name, `spec.inferenceProviders[${index}].name`),
    provider: requiredString(provider.provider, `spec.inferenceProviders[${index}].provider`),
    api: requiredString(provider.api, `spec.inferenceProviders[${index}].api`),
    ...(optionalString(provider.endpoint, `spec.inferenceProviders[${index}].endpoint`)
      ? { endpoint: provider.endpoint as string }
      : {}),
    ...(credential
      ? {
          credential: {
            env: optionalString(credential.env, `spec.inferenceProviders[${index}].credential.env`),
          },
        }
      : {}),
  };
}

function parseRoute(value: unknown, sandboxIndex: number, agentIndex: number, index: number) {
  const prefix = `spec.sandboxes[${sandboxIndex}].agents[${agentIndex}].inference.routes[${index}]`;
  const route = requiredRecord(value, prefix);
  const overrides =
    route.overrides === undefined
      ? undefined
      : requiredRecord(route.overrides, `${prefix}.overrides`);
  return {
    name: requiredString(route.name, `${prefix}.name`),
    providerRef: requiredString(route.providerRef, `${prefix}.providerRef`),
    ...(overrides
      ? { overrides: { model: optionalString(overrides.model, `${prefix}.overrides.model`) } }
      : {}),
  };
}

function parseAgent(
  value: unknown,
  sandboxIndex: number,
  index: number,
): ConfigExportAgentDocument {
  const prefix = `spec.sandboxes[${sandboxIndex}].agents[${index}]`;
  const agent = requiredRecord(value, prefix);
  const inference = requiredRecord(agent.inference, `${prefix}.inference`);
  return {
    type: requiredString(agent.type, `${prefix}.type`),
    inference: {
      routes: requiredArray(inference.routes, `${prefix}.inference.routes`).map(
        (route, routeIndex) => parseRoute(route, sandboxIndex, index, routeIndex),
      ),
    },
    ...(agent.observability === undefined ? {} : { observability: agent.observability }),
  };
}

function parseSandbox(value: unknown, index: number): ConfigExportSandboxDocument {
  const prefix = `spec.sandboxes[${index}]`;
  const sandbox = requiredRecord(value, prefix);
  const runtime = requiredRecord(sandbox.runtime, `${prefix}.runtime`);
  const image = requiredRecord(runtime.image, `${prefix}.runtime.image`);
  const network = requiredRecord(sandbox.network, `${prefix}.network`);
  const policy = requiredRecord(network.policy, `${prefix}.network.policy`);
  const integrations =
    sandbox.integrations === undefined
      ? undefined
      : requiredRecord(sandbox.integrations, `${prefix}.integrations`);
  return {
    name: requiredString(sandbox.name, `${prefix}.name`),
    runtime: {
      provider: requiredString(runtime.provider, `${prefix}.runtime.provider`),
      image: { ref: requiredString(image.ref, `${prefix}.runtime.image.ref`) },
    },
    network: { policy: { explicit: policy.explicit } },
    agents: requiredArray(sandbox.agents, `${prefix}.agents`).map((agent, agentIndex) =>
      parseAgent(agent, index, agentIndex),
    ),
    ...(integrations ? { integrations: { webSearch: integrations.webSearch } } : {}),
  };
}

export function parseConfigExport(raw: string): ConfigExportDocument {
  const root = requiredRecord(YAML.parse(raw), "document");
  if (root.apiVersion !== "nemoclaw.nvidia.com/v1" || root.kind !== "NemoClawConfig") {
    throw new Error("exported configuration has an unsupported contract");
  }
  const spec = requiredRecord(root.spec, "spec");
  return {
    spec: {
      inferenceProviders: requiredArray(spec.inferenceProviders, "spec.inferenceProviders").map(
        parseProvider,
      ),
      sandboxes: requiredArray(spec.sandboxes, "spec.sandboxes").map(parseSandbox),
    },
  };
}

function readRegistry(): ConfigExportRegistry {
  const registryPath = path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "sandboxes.json");
  const root = requiredRecord(JSON.parse(fs.readFileSync(registryPath, "utf8")), "registry");
  const sandboxes = requiredRecord(root.sandboxes, "registry.sandboxes");
  return { sandboxes: sandboxes as Record<string, ConfigExportRegistryEntry> };
}

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
  sandbox: ConfigExportSandboxDocument | undefined,
  agent: ConfigExportAgentDocument | undefined,
): string[] {
  const features: string[] = [];
  if (sandbox?.integrations?.webSearch) features.push("webSearch");
  if (agent?.type === "openclaw" && agent.observability) features.push("observability");
  return features.sort();
}

function semanticsFromDocument(document: ConfigExportDocument): ConfigExportSemantics {
  const sandbox = document.spec.sandboxes[0];
  const agent = sandbox?.agents[0];
  const route = agent?.inference.routes[0];
  const provider = document.spec.inferenceProviders.find(
    (candidate) => candidate.name === route?.providerRef,
  );
  return {
    sandboxName: sandbox?.name ?? null,
    agent: agent?.type ?? null,
    runtimeProvider: sandbox?.runtime.provider ?? null,
    imageRef: sandbox?.runtime.image.ref ?? null,
    inferenceProviderName: provider?.name ?? null,
    inferenceProvider: provider?.provider ?? null,
    inferenceApi: provider?.api ?? null,
    inferenceEndpoint: provider?.endpoint ?? null,
    model: route?.overrides?.model ?? null,
    credentialReference: provider?.credential?.env ?? null,
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
  readPolicy: (gatewayName: string, sandboxName: string) => Promise<PolicyReadResult>,
): Promise<ConfigExportSemantics> {
  const manifest = dependencies.loadManifest(path.join(REPO_ROOT, target.manifestPath));
  const entry = dependencies.loadRegistry().sandboxes[instance.sandboxName];
  if (!entry) throw new Error("the live sandbox is missing from the NemoClaw registry");
  if (entry.workload?.kind !== "managed-image") {
    throw new Error("automatic config export validation requires an immutable managed image");
  }
  const imageRef = requiredString(entry.workload.reference, "registry workload reference");
  if (!entry.gatewayName) throw new Error("the live sandbox is missing its gateway binding");
  const policy = await readPolicy(entry.gatewayName, instance.sandboxName);
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
    imageRef,
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

function decodedScalarsMatch(
  value: unknown,
  matches: (value: string) => boolean,
  visited = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") return matches(value);
  if (value === null || typeof value !== "object" || visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => decodedScalarsMatch(entry, matches, visited));
  }
  return Object.entries(value).some(
    ([key, entry]) => matches(key) || decodedScalarsMatch(entry, matches, visited),
  );
}

export class ConfigExportValidationPhaseFixture {
  constructor(
    private readonly host: HostCliClient,
    private readonly sandbox: SandboxClient,
    private readonly secrets: SecretStore,
    private readonly cleanup: CleanupRegistry,
    private readonly artifacts: ArtifactSink,
    private readonly dependencies: ConfigExportValidationDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  private async readPolicy(gatewayName: string, sandboxName: string): Promise<PolicyReadResult> {
    if (this.dependencies.readPolicy) {
      return this.dependencies.readPolicy(gatewayName, sandboxName);
    }
    const result = await this.sandbox.openshell(["policy", "get", "--full", sandboxName], {
      artifactName: "config-export-effective-policy",
      env: {
        ...buildAvailabilityProbeEnv(),
        OPENSHELL_GATEWAY: gatewayName,
      },
      redactionValues: this.secrets.redactionValues(),
      timeoutMs: CONFIG_EXPORT_POLICY_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut) return { ok: false };
    const separator = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/u.exec(result.stdout);
    const document = separator
      ? result.stdout.slice(separator.index + separator[0].length)
      : result.stdout;
    return document.trim() === "" ? { ok: false } : { ok: true, value: { document } };
  }

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
    let classification: ConfigExportClassification;
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
          captureLimitBytes: CONFIG_EXPORT_CAPTURE_LIMIT_BYTES,
          redactionValues: this.secrets.redactionValues(),
          timeoutMs: CONFIG_EXPORT_COMMAND_TIMEOUT_MS,
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
      if (result.timedOut || result.signal !== null || result.exitCode === null) {
        throw new Error("config export command did not complete");
      }
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
        const outputFile = this.dependencies.openFileNoFollow(outputPath);
        try {
          const output = this.dependencies.inspectOpenFile(outputFile);
          if (!output.isFile) {
            throw new Error("config export output is not a regular file");
          }
          if (output.size > CONFIG_EXPORT_FILE_LIMIT_BYTES) {
            throw new Error(
              `config export output exceeds the ${CONFIG_EXPORT_FILE_LIMIT_BYTES}-byte limit`,
            );
          }
          raw = this.dependencies.readOpenFile(outputFile, CONFIG_EXPORT_FILE_LIMIT_BYTES);
          if (Buffer.byteLength(raw, "utf8") > CONFIG_EXPORT_FILE_LIMIT_BYTES) {
            throw new Error(
              `config export output exceeds the ${CONFIG_EXPORT_FILE_LIMIT_BYTES}-byte limit`,
            );
          }
          const published = this.dependencies.inspectFile(outputPath);
          if (
            !published.isFile ||
            published.device !== output.device ||
            published.inode !== output.inode
          ) {
            throw new Error("config export output changed while it was being read");
          }
        } finally {
          this.dependencies.closeFile(outputFile);
        }
        failureStage = "security";
        const secretValues = this.secrets.redactionValues();
        const rawSecretsAbsent = !secretValues.some((value) => value && raw!.includes(value));
        failureStage = "verification";
        const decoded = YAML.parse(raw) as unknown;
        failureStage = "security";
        knownSecretsAbsent =
          rawSecretsAbsent &&
          !decodedScalarsMatch(decoded, (value) =>
            secretValues.some((secret) => secret.length > 0 && value.includes(secret)),
          );
        internalTransportsAbsent =
          !INTERNAL_TRANSPORT_PATTERN.test(raw) &&
          !decodedScalarsMatch(decoded, (value) => INTERNAL_TRANSPORT_PATTERN.test(value));
        if (!knownSecretsAbsent) throw new Error("config export exposed a known fixture secret");
        if (!internalTransportsAbsent) {
          throw new Error("config export exposed an internal credential transport");
        }
        failureStage = "verification";
        const document = this.dependencies.parseConfig(raw);
        observed = semanticsFromDocument(document);
        failureStage = "observation";
        expected = await expectedSemantics(
          target,
          instance,
          this.dependencies,
          this.readPolicy.bind(this),
        );
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
    let cleanupDiagnostic: string | undefined;
    try {
      this.dependencies.removeDirectory(directory);
      removed = true;
      cleanupSucceeded = true;
    } catch (error) {
      cleanupDiagnostic = boundedDiagnostic(this.secrets, error);
      if (classification !== "failure") {
        diagnostic = cleanupDiagnostic;
        failureStage = "cleanup";
      }
      classification = "failure";
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
      ...(passed && cleanupSucceeded && raw
        ? {
            export: {
              bytes: raw,
              byteLength: Buffer.byteLength(raw, "utf8"),
              sha256: sha256(raw),
            },
          }
        : {}),
      security: { knownSecretsAbsent, internalTransportsAbsent },
      cleanup: {
        registeredBeforeExport: true,
        succeeded: cleanupSucceeded,
        ...(cleanupDiagnostic ? { diagnostic: cleanupDiagnostic } : {}),
      },
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
