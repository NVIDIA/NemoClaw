// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import type * as TypeBoxValueModule from "typebox/value" with { "resolution-mode": "import" };
import YAML from "yaml";
import {
  V1ALPHA1_EXPORT_API_VERSION,
  type V1Alpha1Export,
} from "../../../../src/lib/config/v1alpha1-export.ts";
import { unsafeEndpointUrlViolation } from "../../../../src/lib/core/endpoint-url-safety.ts";
import { V1ALPHA1_RUNTIME_DEFAULTS_REVISION } from "../../../../src/lib/domain/config/v1alpha1-runtime-defaults.ts";
import { decodeManagedStartupProfile } from "../../../../src/lib/onboard/managed-startup/profile.ts";
import type { SandboxEntry } from "../../../../src/lib/state/registry/types.ts";
import {
  expectedPinnedV1HermesNativeSettings,
  type PinnedV1ConsumerEvidence,
  type PinnedV1OpenClawNativeSettings,
  validateConfigExportWithPinnedV1,
} from "../../../support/v1-config-consumer.ts";
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
import {
  HOSTED_INFERENCE_CREDENTIAL_ENV,
  HOSTED_INFERENCE_PROVIDER_NAME,
  HOSTED_INFERENCE_SECRET,
} from "../hosted-inference.ts";
import { CLI_DIST_ENTRYPOINT, REPO_ROOT } from "../paths.ts";
import type { SecretStore } from "../secrets.ts";
import type { NemoClawInstance } from "./onboarding.ts";

const { Type } = require("typebox") as typeof TypeBoxModule;
const { Check } = require("typebox/value") as typeof TypeBoxValueModule;

export const CONFIG_EXPORT_EVIDENCE_CONTRACT = "nemoclaw.config-export-evidence/v1" as const;
const EVIDENCE_FILE = "config-export-evidence.v1.json";
const EXPORT_FILE = "config-export.yaml";
const CONFIG_EXPORT_CAPTURE_LIMIT_BYTES = 64 * 1024;
const CONFIG_EXPORT_FILE_LIMIT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_LENGTH = 2_048;
const INTERNAL_TRANSPORT_PATTERN = /NEMOCLAW_[A-Z0-9_]+|openshell:resolve:env:/u;
const INTERNAL_TRANSPORT_MARKERS = ["NEMOCLAW_", "openshell:resolve:env"] as const;
const V1ALPHA1_NAME_PATTERN = "^[a-z][a-z0-9-]{0,39}$";
const V1ALPHA1_UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const V1ALPHA1_IMAGE_PATTERN = "^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$";

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const LocalNameSchema = Type.String({ pattern: V1ALPHA1_NAME_PATTERN });
const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
const CredentialSchema = Type.Object(
  { env: NonEmptyStringSchema },
  { additionalProperties: false },
);
const ExportRouteSchema = Type.Object(
  {
    name: LocalNameSchema,
    providerRef: LocalNameSchema,
    overrides: Type.Object({ model: NonEmptyStringSchema }, { additionalProperties: true }),
  },
  { additionalProperties: false },
);
const ExportAgentSchema = Type.Object(
  {
    name: LocalNameSchema,
    inference: Type.Object(
      { routes: Type.Array(ExportRouteSchema, { minItems: 1 }) },
      { additionalProperties: false },
    ),
    auth: Type.Optional(
      Type.Object({ method: Type.Literal("api-key") }, { additionalProperties: false }),
    ),
    tools: Type.Optional(
      Type.Union([
        Type.Object(
          { disclosure: Type.Union([Type.Literal("direct"), Type.Literal("progressive")]) },
          { additionalProperties: false },
        ),
        Type.Object(
          { allow: Type.Array(Type.Literal("read"), { minItems: 1, maxItems: 1 }) },
          { additionalProperties: false },
        ),
      ]),
    ),
    integrationRefs: Type.Optional(
      Type.Array(Type.Literal("brave-search"), { minItems: 1, maxItems: 1 }),
    ),
  },
  { additionalProperties: false },
);
const ExportHarnessFields = {
  execution: Type.Optional(
    Type.Object(
      {
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
        heartbeatEvery: Type.Optional(NonEmptyStringSchema),
      },
      { additionalProperties: false, minProperties: 1 },
    ),
  ),
  interfaces: Type.Optional(UnknownRecordSchema),
  observability: Type.Optional(UnknownRecordSchema),
};
const ExportSandboxFields = {
  name: LocalNameSchema,
  runtime: Type.Object({ provider: Type.Literal("docker") }, { additionalProperties: false }),
  network: Type.Object(
    {
      policy: Type.Object({ explicit: UnknownRecordSchema }, { additionalProperties: false }),
      proxy: Type.Optional(
        Type.Object(
          { host: NonEmptyStringSchema, port: Type.Integer({ minimum: 1, maximum: 65_535 }) },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  integrations: Type.Optional(
    Type.Object(
      {
        "brave-search": Type.Object(
          {
            kind: Type.Literal("webSearch"),
            provider: Type.Literal("brave"),
            credential: CredentialSchema,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  ),
};
const DeepAgentsExportSandboxSchema = Type.Object(
  {
    ...ExportSandboxFields,
    image: Type.Object(
      { ref: Type.String({ pattern: V1ALPHA1_IMAGE_PATTERN }) },
      { additionalProperties: false },
    ),
    harness: Type.Object(
      { kind: Type.Literal("deepagents"), ...ExportHarnessFields },
      { additionalProperties: false },
    ),
    agent: ExportAgentSchema,
  },
  { additionalProperties: false },
);
const AgentExportSandboxSchema = Type.Object(
  {
    ...ExportSandboxFields,
    harness: Type.Object(
      {
        kind: Type.Union([Type.Literal("hermes"), Type.Literal("openclaw")]),
        ...ExportHarnessFields,
      },
      { additionalProperties: false },
    ),
    agent: ExportAgentSchema,
  },
  { additionalProperties: false },
);
const HostedInferenceProviderSchema = Type.Object(
  {
    name: LocalNameSchema,
    provider: Type.Union([Type.Literal("anthropic"), Type.Literal("openai")]),
    api: Type.Union([
      Type.Literal("anthropic-messages"),
      Type.Literal("openai-completions"),
      Type.Literal("openai-responses"),
    ]),
    endpoint: NonEmptyStringSchema,
    credential: Type.Optional(CredentialSchema),
  },
  { additionalProperties: false },
);
const ServiceInferenceProviderSchema = Type.Object(
  {
    name: LocalNameSchema,
    provider: Type.Literal("openai"),
    api: Type.Literal("openai-completions"),
    serviceRef: LocalNameSchema,
  },
  { additionalProperties: false },
);
const OllamaProxyServiceSchema = Type.Object(
  {
    kind: Type.Literal("ollamaProxy"),
    image: Type.Null(),
    endpoint: NonEmptyStringSchema,
    upstream: Type.Object(
      {
        endpoint: NonEmptyStringSchema,
        model: Type.Object(
          {
            name: NonEmptyStringSchema,
            digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const VllmServiceSchema = Type.Object(
  {
    kind: Type.Literal("vllm"),
    authentication: Type.Literal("bearer"),
    hardware: Type.Object(
      {
        architecture: Type.Literal("amd64"),
        minComputeCapability: Type.Literal(90),
        minGpuMemoryBytes: Type.Literal(96_000_000_000),
        minDriverMajor: Type.Literal(580),
      },
      { additionalProperties: false },
    ),
    container: Type.Object(
      { ipc: Type.Literal("host"), sharedMemoryGiB: Type.Literal(32) },
      { additionalProperties: false },
    ),
    image: Type.Null(),
    model: Type.Object(
      {
        repository: Type.Literal("nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4"),
        revision: Type.Literal("0dcd680e5585c791728c83342b311d0a0026dbeb"),
      },
      { additionalProperties: false },
    ),
    serving: Type.Object(
      {
        modelName: Type.Literal("nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4"),
        mambaBackend: Type.Literal("flashinfer"),
        enforceEager: Type.Literal(false),
        toolParser: Type.Literal("qwen3_coder"),
        reasoningParser: Type.Literal("nemotron_v3"),
        port: Type.Integer({ minimum: 1, maximum: 65_535 }),
        contextTokens: Type.Literal(65_536),
        maxSequences: Type.Literal(1),
        batchTokens: Type.Literal(4096),
        startupTimeoutSeconds: Type.Literal(1800),
      },
      { additionalProperties: false },
    ),
    memory: Type.Object(
      { gpuMemoryUtilization: Type.Literal(0.75) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const ConfigExportDocumentSchema = Type.Object(
  {
    apiVersion: Type.Literal(V1ALPHA1_EXPORT_API_VERSION),
    kind: Type.Literal("NemoClawConfig"),
    metadata: Type.Object(
      {
        name: LocalNameSchema,
        uid: Type.String({ pattern: V1ALPHA1_UUID_PATTERN }),
      },
      { additionalProperties: false },
    ),
    spec: Type.Object(
      {
        gateway: Type.Object(
          {
            management: Type.Literal("managed"),
            endpoint: NonEmptyStringSchema,
          },
          { additionalProperties: false },
        ),
        services: Type.Optional(
          Type.Record(LocalNameSchema, Type.Union([OllamaProxyServiceSchema, VllmServiceSchema])),
        ),
        inferenceProviders: Type.Array(
          Type.Union([HostedInferenceProviderSchema, ServiceInferenceProviderSchema]),
          { minItems: 1 },
        ),
        sandboxes: Type.Array(
          Type.Union([DeepAgentsExportSandboxSchema, AgentExportSandboxSchema]),
          { minItems: 1, maxItems: 1 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

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
  consumer?: PinnedV1ConsumerEvidence & {
    expected: PinnedV1ConsumerEvidence;
    actual: PinnedV1ConsumerEvidence;
    passed: boolean;
  };
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

export type ConfigExportRegistryEntry = Pick<
  SandboxEntry,
  | "name"
  | "agent"
  | "openshellDriver"
  | "gatewayName"
  | "provider"
  | "preferredInferenceApi"
  | "endpointUrl"
  | "model"
  | "credentialEnv"
  | "dcodeAutoApprovalMode"
  | "hermesApiPort"
  | "hermesDashboardEnabled"
  | "hermesDashboardPort"
  | "hermesDashboardInternalPort"
  | "hermesDashboardTui"
  | "workload"
  | "observabilityEnabled"
  | "toolDisclosure"
  | "webSearchEnabled"
  | "webSearchProvider"
>;

export interface ConfigExportRegistry {
  sandboxes: Record<string, ConfigExportRegistryEntry>;
}

export type ConfigExportDocument = V1Alpha1Export;

export interface ConfigExportValidationDependencies {
  closeFile(file: number): void;
  inspectFile(filePath: string): {
    device: number;
    inode: number;
    isFile: boolean;
    linkCount: number;
    size: number;
  };
  inspectOpenFile(file: number): {
    device: number;
    inode: number;
    isFile: boolean;
    linkCount: number;
    size: number;
  };
  loadManifest(filePath: string): LoadedManifest;
  loadRegistry(): ConfigExportRegistry;
  makeTempDirectory(prefix: string): string;
  now(): number;
  openFileNoFollow(filePath: string): number;
  parseConfig(raw: string): ConfigExportDocument;
  producer(): ConfigExportProducer;
  readOpenFile(file: number, limitBytes: number): string;
  removeDirectory(directory: string): void;
  validateWithPinnedV1(raw: string): PinnedV1ConsumerEvidence;
}

const DEFAULT_DEPENDENCIES: ConfigExportValidationDependencies = {
  closeFile: fs.closeSync,
  inspectFile: (filePath) => {
    const stat = fs.lstatSync(filePath);
    return {
      device: stat.dev,
      inode: stat.ino,
      isFile: stat.isFile(),
      linkCount: stat.nlink,
      size: stat.size,
    };
  },
  inspectOpenFile: (file) => {
    const stat = fs.fstatSync(file);
    return {
      device: stat.dev,
      inode: stat.ino,
      isFile: stat.isFile(),
      linkCount: stat.nlink,
      size: stat.size,
    };
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
  validateWithPinnedV1: validateConfigExportWithPinnedV1,
};

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`exported configuration field '${field}' must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`exported configuration field '${field}' must be a non-empty string`);
  }
  return value;
}

export function parseConfigExport(raw: string): ConfigExportDocument {
  const document: unknown = YAML.parse(raw);
  if (!Check(ConfigExportDocumentSchema, document)) {
    throw new Error("exported configuration must match the complete v1alpha1 export contract");
  }
  return document as ConfigExportDocument;
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

function exportedHarnessKind(agent: string | null | undefined): string | null {
  if (agent === "langchain-deepagents-code") return "deepagents";
  return agent ?? null;
}

function exportedProviderName(provider: string | null | undefined): string | null {
  if (!provider) return null;
  const normalized = provider
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "");
  return `hosted-${normalized || "provider"}`.slice(0, 40).replace(/[^a-z0-9]+$/gu, "");
}

function expectedOpenclawNativeSettings(
  entry: ConfigExportRegistryEntry,
): PinnedV1OpenClawNativeSettings | undefined {
  if (entry.agent !== "openclaw" || entry.workload?.kind !== "managed-image") return undefined;
  const profile = decodeManagedStartupProfile(entry.workload.encodedProfile);
  const { agentConfig, dashboard, tuning } = profile;
  if (
    profile.agent !== "openclaw" ||
    agentConfig.agent !== "openclaw" ||
    dashboard.agent !== "openclaw" ||
    tuning.contextWindow === null ||
    tuning.maxTokens === null ||
    tuning.reasoning === null ||
    tuning.reasoningEffort === null
  ) {
    throw new Error("the live OpenClaw source profile is incomplete");
  }
  return {
    model: {
      contextWindow: tuning.contextWindow,
      maxTokens: tuning.maxTokens,
      reasoning: tuning.reasoning,
    },
    reasoningEffort: tuning.reasoningEffort,
    execution: {
      timeoutSeconds: agentConfig.agentTimeoutSeconds,
      heartbeatEvery: agentConfig.heartbeatEvery,
    },
    dashboard: {
      enabled: true,
      port: dashboard.port,
      bind: dashboard.bindAddress === "0.0.0.0" ? "lan" : "loopback",
    },
    toolDisclosure: profile.tools.disclosure,
  };
}

function expectedPinnedV1Evidence(entry: ConfigExportRegistryEntry): PinnedV1ConsumerEvidence {
  const openclawNativeSettings = expectedOpenclawNativeSettings(entry);
  const hermesNativeSettings =
    entry.agent === "hermes" ? expectedPinnedV1HermesNativeSettings(entry) : undefined;
  return {
    revision: V1ALPHA1_RUNTIME_DEFAULTS_REVISION,
    compiledSandboxes: 1,
    ...(openclawNativeSettings
      ? {
          contextWindows: [openclawNativeSettings.model.contextWindow],
          openclawNativeSettings: { [entry.name]: openclawNativeSettings },
        }
      : {}),
    ...(hermesNativeSettings
      ? { hermesNativeSettings: { [entry.name]: hermesNativeSettings } }
      : {}),
    openclawNativeSettingsVerified: entry.agent === "openclaw" ? 1 : 0,
    hermesNativeSettingsVerified: entry.agent === "hermes" ? 1 : 0,
  };
}

function comparablePinnedV1Evidence(
  evidence: PinnedV1ConsumerEvidence,
  expected: PinnedV1ConsumerEvidence,
  sandboxName: string,
): PinnedV1ConsumerEvidence {
  const actualHermesNativeSettings = evidence.hermesNativeSettings?.[sandboxName];
  const actualNativeSettings = evidence.openclawNativeSettings?.[sandboxName];
  return {
    revision: evidence.revision,
    compiledSandboxes: evidence.compiledSandboxes,
    ...(expected.contextWindows ? { contextWindows: evidence.contextWindows } : {}),
    ...(expected.openclawNativeSettings
      ? {
          openclawNativeSettings: actualNativeSettings
            ? { [sandboxName]: actualNativeSettings }
            : {},
        }
      : {}),
    ...(expected.hermesNativeSettings
      ? {
          hermesNativeSettings: actualHermesNativeSettings
            ? { [sandboxName]: actualHermesNativeSettings }
            : {},
        }
      : {}),
    openclawNativeSettingsVerified: evidence.openclawNativeSettingsVerified,
    hermesNativeSettingsVerified: evidence.hermesNativeSettingsVerified,
  };
}

function targetPolicyForV1Alpha1(value: unknown, agent: string | null | undefined): unknown {
  const policy = structuredClone(requiredRecord(value, "effective policy"));
  const process = policy.process as Record<string, unknown> | undefined;
  if (process && typeof process === "object" && !Array.isArray(process)) {
    if (process.run_as_user === "sandbox") process.run_as_user = "1000";
    if (process.run_as_group === "sandbox") process.run_as_group = "1000";
  }
  const filesystem = policy.filesystem_policy as Record<string, unknown> | undefined;
  if (filesystem && typeof filesystem === "object" && !Array.isArray(filesystem)) {
    const readOnly = Array.isArray(filesystem.read_only) ? [...filesystem.read_only] : [];
    const readWrite = Array.isArray(filesystem.read_write) ? filesystem.read_write : [];
    const roots = [
      "/opt/fabric",
      "/opt/nemoclaw",
      ...(agent === "openclaw" ? ["/app"] : agent === "hermes" ? ["/opt/hermes"] : []),
    ];
    for (const root of roots) {
      if (!readOnly.includes(root) && !readWrite.includes(root)) readOnly.push(root);
    }
    filesystem.read_only = readOnly;
  }
  return policy;
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
    .filter(([name, value]) => ["observability", "webSearch"].includes(name) && value === true)
    .map(([name]) => name)
    .sort();
}

function observedFeatures(
  sandbox: V1Alpha1Export["spec"]["sandboxes"][number] | undefined,
): string[] {
  const features: string[] = [];
  if (sandbox?.integrations?.["brave-search"]) features.push("webSearch");
  if (sandbox?.harness.observability) features.push("observability");
  return features.sort();
}

async function readEffectivePolicyDocument(
  host: HostCliClient,
  secrets: SecretStore,
  gatewayName: string,
  sandboxName: string,
): Promise<string> {
  const { createCliOpenShellSandboxPolicyReader, namedOpenShellGateway } =
    await import("../../../../src/lib/adapters/openshell/sandbox-policy-cli.ts");
  const reader = createCliOpenShellSandboxPolicyReader({
    capture: async (args, options) => {
      const result = await host.command(host.openshellCommandPath, args, {
        artifactName: "config-export-effective-policy",
        env: buildAvailabilityProbeEnv(),
        captureLimitBytes: options.outputLimitBytes,
        persistArtifacts: false,
        redactionValues: secrets.redactionValues(),
        timeoutMs: options.timeout,
      });
      if (
        Buffer.byteLength(result.stdout, "utf8") > options.outputLimitBytes ||
        /^\[shell-probe omitted \d+ earlier bytes;/u.test(result.stdout)
      ) {
        throw new Error("the effective sandbox policy exceeds the observation limit");
      }
      return {
        status: result.exitCode,
        output: `${result.stderr}\n${result.stdout}`.trim(),
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.timedOut
          ? {
              error: Object.assign(new Error("OpenShell policy read timed out"), {
                code: "ETIMEDOUT",
              }),
            }
          : {}),
      };
    },
    defaultTimeoutMs: CONFIG_EXPORT_POLICY_TIMEOUT_MS,
  });
  const policy = await reader.readSandboxPolicy({
    target: namedOpenShellGateway(gatewayName),
    sandboxName,
    scope: "effective",
  });
  if (!policy.ok) {
    throw new Error("the effective sandbox policy could not be read");
  }
  return policy.value.document;
}

function semanticsFromDocument(document: ConfigExportDocument): ConfigExportSemantics {
  const sandbox = document.spec.sandboxes[0];
  const agent = sandbox?.agent;
  const route = agent?.inference.routes[0];
  const provider = document.spec.inferenceProviders.find(
    (candidate) => candidate.name === route?.providerRef,
  );
  return {
    sandboxName: sandbox?.name ?? null,
    agent: sandbox?.harness.kind ?? null,
    runtimeProvider: sandbox?.runtime.provider ?? null,
    imageRef: sandbox?.image?.ref ?? null,
    inferenceProviderName: provider?.name ?? null,
    inferenceProvider: provider?.provider ?? null,
    inferenceApi: provider?.api ?? null,
    inferenceEndpoint: provider?.endpoint ?? null,
    model: route?.overrides?.model ?? null,
    credentialReference:
      provider && "credential" in provider ? (provider.credential?.env ?? null) : null,
    routeName: route?.name ?? null,
    routeProviderReference: route?.providerRef ?? null,
    policySha256: sandbox ? sha256(canonicalJson(sandbox.network.policy.explicit)) : null,
    enabledFeatures: observedFeatures(sandbox),
  };
}

async function expectedSemantics(
  target: TargetDefinition,
  instance: NemoClawInstance,
  host: HostCliClient,
  secrets: SecretStore,
  dependencies: ConfigExportValidationDependencies,
): Promise<ConfigExportSemantics> {
  const manifest = dependencies.loadManifest(path.join(REPO_ROOT, target.manifestPath));
  const entry = dependencies.loadRegistry().sandboxes[instance.sandboxName];
  if (!entry) throw new Error("the live sandbox is missing from the NemoClaw registry");
  if (
    entry.name !== instance.sandboxName ||
    entry.agent !== manifest.document.spec.onboarding.agent
  ) {
    throw new Error("the live sandbox identity does not match the target manifest");
  }
  if (entry.workload?.kind !== "managed-image") {
    throw new Error("automatic config export validation requires an immutable managed image");
  }
  requiredString(entry.workload.reference, "registry workload reference");
  if (!entry.gatewayName) throw new Error("the live sandbox is missing its gateway binding");
  if (unsafeEndpointUrlViolation(entry.endpointUrl)) {
    throw new Error("the live inference endpoint is unsafe");
  }
  const policyDocument = await readEffectivePolicyDocument(
    host,
    secrets,
    entry.gatewayName,
    instance.sandboxName,
  );
  const credentialReference = entry.credentialEnv ?? null;
  const usesHostedAdapter =
    process.env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE === "1" &&
    manifest.document.spec.onboarding.provider === "nvidia" &&
    entry.provider === HOSTED_INFERENCE_PROVIDER_NAME;
  const declaredCredentialReferences = (manifest.document.spec.state?.credentialRefs ?? []).map(
    (reference) =>
      usesHostedAdapter && reference === HOSTED_INFERENCE_SECRET
        ? HOSTED_INFERENCE_CREDENTIAL_ENV
        : reference,
  );
  if (credentialReference && !declaredCredentialReferences.includes(credentialReference)) {
    throw new Error("the live credential reference is not declared by the target manifest");
  }
  if (entry.agent === "langchain-deepagents-code") {
    if (
      entry.dcodeAutoApprovalMode !== "disabled" ||
      entry.observabilityEnabled !== false ||
      entry.webSearchEnabled === true ||
      (entry.webSearchProvider !== undefined && entry.webSearchProvider !== null) ||
      (entry.toolDisclosure !== undefined && entry.toolDisclosure !== "progressive")
    ) {
      throw new Error("the live Deep Agents sandbox is not at the exportable disabled baseline");
    }
  }
  const expectedPolicy = targetPolicyForV1Alpha1(YAML.parse(policyDocument), entry.agent);
  return {
    sandboxName: instance.sandboxName,
    agent: exportedHarnessKind(manifest.document.spec.onboarding.agent),
    runtimeProvider: entry.openshellDriver ?? null,
    imageRef:
      entry.agent === "langchain-deepagents-code"
        ? requiredString(entry.workload.reference, "registry workload reference")
        : null,
    inferenceProviderName: exportedProviderName(entry.provider),
    inferenceProvider:
      entry.preferredInferenceApi === "anthropic-messages" ? "anthropic" : "openai",
    inferenceApi: entry.preferredInferenceApi ?? null,
    inferenceEndpoint: entry.endpointUrl ?? null,
    model: entry.model ?? null,
    credentialReference,
    routeName: "primary",
    routeProviderReference: null,
    policySha256: sha256(canonicalJson(expectedPolicy)),
    enabledFeatures:
      entry.agent === "langchain-deepagents-code" ? [] : enabledManifestFeatures(manifest),
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
    "inferenceProviderName",
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
  if (
    containsKnownSecretText(raw, secretStore.redactionValues()) ||
    containsInternalTransportText(raw)
  ) {
    return "[REDACTED]";
  }
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
  if (value instanceof Uint8Array) return matches(Buffer.from(value).toString("utf8"));
  if (value === null || typeof value !== "object" || visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => decodedScalarsMatch(entry, matches, visited));
  }
  return Object.entries(value).some(
    ([key, entry]) => matches(key) || decodedScalarsMatch(entry, matches, visited),
  );
}

function encodedSensitiveValues(values: readonly string[]): string[] {
  const encoded = new Set<string>();
  for (const value of values) {
    if (value.length === 0) continue;
    const base64 = Buffer.from(value, "utf8").toString("base64");
    encoded.add(base64);
    encoded.add(base64.replace(/=+$/u, ""));
    const base64url = base64.replace(/\+/gu, "-").replace(/\//gu, "_");
    encoded.add(base64url);
    encoded.add(base64url.replace(/=+$/u, ""));
  }
  return [...encoded];
}

function decodePercentEncodedText(raw: string): string {
  let decoded = raw;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    });
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

function normalizedSecretScanText(raw: string): string {
  const decodedEscapes = decodePercentEncodedText(raw)
    .replace(/\\x([0-9a-f]{2})/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\U([0-9a-f]{8})/gu, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/\\[nrt]/gu, "");
  return decodedEscapes.replace(/[\s#'"`>|\\]/gu, "");
}

function containsSensitiveText(raw: string, values: readonly string[]): boolean {
  const normalizedRaw = normalizedSecretScanText(raw);
  return [...values, ...encodedSensitiveValues(values)].some(
    (value) => value.length > 0 && normalizedRaw.includes(normalizedSecretScanText(value)),
  );
}

function containsKnownSecretText(raw: string, secretValues: readonly string[]): boolean {
  return containsSensitiveText(raw, secretValues);
}

function containsInternalTransportText(raw: string): boolean {
  return containsSensitiveText(raw, INTERNAL_TRANSPORT_MARKERS);
}

export interface ConfigExportArtifactSafety {
  readonly internalTransportsAbsent: boolean;
  readonly knownSecretsAbsent: boolean;
}

/** Inspect raw and decoded YAML before it crosses the retained-artifact boundary. */
export function inspectConfigExportArtifactSafety(
  raw: string,
  secretValues: readonly string[],
  decoded: unknown = YAML.parse(raw),
): ConfigExportArtifactSafety {
  const encodedSecrets = encodedSensitiveValues(secretValues);
  return {
    knownSecretsAbsent:
      !containsKnownSecretText(raw, secretValues) &&
      !decodedScalarsMatch(decoded, (value) =>
        [...secretValues, ...encodedSecrets].some(
          (secret) => secret.length > 0 && value.includes(secret),
        ),
      ),
    internalTransportsAbsent:
      !containsInternalTransportText(raw) &&
      !decodedScalarsMatch(decoded, (value) => INTERNAL_TRANSPORT_PATTERN.test(value)),
  };
}

export class ConfigExportValidationPhaseFixture {
  constructor(
    private readonly host: HostCliClient,
    private readonly secrets: SecretStore,
    private readonly cleanup: CleanupRegistry,
    private readonly artifacts: ArtifactSink,
    private readonly dependencies: ConfigExportValidationDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  private outputEntryExists(filePath: string): boolean {
    try {
      this.dependencies.inspectFile(filePath);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
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
    let failureStage: ConfigExportFailureStage =
      expectation === "required" ? "observation" : "transport";
    let observedRefusalCategory: string | undefined;
    let command: ConfigExportCommandOutcome | undefined;
    let consumer: ConfigExportEvidenceEnvelope["consumer"];
    let expectedConsumerEvidence: PinnedV1ConsumerEvidence | undefined;
    let registryBeforeExport: ConfigExportRegistry["sandboxes"] | undefined;

    try {
      if (expectation === "required") {
        expected = await expectedSemantics(
          target,
          instance,
          this.host,
          this.secrets,
          this.dependencies,
        );
        const registry = this.dependencies.loadRegistry();
        const sourceEntry = registry.sandboxes[instance.sandboxName];
        if (!sourceEntry) {
          throw new Error("the live sandbox disappeared before config export");
        }
        expectedConsumerEvidence = expectedPinnedV1Evidence(sourceEntry);
        registryBeforeExport = structuredClone(registry.sandboxes);
      }
      failureStage = "transport";
      const result = await this.host.nemoclaw(
        ["config", "export", instance.sandboxName, "--output", outputPath, "--json"],
        {
          artifactName: "config-export-automatic",
          env: buildAvailabilityProbeEnv(),
          captureLimitBytes: CONFIG_EXPORT_CAPTURE_LIMIT_BYTES,
          persistArtifacts: false,
          redactionValues: this.secrets.redactionValues(),
          timeoutMs: CONFIG_EXPORT_COMMAND_TIMEOUT_MS,
        },
      );
      const outputExists = this.outputEntryExists(outputPath);
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
          if (output.linkCount !== 1) {
            throw new Error("config export output must have exactly one hard link");
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
            published.linkCount !== 1 ||
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
        failureStage = "verification";
        const decoded = YAML.parse(raw) as unknown;
        failureStage = "security";
        ({ knownSecretsAbsent, internalTransportsAbsent } = inspectConfigExportArtifactSafety(
          raw,
          secretValues,
          decoded,
        ));
        if (!knownSecretsAbsent) throw new Error("config export exposed a known fixture secret");
        if (!internalTransportsAbsent) {
          throw new Error("config export exposed an internal credential transport");
        }
        if (this.artifacts.redact(raw) !== raw) {
          throw new Error("config export contains secret-shaped material");
        }
        failureStage = "verification";
        const document = this.dependencies.parseConfig(raw);
        observed = semanticsFromDocument(document);
        failureStage = "verification";
        if (!expected) throw new Error("config export expectations were not captured");
        verifications = compareSemantics(expected, observed);
        const registryAfterExport = this.dependencies.loadRegistry().sandboxes;
        verifications.push({
          id: "sourceRegistryUnchanged",
          passed: isDeepStrictEqual(registryAfterExport, registryBeforeExport),
          expected: registryBeforeExport,
          actual: registryAfterExport,
        });
        const failed = verifications.filter((verification) => !verification.passed);
        if (failed.length > 0) {
          throw new Error(
            `config export omitted or changed expected semantics: ${failed.map((entry) => entry.id).join(", ")}`,
          );
        }
        if (!expectedConsumerEvidence) throw new Error("pinned v1 expectations were not captured");
        consumer = {
          revision: V1ALPHA1_RUNTIME_DEFAULTS_REVISION,
          expected: expectedConsumerEvidence,
          actual: { revision: V1ALPHA1_RUNTIME_DEFAULTS_REVISION },
          passed: false,
        };
        const consumerEvidence = this.dependencies.validateWithPinnedV1(raw);
        const actualConsumerEvidence = comparablePinnedV1Evidence(
          consumerEvidence,
          expectedConsumerEvidence,
          instance.sandboxName,
        );
        const consumerPassed = isDeepStrictEqual(actualConsumerEvidence, expectedConsumerEvidence);
        verifications.push({
          id: "consumerNativeSettings",
          passed: consumerPassed,
          expected: expectedConsumerEvidence,
          actual: actualConsumerEvidence,
        });
        consumer = {
          ...consumerEvidence,
          expected: expectedConsumerEvidence,
          actual: actualConsumerEvidence,
          passed: consumerPassed,
        };
        if (!consumerPassed) {
          throw new Error("pinned v1 consumer evidence differs from the live source profile");
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
    const publishedRaw = passed && cleanupSucceeded && raw ? raw : undefined;
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
      ...(consumer ? { consumer } : {}),
      ...(publishedRaw
        ? {
            export: {
              bytes: publishedRaw,
              byteLength: Buffer.byteLength(publishedRaw, "utf8"),
              sha256: sha256(publishedRaw),
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
    if (evidence.classification === "success" && evidence.export) {
      await this.artifacts.writeText(EXPORT_FILE, evidence.export.bytes);
    }
    if (!evidence.passed) {
      throw new Error(
        `automatic config export validation failed for '${target.id}': ${diagnostic ?? "unknown failure"}`,
      );
    }
    return evidence;
  }
}
