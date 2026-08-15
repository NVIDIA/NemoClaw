// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NATIVE_RUNTIME_QUALIFICATION_AGENTS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const;
export const NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES = ["amd64", "arm64"] as const;
export const NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS = ["cpu", "nvidia-gpu"] as const;
export const NATIVE_RUNTIME_QUALIFICATION_INFERENCE = {
  cpu: ["ollama"],
  "nvidia-gpu": ["ollama", "nim", "vllm"],
} as const;

export type NativeRuntimeQualificationAgent = (typeof NATIVE_RUNTIME_QUALIFICATION_AGENTS)[number];
export type NativeRuntimeQualificationArchitecture =
  (typeof NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES)[number];
export type NativeRuntimeQualificationAcceleration =
  (typeof NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS)[number];
export type NativeRuntimeQualificationInference = "ollama" | "nim" | "vllm";
export type NativeRuntimeQualificationObligation =
  | "installer.install"
  | "runtime.docker-unavailable"
  | "agent.onboard"
  | "agent.turn"
  | "sandbox.stop-start"
  | "sandbox.snapshot-restore"
  | "sandbox.rebuild"
  | "runtime.restart-reconcile"
  | "cleanup.exact";
export type NativeRuntimeQualificationEvidenceKind =
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
] as const satisfies readonly NativeRuntimeQualificationObligation[];

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
] as const satisfies readonly NativeRuntimeQualificationEvidenceKind[];
const REQUIRED_CAPABILITIES = [
  "agent.configure",
  "agent.turn",
  "evidence.collect",
  "sandbox.lifecycle",
  "state.observe",
  "transport.socket-free",
] as const;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/u;
const SOURCE_REVISION = /^[a-f0-9]{40}$/u;

export interface NativeRuntimeQualificationCase {
  readonly id: string;
  readonly agent: NativeRuntimeQualificationAgent;
  readonly architecture: NativeRuntimeQualificationArchitecture;
  readonly acceleration: NativeRuntimeQualificationAcceleration;
  readonly inference: NativeRuntimeQualificationInference;
  readonly platform: "linux";
  readonly rootMode: "rootless";
  readonly capabilities: readonly string[];
  readonly gate: "protected-e2e";
  readonly install: "release-installer";
  readonly dockerAvailability: "unavailable";
  readonly obligations: readonly NativeRuntimeQualificationObligation[];
  readonly evidenceKinds: readonly NativeRuntimeQualificationEvidenceKind[];
}

export interface NativeRuntimeQualificationDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly repository: "NVIDIA/NemoClaw";
  readonly providerId: string;
  readonly executionPath: "runtime-provider-bundle";
  readonly cases: readonly NativeRuntimeQualificationCase[];
}

export interface NativeRuntimeCandidateEvidence {
  readonly schemaVersion: 1;
  readonly claim: "candidate-execution-prerequisites";
  readonly candidateId: "podman-cpu-lifecycle";
  readonly providerId: string;
  readonly sourceRevision: string;
  readonly executionPath: "runtime-provider-bundle";
  readonly architecture: "amd64";
  readonly acceleration: "cpu";
  readonly agents: readonly NativeRuntimeQualificationAgent[];
  readonly socketFree: true;
  readonly dockerUnavailable: {
    readonly service: true;
    readonly socket: true;
    readonly daemon: true;
    readonly invocationGuard: true;
  };
}

export interface NativeRuntimeCandidateAuthority {
  readonly schemaVersion: 1;
  readonly candidateId: "podman-cpu-lifecycle";
  readonly providerId: string;
  readonly sourceRevision: string;
  readonly executionPath: "runtime-provider-bundle";
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactSet<T extends string>(actual: readonly T[], expected: readonly T[], label: string) {
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const unknown = actual.filter((value) => !expected.includes(value));
  if (actualSet.size !== actual.length || missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} is incomplete (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
}

export function requiredNativeRuntimeQualificationEvidenceKinds(
  acceleration: NativeRuntimeQualificationAcceleration,
): readonly NativeRuntimeQualificationEvidenceKind[] {
  return acceleration === "nvidia-gpu"
    ? Object.freeze([...BASE_EVIDENCE_KINDS, "nvidia-cdi"])
    : BASE_EVIDENCE_KINDS;
}

export function nativeRuntimeQualificationCaseId(input: {
  readonly providerId: string;
  readonly agent: NativeRuntimeQualificationAgent;
  readonly architecture: NativeRuntimeQualificationArchitecture;
  readonly acceleration: NativeRuntimeQualificationAcceleration;
  readonly inference: NativeRuntimeQualificationInference;
}): string {
  const acceleration = input.acceleration === "nvidia-gpu" ? "gpu" : input.acceleration;
  return [
    input.providerId,
    input.agent,
    "linux",
    input.architecture,
    acceleration,
    input.inference,
  ].join("-");
}

function coverageKey(
  value: Pick<
    NativeRuntimeQualificationCase,
    "agent" | "architecture" | "acceleration" | "inference"
  >,
): string {
  return [value.agent, value.architecture, value.acceleration, value.inference].join("|");
}

function requiredCoverageKeys(): readonly string[] {
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

export function compileNativeRuntimeQualification(
  definition: NativeRuntimeQualificationDefinition,
): NativeRuntimeQualificationDefinition {
  if (
    definition.schemaVersion !== 1 ||
    !PROVIDER_ID.test(definition.providerId) ||
    definition.id !== `${definition.providerId}-protected-host-local-inference` ||
    definition.repository !== "NVIDIA/NemoClaw" ||
    definition.executionPath !== "runtime-provider-bundle"
  ) {
    throw new Error("Native runtime qualification identity is invalid");
  }
  const cases = definition.cases.map((entry) => {
    const expectedId = nativeRuntimeQualificationCaseId({
      providerId: definition.providerId,
      agent: entry.agent,
      architecture: entry.architecture,
      acceleration: entry.acceleration,
      inference: entry.inference,
    });
    const inference = NATIVE_RUNTIME_QUALIFICATION_INFERENCE[entry.acceleration];
    const capabilities = new Set(entry.capabilities);
    if (
      entry.id !== expectedId ||
      entry.platform !== "linux" ||
      entry.rootMode !== "rootless" ||
      entry.gate !== "protected-e2e" ||
      entry.install !== "release-installer" ||
      entry.dockerAvailability !== "unavailable" ||
      !(inference as readonly string[]).includes(entry.inference) ||
      REQUIRED_CAPABILITIES.some((value) => !capabilities.has(value)) ||
      capabilities.has("transport.docker-socket")
    ) {
      throw new Error(`Native runtime qualification case '${entry.id}' is invalid`);
    }
    exactSet(
      entry.obligations,
      NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS,
      `Native runtime qualification case '${entry.id}' obligations`,
    );
    exactSet(
      entry.evidenceKinds,
      requiredNativeRuntimeQualificationEvidenceKinds(entry.acceleration),
      `Native runtime qualification case '${entry.id}' evidence kinds`,
    );
    return Object.freeze({
      ...entry,
      capabilities: Object.freeze([...entry.capabilities]),
      obligations: Object.freeze([...entry.obligations]),
      evidenceKinds: Object.freeze([...entry.evidenceKinds]),
    });
  });
  const coverage = new Map(cases.map((entry) => [coverageKey(entry), entry]));
  const required = requiredCoverageKeys();
  const missing = required.filter((key) => !coverage.has(key));
  if (coverage.size !== cases.length || coverage.size !== required.length || missing.length > 0) {
    throw new Error(
      `Native runtime qualification coverage is incomplete (missing: ${missing.join(", ") || "none"})`,
    );
  }
  return Object.freeze({
    ...definition,
    cases: Object.freeze([...cases].sort((left, right) => compareCodeUnits(left.id, right.id))),
  });
}

export function nativeRuntimeQualificationDefinition(
  providerId: string,
): NativeRuntimeQualificationDefinition {
  const capabilities = [...REQUIRED_CAPABILITIES];
  return {
    schemaVersion: 1,
    id: `${providerId}-protected-host-local-inference`,
    repository: "NVIDIA/NemoClaw",
    providerId,
    executionPath: "runtime-provider-bundle",
    cases: NATIVE_RUNTIME_QUALIFICATION_AGENTS.flatMap((agent) =>
      NATIVE_RUNTIME_QUALIFICATION_ARCHITECTURES.flatMap((architecture) =>
        NATIVE_RUNTIME_QUALIFICATION_ACCELERATIONS.flatMap((acceleration) =>
          NATIVE_RUNTIME_QUALIFICATION_INFERENCE[acceleration].map((inference) => ({
            id: nativeRuntimeQualificationCaseId({
              providerId,
              agent,
              architecture,
              acceleration,
              inference,
            }),
            agent,
            architecture,
            acceleration,
            inference,
            platform: "linux" as const,
            rootMode: "rootless" as const,
            capabilities,
            gate: "protected-e2e" as const,
            install: "release-installer" as const,
            dockerAvailability: "unavailable" as const,
            obligations: NATIVE_RUNTIME_QUALIFICATION_OBLIGATIONS,
            evidenceKinds: requiredNativeRuntimeQualificationEvidenceKinds(acceleration),
          })),
        ),
      ),
    ),
  };
}

export const PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION =
  compileNativeRuntimeQualification(nativeRuntimeQualificationDefinition("podman"));

/**
 * Consume only the current credential-free candidate prerequisites. This does
 * not issue protected qualification evidence or activate a runtime provider.
 */
export function consumeNativeRuntimeCandidateEvidence(
  value: unknown,
  expectedSourceRevision: string,
): NativeRuntimeCandidateAuthority {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Native runtime candidate evidence is incomplete or does not match source");
  }
  const candidate = value as Partial<NativeRuntimeCandidateEvidence>;
  const shaped =
    Array.isArray(candidate.agents) &&
    candidate.agents.every((agent) => typeof agent === "string") &&
    typeof candidate.dockerUnavailable === "object" &&
    candidate.dockerUnavailable !== null &&
    !Array.isArray(candidate.dockerUnavailable);
  if (
    !shaped ||
    candidate.schemaVersion !== 1 ||
    candidate.claim !== "candidate-execution-prerequisites" ||
    candidate.candidateId !== "podman-cpu-lifecycle" ||
    typeof candidate.providerId !== "string" ||
    !PROVIDER_ID.test(candidate.providerId) ||
    candidate.executionPath !== "runtime-provider-bundle" ||
    candidate.architecture !== "amd64" ||
    candidate.acceleration !== "cpu" ||
    candidate.socketFree !== true ||
    typeof candidate.sourceRevision !== "string" ||
    !SOURCE_REVISION.test(candidate.sourceRevision) ||
    candidate.sourceRevision !== expectedSourceRevision ||
    candidate.dockerUnavailable?.service !== true ||
    candidate.dockerUnavailable.socket !== true ||
    candidate.dockerUnavailable.daemon !== true ||
    candidate.dockerUnavailable.invocationGuard !== true
  ) {
    throw new Error("Native runtime candidate evidence is incomplete or does not match source");
  }
  exactSet(
    candidate.agents,
    NATIVE_RUNTIME_QUALIFICATION_AGENTS,
    "Native runtime candidate agents",
  );
  return Object.freeze({
    schemaVersion: 1,
    candidateId: candidate.candidateId,
    providerId: candidate.providerId,
    sourceRevision: candidate.sourceRevision,
    executionPath: candidate.executionPath,
  });
}
