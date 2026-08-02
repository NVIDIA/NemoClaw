// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  defineExecutionProfile,
  type ExecutionAcceleration,
  type ExecutionArchitecture,
  type ExecutionCapability,
  type ExecutionProfile,
  type ExecutionProviderId,
} from "./execution-profile.ts";
import { compareCodeUnits, type RuntimeAgent } from "./scenario.ts";

export const NATIVE_RUNTIME_QUALIFICATION_AGENTS = ["openclaw", "hermes", "dcode"] as const;
export const NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES = ["amd64", "arm64"] as const;
export const NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS = ["cpu", "nvidia-gpu"] as const;
export const NATIVE_RUNTIME_QUALIFICATION_INFERENCE = {
  cpu: ["ollama"],
  "nvidia-gpu": ["ollama", "nim", "vllm"],
} as const satisfies Readonly<Record<ExecutionAcceleration, readonly LocalInferenceProvider[]>>;

export type LocalInferenceProvider = "ollama" | "nim" | "vllm";
export type QualificationObligation =
  | "installer.install"
  | "runtime.docker-unavailable"
  | "agent.onboard"
  | "agent.turn"
  | "sandbox.stop-start"
  | "sandbox.snapshot-restore"
  | "sandbox.rebuild"
  | "runtime.restart-reconcile"
  | "cleanup.exact";
export type QualificationEvidenceKind =
  | "protected-run"
  | "source-identity"
  | "installer-result"
  | "docker-unavailable-guard"
  | "managed-images"
  | "agent-turn"
  | "local-inference"
  | "lifecycle"
  | "recovery"
  | "cleanup"
  | "nvidia-cdi";

export const NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS = [
  "installer.install",
  "runtime.docker-unavailable",
  "agent.onboard",
  "agent.turn",
  "sandbox.stop-start",
  "sandbox.snapshot-restore",
  "sandbox.rebuild",
  "runtime.restart-reconcile",
  "cleanup.exact",
] as const satisfies readonly QualificationObligation[];

const BASE_EVIDENCE_KINDS = [
  "protected-run",
  "source-identity",
  "installer-result",
  "docker-unavailable-guard",
  "managed-images",
  "agent-turn",
  "local-inference",
  "lifecycle",
  "recovery",
  "cleanup",
] as const satisfies readonly QualificationEvidenceKind[];

const REQUIRED_CAPABILITIES = [
  "agent.configure",
  "agent.turn",
  "evidence.collect",
  "sandbox.lifecycle",
  "state.observe",
  "transport.socket-free",
] as const satisfies readonly ExecutionCapability[];

export interface NativeRuntimeQualificationCase {
  id: string;
  agent: RuntimeAgent;
  profile: ExecutionProfile;
  inference: LocalInferenceProvider;
  gate: "protected-e2e";
  install: "release-installer";
  dockerAvailability: "unavailable";
  obligations: readonly QualificationObligation[];
  evidenceKinds: readonly QualificationEvidenceKind[];
}

export interface NativeRuntimeQualificationDefinition {
  id: string;
  repository: string;
  protectedWorkflow: string;
  provider: ExecutionProviderId;
  engineName: string;
  cases: readonly NativeRuntimeQualificationCase[];
}

export interface CompiledNativeRuntimeQualification {
  id: string;
  repository: string;
  protectedWorkflow: string;
  provider: ExecutionProviderId;
  engineName: string;
  cases: readonly Readonly<NativeRuntimeQualificationCase>[];
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function assertSingleLine(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/u.test(normalized)) {
    throw new Error(`${label} must be a non-empty single-line string`);
  }
  return normalized;
}

function assertExactSet<T extends string>(
  actual: readonly T[],
  expected: readonly T[],
  label: string,
): void {
  const actualSet = new Set(actual);
  if (actualSet.size !== actual.length) {
    throw new Error(`${label} contains duplicate values`);
  }
  const missing = expected.filter((value) => !actualSet.has(value));
  const unknown = actual.filter((value) => !expected.includes(value));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} is incomplete (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
}

export function requiredQualificationEvidenceKinds(
  acceleration: ExecutionAcceleration,
): readonly QualificationEvidenceKind[] {
  return acceleration === "nvidia-gpu"
    ? Object.freeze([...BASE_EVIDENCE_KINDS, "nvidia-cdi"])
    : BASE_EVIDENCE_KINDS;
}

export function qualificationCaseId(input: {
  provider: ExecutionProviderId;
  agent: RuntimeAgent;
  architecture: ExecutionArchitecture;
  acceleration: ExecutionAcceleration;
  inference: LocalInferenceProvider;
}): string {
  const acceleration = input.acceleration === "nvidia-gpu" ? "gpu" : input.acceleration;
  return [
    input.provider,
    input.agent,
    "linux",
    input.architecture,
    acceleration,
    input.inference,
  ].join("-");
}

function coverageKey(input: {
  agent: RuntimeAgent;
  architecture: ExecutionArchitecture;
  acceleration: ExecutionAcceleration;
  inference: LocalInferenceProvider;
}): string {
  return [input.agent, input.architecture, input.acceleration, input.inference].join("|");
}

function requiredCoverageKeys(): string[] {
  return NATIVE_RUNTIME_QUALIFICATION_AGENTS.flatMap((agent) =>
    NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES.flatMap((architecture) =>
      NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS.flatMap((acceleration) =>
        NATIVE_RUNTIME_QUALIFICATION_INFERENCE[acceleration].map((inference) =>
          coverageKey({ agent, architecture, acceleration, inference }),
        ),
      ),
    ),
  ).sort(compareCodeUnits);
}

function compileCase(
  definition: NativeRuntimeQualificationDefinition,
  input: NativeRuntimeQualificationCase,
): Readonly<NativeRuntimeQualificationCase> {
  const profile = defineExecutionProfile(input.profile);
  if (profile.provider !== definition.provider) {
    throw new Error(
      `Qualification case '${input.id}' profile provider '${profile.provider}' does not match '${definition.provider}'`,
    );
  }
  if (profile.platform !== "linux" || profile.rootMode !== "rootless") {
    throw new Error(`Qualification case '${input.id}' must use a rootless Linux profile`);
  }
  const capabilities = new Set(profile.capabilities);
  const missingCapabilities = REQUIRED_CAPABILITIES.filter((value) => !capabilities.has(value));
  if (missingCapabilities.length > 0 || capabilities.has("transport.docker-socket")) {
    throw new Error(
      `Qualification case '${input.id}' must be socket-free and declares invalid capabilities (missing: ${missingCapabilities.join(", ") || "none"})`,
    );
  }
  if (input.gate !== "protected-e2e") {
    throw new Error(`Qualification case '${input.id}' must run through protected E2E`);
  }
  if (input.install !== "release-installer") {
    throw new Error(`Qualification case '${input.id}' must exercise the release installer`);
  }
  if (input.dockerAvailability !== "unavailable") {
    throw new Error(`Qualification case '${input.id}' must prove Docker is unavailable`);
  }
  const allowedInference = NATIVE_RUNTIME_QUALIFICATION_INFERENCE[profile.acceleration];
  if (!(allowedInference as readonly string[]).includes(input.inference)) {
    throw new Error(
      `Qualification case '${input.id}' cannot use ${input.inference} with ${profile.acceleration}`,
    );
  }
  assertExactSet(
    input.obligations,
    NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS,
    `Qualification case '${input.id}' obligations`,
  );
  assertExactSet(
    input.evidenceKinds,
    requiredQualificationEvidenceKinds(profile.acceleration),
    `Qualification case '${input.id}' evidence kinds`,
  );
  const expectedId = qualificationCaseId({
    provider: definition.provider,
    agent: input.agent,
    architecture: profile.architecture,
    acceleration: profile.acceleration,
    inference: input.inference,
  });
  if (input.id !== expectedId) {
    throw new Error(`Qualification case id '${input.id}' must be '${expectedId}'`);
  }
  return Object.freeze({
    ...input,
    profile,
    obligations: Object.freeze([...input.obligations]),
    evidenceKinds: Object.freeze([...input.evidenceKinds]),
  });
}

export function compileNativeRuntimeQualification(
  input: NativeRuntimeQualificationDefinition,
): CompiledNativeRuntimeQualification {
  const id = assertSingleLine(input.id, "Native runtime qualification id");
  const repository = assertSingleLine(input.repository, "Native runtime qualification repository");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`Native runtime qualification repository '${repository}' must be owner/name`);
  }
  const protectedWorkflow = assertSingleLine(
    input.protectedWorkflow,
    "Native runtime qualification protected workflow",
  );
  const engineName = assertSingleLine(input.engineName, "Native runtime engine name");
  const cases = input.cases.map((entry) => compileCase(input, entry));
  const casesByCoverage = new Map<string, Readonly<NativeRuntimeQualificationCase>>();
  for (const entry of cases) {
    const key = coverageKey({
      agent: entry.agent,
      architecture: entry.profile.architecture,
      acceleration: entry.profile.acceleration,
      inference: entry.inference,
    });
    if (casesByCoverage.has(key)) {
      throw new Error(`Native runtime qualification repeats case coverage '${key}'`);
    }
    casesByCoverage.set(key, entry);
  }
  const expectedCoverage = requiredCoverageKeys();
  const missing = expectedCoverage.filter((key) => !casesByCoverage.has(key));
  const unknown = [...casesByCoverage.keys()].filter((key) => !expectedCoverage.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `Native runtime qualification coverage is incomplete (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
  const compiled = Object.freeze({
    id,
    repository,
    protectedWorkflow,
    provider: input.provider,
    engineName,
    cases: Object.freeze([...cases].sort((left, right) => compareCodeUnits(left.id, right.id))),
  });
  return compiled;
}
