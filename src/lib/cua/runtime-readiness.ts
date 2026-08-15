// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import path from "node:path";

import type { InferenceSelectionInput } from "../inference/selection";
import { normalizeInferenceSelection } from "../inference/selection";
import { readBoundedRegularFile } from "./bounded-file";
import { type CuaBuildIdentity, resolveCurrentCuaBuildIdentity } from "./build-identity";
import {
  CUA_CAPABILITIES,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_SECURITY_OPERATIONS,
  CUA_TARGET_OPERATIONS,
  CUA_TASK_OPERATIONS,
  type CuaAppliedPolicyIdentity,
  type CuaComponentIdentity,
  type CuaInferenceIdentity,
  type CuaRuntimeReadiness,
} from "./contract";
import {
  CUA_QUALIFICATION_ENVIRONMENT_ENV,
  isCuaFrameworkEnabled,
  isCuaQualificationEnabled,
} from "./feature";
import { snapshotCuaOpenshellExecutable } from "./openshell-authority";
import { parseCuaQualificationEnvironment } from "./qualification-evidence";
import {
  assertCuaAuthorityFileOwnership,
  type CuaArchiveArtifactIdentity,
  type CuaImageArtifactIdentity,
  type CuaRuntimeManifest,
  getCuaSandboxImageRef,
  verifyCuaRuntimeAuthorityPayload,
} from "./runtime-manifest";
import { parseCuaRuntimeReadiness } from "./schema";
import {
  CUA_DOMAIN_COORDINATE,
  CUA_HOST_COORDINATE,
  CUA_SENSITIVE_VALUE,
  canonicalJsonSha256,
} from "./shared-primitives";

const SAFE_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$/;
const SAFE_ROUTE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_CREDENTIAL_ENV = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_QUALIFICATION_ENVIRONMENT_BYTES = 4096;

export type CuaReadinessAcceptance = "final" | "candidate-qualification";

export type CuaInferenceRouteInput = InferenceSelectionInput;

export interface CuaRuntimeReadinessContext {
  agentName: string | null | undefined;
  recordedInference: CuaInferenceRouteInput;
  liveInference?: CuaInferenceRouteInput;
  liveProviderAuthorityDigest?: string;
  liveAppliedPolicy?: CuaAppliedPolicyIdentity;
  acceptance?: CuaReadinessAcceptance;
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  buildIdentity?: CuaBuildIdentity;
  /** Exact executable already selected by the OpenShell command facade. */
  openshellBinary?: string;
  /** Digest of the exact snapshot used for the preceding live observation. */
  expectedOpenshellDigest?: string;
}

function digestJson(value: unknown): string {
  return canonicalJsonSha256(value);
}

function contentDigest(value: unknown): string {
  return `sha256:${digestJson(value)}`;
}

function safePublicValue(
  value: string,
  pattern: RegExp,
  label: string,
  rejectDomain = false,
): string {
  if (
    !pattern.test(value) ||
    CUA_SENSITIVE_VALUE.test(value) ||
    CUA_HOST_COORDINATE.test(value) ||
    (rejectDomain && CUA_DOMAIN_COORDINATE.test(value)) ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`${label} must be a printable coordinate- and credential-free identity`);
  }
  return value;
}

function canonicalEndpoint(value: string | null): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CUA inference endpoint must be an absolute HTTP(S) URL");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("CUA inference endpoint must not contain credentials, query, or fragment");
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "" : "");
}

/**
 * Compute the serialized identity of every credential-free field that selects an inference route.
 * Credential values are never read; only the configured environment-variable name is bound.
 */
export function getCuaInferenceRouteIdentity(input: CuaInferenceRouteInput): CuaInferenceIdentity {
  const route = normalizeInferenceSelection(input);
  if (!route.provider || !route.model) {
    throw new Error("CUA inference route requires provider and model");
  }
  const provider = safePublicValue(route.provider, SAFE_PROVIDER, "inference.provider", true);
  const model = safePublicValue(route.model, SAFE_MODEL, "inference.model");
  const endpointSource = route.endpointSource;
  const preferredInferenceApi = route.preferredInferenceApi;
  const credentialEnv = route.credentialEnv;
  const nimContainer = route.nimContainer;
  const compatibleEndpointReasoning = route.compatibleEndpointReasoning;
  const compatibleEndpointReasoningEffort = route.compatibleEndpointReasoningEffort;
  if (
    endpointSource !== null &&
    endpointSource !== "onboard" &&
    endpointSource !== "inference-set"
  ) {
    throw new Error("CUA inference endpoint source is unsupported");
  }
  if (
    preferredInferenceApi !== null &&
    !["openai-completions", "anthropic-messages", "openai-responses"].includes(
      preferredInferenceApi,
    )
  ) {
    throw new Error("CUA inference API family is unsupported");
  }
  if (credentialEnv !== null && !SAFE_CREDENTIAL_ENV.test(credentialEnv)) {
    throw new Error("CUA inference credential binding name is invalid");
  }
  if (nimContainer !== null) {
    safePublicValue(nimContainer, SAFE_ROUTE_VALUE, "inference.nimContainer");
  }
  const routeDigest = contentDigest({
    provider,
    model,
    endpointUrl: canonicalEndpoint(route.endpointUrl),
    endpointSource,
    preferredInferenceApi,
    credentialEnv,
    nimContainer,
    compatibleEndpointReasoning,
    compatibleEndpointReasoningEffort,
  });
  return { provider, model, routeDigest };
}

export function cuaInferenceRoutesMatch(
  expected: CuaInferenceIdentity,
  actual: CuaInferenceRouteInput,
): boolean {
  const identity = getCuaInferenceRouteIdentity(actual);
  return (
    identity.provider === expected.provider &&
    identity.model === expected.model &&
    identity.routeDigest === expected.routeDigest
  );
}

function archiveComponent(
  identity: CuaArchiveArtifactIdentity,
  owner: string,
): CuaComponentIdentity {
  return {
    name: identity.name,
    version: identity.version,
    digest: `sha256:${identity.sha256}`,
    owner,
  };
}

function imageComponent(identity: CuaImageArtifactIdentity): CuaComponentIdentity {
  return {
    name: identity.name,
    version: identity.version,
    digest: identity.digest,
    owner: "NVIDIA",
  };
}

function openshellComponent(
  context: CuaRuntimeReadinessContext,
  env: NodeJS.ProcessEnv,
): CuaComponentIdentity {
  const snapshot = snapshotCuaOpenshellExecutable({
    selectedBinary: context.openshellBinary,
    expectedDigest: context.expectedOpenshellDigest,
    env,
  });
  try {
    return {
      name: "openshell",
      version: "qualification-bound",
      digest: snapshot.executableDigest,
      owner: "NVIDIA",
    };
  } finally {
    snapshot.cleanup();
  }
}

function expectedComponents(
  manifest: CuaRuntimeManifest,
  openshell: CuaComponentIdentity,
): CuaRuntimeReadiness["components"] {
  return {
    openshell,
    runtime: archiveComponent(manifest.artifacts.hostCli, "NVIDIA"),
    sandboxImage: imageComponent(manifest.artifacts.sandboxImage),
    targetAdapter: {
      name: manifest.artifacts.adapters.target.name,
      version: manifest.artifacts.adapters.target.version,
      digest: `sha256:${manifest.artifacts.adapters.target.sha256}`,
      owner: "NVIDIA",
    },
    policy: {
      name: "nemocua-policy",
      version: "1.0.0",
      digest: `sha256:${manifest.agent.policy.sha256}`,
      owner: "NVIDIA",
    },
    taskProtocol: {
      name: manifest.artifacts.adapters.task.name,
      version: manifest.artifacts.adapters.task.version,
      digest: `sha256:${manifest.artifacts.adapters.task.sha256}`,
      owner: "NVIDIA",
    },
    securityVerifier: {
      name: manifest.artifacts.adapters.security.name,
      version: manifest.artifacts.adapters.security.version,
      digest: `sha256:${manifest.artifacts.adapters.security.sha256}`,
      owner: "NVIDIA",
    },
  };
}

function qualificationEnvironment(env: NodeJS.ProcessEnv): {
  value: ReturnType<typeof parseCuaQualificationEnvironment>;
  sha256: string;
} {
  const filePath = env[CUA_QUALIFICATION_ENVIRONMENT_ENV]?.trim() ?? "";
  if (!path.isAbsolute(filePath)) {
    throw new Error(`${CUA_QUALIFICATION_ENVIRONMENT_ENV} must be an absolute path`);
  }
  assertCuaAuthorityFileOwnership(filePath, "CUA qualification environment");
  const raw = readBoundedRegularFile(filePath, {
    label: "CUA qualification environment",
    minBytes: 2,
    maxBytes: MAX_QUALIFICATION_ENVIRONMENT_BYTES,
  });
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new Error("CUA qualification environment must contain strict JSON");
  }
  return {
    value: parseCuaQualificationEnvironment(value),
    sha256: crypto.createHash("sha256").update(raw).digest("hex"),
  };
}

function assertCandidateManifestBindings(
  readiness: CuaRuntimeReadiness,
  manifest: CuaRuntimeManifest & {
    compatibility: Extract<CuaRuntimeManifest["compatibility"], { status: "candidate" }>;
  },
  env: NodeJS.ProcessEnv,
): void {
  const environment = qualificationEnvironment(env);
  if (
    environment.value.nemoclawCommit !== readiness.sourceRevision ||
    environment.value.nemoclawCommit !== manifest.compatibility.candidateSourceRevision ||
    environment.value.bundleReceiptSha256 !== manifest.bundleReceipt.sha256 ||
    environment.value.runtimeManifestSha256 !== readiness.runtimeManifestDigest.slice(7) ||
    readiness.qualification?.state !== "candidate" ||
    readiness.qualification.environmentDigest !== `sha256:${environment.sha256}` ||
    readiness.qualification.bundleReceiptDigest !== `sha256:${manifest.bundleReceipt.sha256}`
  ) {
    throw new Error("CUA candidate readiness does not match its qualification environment");
  }
}

function resolveContext(context: CuaRuntimeReadinessContext) {
  const env = context.env ?? process.env;
  if (!isCuaFrameworkEnabled(env)) throw new Error("CUA is disabled");
  if (context.agentName !== "nemocua") {
    throw new Error("CUA runtime readiness requires sandbox agent nemocua");
  }
  const rootDir = context.rootDir ?? path.resolve(__dirname, "..", "..", "..");
  const build = resolveCurrentCuaBuildIdentity({
    rootDir,
    ...(context.buildIdentity ? { buildIdentity: context.buildIdentity } : {}),
  });
  if (!build.sourceClean) throw new Error("CUA requires a clean exact NemoClaw build");
  const loaded = verifyCuaRuntimeAuthorityPayload(env);
  getCuaSandboxImageRef(env);
  const openshell = openshellComponent(context, env);
  if (
    !context.liveInference ||
    !context.liveProviderAuthorityDigest ||
    !/^sha256:[a-f0-9]{64}$/.test(context.liveProviderAuthorityDigest)
  ) {
    throw new Error("CUA requires a live managed inference provider identity");
  }
  if (
    !context.liveAppliedPolicy ||
    !Number.isSafeInteger(context.liveAppliedPolicy.revision) ||
    !/^sha256:[a-f0-9]{64}$/.test(context.liveAppliedPolicy.digest)
  ) {
    throw new Error("CUA requires a live applied policy identity");
  }
  const inference = getCuaInferenceRouteIdentity(context.recordedInference);
  if (!cuaInferenceRoutesMatch(inference, context.liveInference)) {
    throw new Error("CUA inference route no longer matches the live route");
  }
  return {
    env,
    rootDir,
    build,
    loaded,
    openshell,
    inference,
    providerAuthorityDigest: context.liveProviderAuthorityDigest,
    appliedPolicy: context.liveAppliedPolicy,
  };
}

export function validateCurrentCuaRuntimeReadiness(
  value: unknown,
  context: CuaRuntimeReadinessContext,
): CuaRuntimeReadiness {
  const readiness = parseCuaRuntimeReadiness(value);
  const { env, build, loaded, openshell, inference, providerAuthorityDigest, appliedPolicy } =
    resolveContext(context);
  if (
    readiness.agent !== context.agentName ||
    readiness.sourceRevision !== build.sourceRevision ||
    readiness.sourceClean !== true ||
    readiness.runtimeManifestDigest !== `sha256:${loaded.sha256}` ||
    readiness.providerAuthorityDigest !== providerAuthorityDigest ||
    digestJson(readiness.appliedPolicy) !== digestJson(appliedPolicy) ||
    digestJson(readiness.inference) !== digestJson(inference) ||
    digestJson(readiness.components) !== digestJson(expectedComponents(loaded.manifest, openshell))
  ) {
    throw new Error("stored CUA readiness does not match the current runtime identity");
  }

  if (readiness.status === "candidate") {
    if (
      context.acceptance !== "candidate-qualification" ||
      !isCuaQualificationEnabled(env) ||
      loaded.manifest.compatibility.status !== "candidate"
    ) {
      throw new Error("candidate CUA readiness is not final runtime authority");
    }
    assertCandidateManifestBindings(
      readiness,
      {
        ...loaded.manifest,
        compatibility: loaded.manifest.compatibility,
      },
      env,
    );
  }
  return readiness;
}

export function buildCurrentCuaRuntimeReadiness(
  context: CuaRuntimeReadinessContext,
): CuaRuntimeReadiness {
  const { env, build, loaded, openshell, inference, providerAuthorityDigest, appliedPolicy } =
    resolveContext(context);
  const manifest = loaded.manifest;
  let status: CuaRuntimeReadiness["status"] = "unavailable";
  let qualification: CuaRuntimeReadiness["qualification"] = null;
  if (manifest.compatibility.status === "candidate" && isCuaQualificationEnabled(env)) {
    const environment = qualificationEnvironment(env);
    status = "candidate";
    qualification = {
      state: "candidate",
      environmentDigest: `sha256:${environment.sha256}`,
      bundleReceiptDigest: `sha256:${manifest.bundleReceipt.sha256}`,
    };
  }
  const readiness: CuaRuntimeReadiness = {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "runtime-readiness",
    agent: "nemocua",
    mode: "standalone",
    status,
    sourceRevision: build.sourceRevision,
    sourceClean: true,
    runtimeManifestDigest: `sha256:${loaded.sha256}`,
    providerAuthorityDigest,
    appliedPolicy,
    qualification,
    components: expectedComponents(manifest, openshell),
    inference,
    commands: { interactive: true, headless: true, version: true, smoke: true },
    limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
    requiredCapabilities: [...CUA_CAPABILITIES],
    targetOperations: [...CUA_TARGET_OPERATIONS],
    taskOperations: [...CUA_TASK_OPERATIONS],
    securityOperations: [...CUA_SECURITY_OPERATIONS],
  };
  const parsed = parseCuaRuntimeReadiness(readiness);
  if (parsed.status === "candidate") {
    return validateCurrentCuaRuntimeReadiness(parsed, context);
  }
  return parsed;
}

export function requireCurrentCuaRuntimeReadiness(
  context: CuaRuntimeReadinessContext,
): CuaRuntimeReadiness {
  const readiness = buildCurrentCuaRuntimeReadiness(context);
  if (readiness.status !== "candidate" || context.acceptance !== "candidate-qualification") {
    throw new Error("CUA runtime artifacts are not qualified for the selected lifecycle mode");
  }
  return readiness;
}

export function getPublicCuaRuntimeReadiness(
  value: unknown,
  context: CuaRuntimeReadinessContext,
): CuaRuntimeReadiness | null {
  try {
    return validateCurrentCuaRuntimeReadiness(value, context);
  } catch {
    return null;
  }
}
