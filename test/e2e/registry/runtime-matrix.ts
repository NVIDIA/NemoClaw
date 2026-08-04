// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  assertExecutionFoundationId,
  defineExecutionProfile,
  type ExecutionProfile,
  type ExecutionProviderId,
  executionProviderId,
} from "./execution-profile.ts";
import {
  compareCodeUnits,
  defineRuntimeScenario,
  type RuntimeNeutralScenario,
  type ScenarioSupportObligation,
} from "./scenario.ts";

export interface ObligationBinding {
  obligationId: string;
  /** Registry-local executable adapter identity. */
  adapterId: string;
}

export interface RuntimeBindingSpec {
  scenarioId: string;
  profileId: string;
  obligationBindings: readonly ObligationBinding[];
}

export interface RuntimeAdapterRequest {
  caseId: string;
  obligationId: string;
  workloadId: string;
}

export interface RuntimeAdapterRuntime {
  readonly profile: ExecutionProfile;
  readonly lifecycle: {
    executeAdapter(adapterId: string, request: RuntimeAdapterRequest): Promise<void>;
  };
}

export interface RuntimeAdapterRegistration {
  id: string;
  provider: ExecutionProviderId;
  scenarioId: string;
  obligationId: string;
  execute(runtime: RuntimeAdapterRuntime, request: RuntimeAdapterRequest): Promise<void>;
}

export interface RuntimeCaseReference {
  scenarioId: string;
  profileId: string;
}

export interface RuntimeMatrixDefinition {
  scenarios: readonly RuntimeNeutralScenario[];
  profiles: readonly ExecutionProfile[];
  adapterCatalog: readonly RuntimeAdapterRegistration[];
  bindings: readonly RuntimeBindingSpec[];
}

export interface RuntimeResourceIdentities {
  sandbox: string;
  artifact: string;
  cleanup: string;
  result: string;
}

export interface RuntimeMatrixCase {
  id: string;
  preparationKey: string;
  scenario: RuntimeNeutralScenario;
  profile: ExecutionProfile;
  obligationBindings: readonly Readonly<CompiledObligationBinding>[];
  identities: Readonly<RuntimeResourceIdentities>;
}

export interface CompiledObligationBinding extends ObligationBinding {
  adapter: Readonly<RuntimeAdapterRegistration>;
}

export interface RuntimePreparationBatch {
  preparationKey: string;
  profile: ExecutionProfile;
  cases: readonly RuntimeMatrixCase[];
}

export interface RuntimeHostShard {
  id: string;
  runner: ExecutionProfile["runner"];
  index: number;
  count: number;
  preparations: readonly Readonly<RuntimePreparationBatch>[];
  cases: readonly RuntimeMatrixCase[];
}

declare const compiledRuntimeMatrixBrand: unique symbol;
declare const resolvedRuntimeCaseBrand: unique symbol;

export interface CompiledRuntimeMatrix {
  readonly [compiledRuntimeMatrixBrand]: true;
  cases: readonly RuntimeMatrixCase[];
  shards: readonly Readonly<RuntimeHostShard>[];
}

export interface ResolvedRuntimeCase {
  readonly [resolvedRuntimeCaseBrand]: true;
  case: RuntimeMatrixCase;
  shard: Readonly<RuntimeHostShard>;
}

const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/u;
const compiledRuntimeMatrices = new WeakSet<object>();
const resolvedRuntimeCases = new WeakSet<object>();

function indexById<T extends { id: string }>(values: readonly T[], label: string): Map<string, T> {
  const index = new Map<string, T>();
  for (const value of values) {
    if (index.has(value.id)) {
      throw new Error(`Duplicate ${label} id '${value.id}'`);
    }
    index.set(value.id, value);
  }
  return index;
}

function assertConsistentHosts(profiles: readonly ExecutionProfile[]): void {
  const runnersByHost = new Map<string, ExecutionProfile["runner"]>();
  for (const profile of profiles) {
    const existing = runnersByHost.get(profile.runner.hostId);
    if (
      existing &&
      (existing.maxShards !== profile.runner.maxShards || existing.label !== profile.runner.label)
    ) {
      throw new Error(
        `Execution host '${profile.runner.hostId}' has conflicting runner label or maxShards`,
      );
    }
    runnersByHost.set(profile.runner.hostId, profile.runner);
  }
}

function compileObligationBindings(
  scenario: RuntimeNeutralScenario,
  profile: ExecutionProfile,
  bindings: readonly ObligationBinding[],
  adapterCatalog: ReadonlyMap<string, Readonly<RuntimeAdapterRegistration>>,
): readonly Readonly<CompiledObligationBinding>[] {
  const declared = new Map<string, ObligationBinding>();
  for (const binding of bindings) {
    assertExecutionFoundationId(binding.obligationId, "Bound obligation id");
    if (!ADAPTER_ID_PATTERN.test(binding.adapterId)) {
      throw new Error(
        `Runtime binding '${scenario.id}' -> '${profile.id}' has invalid adapter id '${binding.adapterId}'`,
      );
    }
    const adapter = adapterCatalog.get(binding.adapterId);
    if (!adapter) {
      throw new Error(
        `Runtime binding '${scenario.id}' -> '${profile.id}' references unregistered adapter '${binding.adapterId}'`,
      );
    }
    if (adapter.provider !== profile.provider) {
      throw new Error(
        `Runtime adapter '${binding.adapterId}' belongs to provider '${adapter.provider}', not '${profile.provider}'`,
      );
    }
    if (adapter.scenarioId !== scenario.id) {
      throw new Error(
        `Runtime adapter '${binding.adapterId}' belongs to scenario '${adapter.scenarioId}', not '${scenario.id}'`,
      );
    }
    if (adapter.obligationId !== binding.obligationId) {
      throw new Error(
        `Runtime adapter '${binding.adapterId}' implements obligation '${adapter.obligationId}', not '${binding.obligationId}'`,
      );
    }
    if (declared.has(binding.obligationId)) {
      throw new Error(
        `Runtime binding '${scenario.id}' -> '${profile.id}' repeats obligation '${binding.obligationId}'`,
      );
    }
    declared.set(binding.obligationId, binding);
  }

  const expected = new Map(
    scenario.supportObligations.map((obligation) => [obligation.id, obligation]),
  );
  const missing = [...expected.keys()].filter((id) => !declared.has(id)).sort();
  if (missing.length > 0) {
    throw new Error(
      `Runtime binding '${scenario.id}' -> '${profile.id}' is missing obligations: ${missing.join(", ")}`,
    );
  }
  const unknown = [...declared.keys()].filter((id) => !expected.has(id)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `Runtime binding '${scenario.id}' -> '${profile.id}' has unknown obligations: ${unknown.join(", ")}`,
    );
  }

  const capabilities = new Set(profile.capabilities);
  for (const obligation of expected.values()) {
    assertCompatibleObligation(scenario, profile, obligation, capabilities);
  }
  return Object.freeze(
    scenario.supportObligations.map((obligation) => {
      const binding = declared.get(obligation.id) as ObligationBinding;
      return Object.freeze({
        ...binding,
        adapter: adapterCatalog.get(binding.adapterId) as Readonly<RuntimeAdapterRegistration>,
      });
    }),
  );
}

function compileAdapterCatalog(
  registrations: readonly RuntimeAdapterRegistration[],
): ReadonlyMap<string, Readonly<RuntimeAdapterRegistration>> {
  const catalog = new Map<string, Readonly<RuntimeAdapterRegistration>>();
  for (const registration of registrations) {
    if (!ADAPTER_ID_PATTERN.test(registration.id)) {
      throw new Error(`Runtime adapter id '${registration.id}' is invalid`);
    }
    const provider = executionProviderId(registration.provider);
    assertExecutionFoundationId(registration.scenarioId, "Runtime adapter scenario id");
    assertExecutionFoundationId(registration.obligationId, "Runtime adapter obligation id");
    if (typeof registration.execute !== "function") {
      throw new Error(`Runtime adapter '${registration.id}' has no executable implementation`);
    }
    if (catalog.has(registration.id)) {
      throw new Error(`Duplicate runtime adapter id '${registration.id}'`);
    }
    catalog.set(
      registration.id,
      Object.freeze({
        ...registration,
        provider,
      }),
    );
  }
  return catalog;
}

function assertCompatibleObligation(
  scenario: RuntimeNeutralScenario,
  profile: ExecutionProfile,
  obligation: ScenarioSupportObligation,
  capabilities: ReadonlySet<string>,
): void {
  const missing = obligation.requiredCapabilities.filter(
    (capability) => !capabilities.has(capability),
  );
  if (missing.length > 0) {
    throw new Error(
      `Runtime binding '${scenario.id}' -> '${profile.id}' cannot satisfy obligation '${obligation.id}'; missing capabilities: ${missing.join(", ")}`,
    );
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resourceIdentities(bindingId: string): RuntimeResourceIdentities {
  const token = digest(`nemoclaw-runtime-binding-v1\0${bindingId}`).slice(0, 16);
  const readable = bindingId
    .replaceAll(".", "-")
    .replaceAll("--", "-")
    .slice(0, 28)
    .replace(/-+$/u, "");
  return Object.freeze({
    sandbox: `e2e-${readable}-${token}`,
    artifact: `runtime-artifact-${token}`,
    cleanup: `runtime-cleanup-${token}`,
    result: `runtime-result-${token}`,
  });
}

export function executionPreparationKey(profile: ExecutionProfile): string {
  const serialized = JSON.stringify({
    id: profile.id,
    provider: profile.provider,
    platform: profile.platform,
    architecture: profile.architecture,
    rootMode: profile.rootMode,
    acceleration: profile.acceleration,
    capabilities: profile.capabilities,
    runner: {
      hostId: profile.runner.hostId,
      label: profile.runner.label,
      maxShards: profile.runner.maxShards,
    },
  });
  return `runtime-preparation-${digest(serialized).slice(0, 16)}`;
}

function assertUniqueResourceIdentities(cases: readonly RuntimeMatrixCase[]): void {
  const identities = cases.flatMap((entry) => Object.values(entry.identities));
  if (new Set(identities).size !== identities.length) {
    throw new Error("Runtime matrix generated colliding resource identities");
  }
}

function compileHostShards(
  profiles: readonly ExecutionProfile[],
  cases: readonly RuntimeMatrixCase[],
): readonly Readonly<RuntimeHostShard>[] {
  const shards: RuntimeHostShard[] = [];
  const preparationsByHost = new Map<string, RuntimePreparationBatch[]>();
  for (const profile of [...profiles].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const profileCases = cases.filter((entry) => entry.profile.id === profile.id);
    if (profileCases.length === 0) continue;
    const preparations = preparationsByHost.get(profile.runner.hostId) ?? [];
    preparations.push({
      preparationKey: executionPreparationKey(profile),
      profile,
      cases: Object.freeze(profileCases),
    });
    preparationsByHost.set(profile.runner.hostId, preparations);
  }

  for (const [hostId, preparations] of [...preparationsByHost.entries()].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    preparations.sort((left, right) => compareCodeUnits(left.preparationKey, right.preparationKey));
    const maxShards = preparations[0]?.profile.runner.maxShards ?? 0;
    const count = Math.min(maxShards, preparations.length);
    const lanes = Array.from({ length: count }, (): RuntimePreparationBatch[] => []);
    preparations.forEach((preparation, index) => lanes[index % count]?.push(preparation));
    lanes.forEach((lane, index) => {
      const shardIndex = index + 1;
      const preparationKeys = lane.map((entry) => entry.preparationKey);
      const laneIdentity = digest(JSON.stringify(preparationKeys)).slice(0, 16);
      const runner = lane[0]?.profile.runner as ExecutionProfile["runner"];
      shards.push(
        Object.freeze({
          id: `${hostId}-runtime-lane-${laneIdentity}-${shardIndex}-of-${count}`,
          runner,
          index: shardIndex,
          count,
          preparations: Object.freeze(
            lane.map((entry) =>
              Object.freeze({
                ...entry,
              }),
            ),
          ),
          cases: Object.freeze(lane.flatMap((entry) => entry.cases)),
        }),
      );
    });
  }
  if (new Set(shards.map((shard) => shard.id)).size !== shards.length) {
    throw new Error("Runtime matrix generated colliding shard identities");
  }
  return Object.freeze(shards);
}

/**
 * Compiles inert registry metadata. It selects no runner and executes no
 * fixture; a future live consumer must opt in explicitly.
 */
export function compileRuntimeMatrix(definition: RuntimeMatrixDefinition): CompiledRuntimeMatrix {
  if (definition.scenarios.length === 0) {
    throw new Error("Runtime matrix must declare at least one scenario");
  }
  if (definition.profiles.length === 0) {
    throw new Error("Runtime matrix must declare at least one execution profile");
  }

  const scenarios = definition.scenarios.map(defineRuntimeScenario);
  const profiles = definition.profiles.map(defineExecutionProfile);
  const adapterCatalog = compileAdapterCatalog(definition.adapterCatalog);
  const scenariosById = indexById(scenarios, "runtime scenario");
  const profilesById = indexById(profiles, "execution profile");
  assertConsistentHosts(profiles);

  const boundScenarios = new Set<string>();
  const bindingIds = new Set<string>();
  const cases = [...definition.bindings]
    .sort(
      (left, right) =>
        compareCodeUnits(left.scenarioId, right.scenarioId) ||
        compareCodeUnits(left.profileId, right.profileId),
    )
    .map((binding): RuntimeMatrixCase => {
      const scenario = scenariosById.get(binding.scenarioId);
      if (!scenario) {
        throw new Error(`Runtime binding references unknown scenario '${binding.scenarioId}'`);
      }
      const profile = profilesById.get(binding.profileId);
      if (!profile) {
        throw new Error(`Runtime binding references unknown profile '${binding.profileId}'`);
      }
      const id = `${scenario.id}--${profile.id}`;
      if (bindingIds.has(id)) {
        throw new Error(`Duplicate runtime binding '${id}'`);
      }
      bindingIds.add(id);
      boundScenarios.add(scenario.id);
      const missingScenarioCapabilities = scenario.requiredCapabilities.filter(
        (capability) => !profile.capabilities.includes(capability),
      );
      if (missingScenarioCapabilities.length > 0) {
        throw new Error(
          `Runtime binding '${scenario.id}' -> '${profile.id}' is incompatible; missing scenario capabilities: ${missingScenarioCapabilities.join(", ")}`,
        );
      }
      return Object.freeze({
        id,
        preparationKey: executionPreparationKey(profile),
        scenario,
        profile,
        obligationBindings: compileObligationBindings(
          scenario,
          profile,
          binding.obligationBindings,
          adapterCatalog,
        ),
        identities: resourceIdentities(id),
      });
    });

  const unboundScenarios = scenarios
    .map((scenario) => scenario.id)
    .filter((id) => !boundScenarios.has(id));
  if (unboundScenarios.length > 0) {
    throw new Error(
      `Runtime scenarios have no explicit binding: ${unboundScenarios.sort().join(", ")}`,
    );
  }
  assertUniqueResourceIdentities(cases);
  const matrix = Object.freeze({
    cases: Object.freeze(cases),
    shards: compileHostShards(profiles, cases),
  }) as CompiledRuntimeMatrix;
  compiledRuntimeMatrices.add(matrix);
  return matrix;
}

export function resolveRuntimeCase(
  matrix: CompiledRuntimeMatrix,
  reference: RuntimeCaseReference,
): ResolvedRuntimeCase {
  if (!compiledRuntimeMatrices.has(matrix)) {
    throw new Error("Runtime matrix was not issued by compileRuntimeMatrix");
  }
  const id = `${reference.scenarioId}--${reference.profileId}`;
  const runtimeCase = matrix.cases.find((entry) => entry.id === id);
  if (!runtimeCase) {
    throw new Error(`Runtime case '${id}' is not present in the compiled matrix`);
  }
  const shard = matrix.shards.find((entry) =>
    entry.cases.some((candidate) => candidate.id === runtimeCase.id),
  );
  if (!shard) {
    throw new Error(`Runtime case '${id}' has no compiled host shard`);
  }
  const resolved = Object.freeze({ case: runtimeCase, shard }) as ResolvedRuntimeCase;
  resolvedRuntimeCases.add(resolved);
  return resolved;
}

export function assertResolvedRuntimeCase(
  resolved: ResolvedRuntimeCase,
): asserts resolved is ResolvedRuntimeCase {
  if (!resolvedRuntimeCases.has(resolved)) {
    throw new Error("Runtime case resolution was not issued by resolveRuntimeCase");
  }
}
