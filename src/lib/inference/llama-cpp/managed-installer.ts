// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ContainerEngine } from "../../adapters/container-engine";
import { checkPortAvailable } from "../../onboard/preflight";
import type { RuntimeProviderBundle } from "../../onboard/runtime-provider/contract";
import { createHostLocalCreateJournalStore } from "../../onboard/runtime-provider/host-local-create-journal";
import type {
  HostLocalInferenceOperation,
  HostLocalInferenceReceipt,
  HostLocalLlamaCppLifecycle,
} from "../../onboard/runtime-provider/host-local-inference";
import {
  createFilePersistedEngineAuthorityStore,
  createPersistedEngineAuthority,
} from "../../onboard/runtime-provider/persisted-engine-authority";
import { requireRuntimeProviderHostLocalInferenceOperation } from "../../onboard/runtime-provider/registry";
import { isLlamaCppServingRecipe } from "../serving/adapter-registry";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import type { ResolvedLlamaCppInferenceSelection } from "../serving/types";
import { buildVllmDockerEnv } from "../vllm-docker-env";
import { LLAMA_CPP_CREDENTIAL_ENV } from "./contract";
import { acquireVerifiedLlamaCppGguf, verifyLlamaCppGgufCacheEntry } from "./gguf-acquisition";
import { compileLlamaCppGgufCachePlan } from "./gguf-cache-plan";
import type {
  LlamaCppHostLocalLaunchContract,
  VerifiedLocalModelArtifact,
} from "./host-local-runtime";
import {
  claimManagedLlamaCppOwner,
  createManagedLlamaCppReceiptWriter,
  loadManagedLlamaCppApiKey,
  loadManagedLlamaCppOwner,
  loadManagedLlamaCppReceipt,
  loadOrCreateManagedLlamaCppApiKey,
  type ManagedLlamaCppStatePaths,
  managedLlamaCppStatePaths,
} from "./managed-state";

export const MANAGED_LLAMA_CPP_CONTAINER_NAME = "nemoclaw-llama-cpp" as const;
export const MANAGED_LLAMA_CPP_NETWORK_NAME = "nemoclaw-llama-cpp-internal" as const;
export const MANAGED_LLAMA_CPP_OWNER_LABEL = "io.nvidia.nemoclaw.managed-llama-cpp" as const;
export const MANAGED_LLAMA_CPP_OWNER_VALUE = "true" as const;

const IMAGE_PULL_TIMEOUT_MS = 30 * 60 * 1000;
const DOCKER_INSPECT_TIMEOUT_MS = 15_000;

export interface ManagedLlamaCppInstallOptions {
  readonly sandboxName: string;
  readonly runtimeProvider: RuntimeProviderBundle;
  readonly gatewayPort?: number;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly acquireGguf?: typeof acquireVerifiedLlamaCppGguf;
  readonly verifyGguf?: typeof verifyLlamaCppGgufCacheEntry;
  readonly checkPort?: typeof checkPortAvailable;
  readonly revalidateSandboxIdentity?: (operation: string) => void;
  readonly log?: (message: string) => void;
}

export type ManagedLlamaCppInstallResult =
  | {
      readonly ok: true;
      readonly apiKey: string;
      readonly model: string;
      readonly receipt: HostLocalInferenceReceipt;
    }
  | { readonly ok: false; readonly reason: string };

export interface ManagedLlamaCppResumeOptions {
  readonly runtimeProvider: RuntimeProviderBundle;
  readonly gatewayPort?: number;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly verifyGguf?: typeof verifyLlamaCppGgufCacheEntry;
  readonly checkPort?: typeof checkPortAvailable;
  readonly revalidateSandboxIdentity?: (operation: string) => void;
}

export interface ManagedLlamaCppExactInspectionOptions {
  readonly homeDir: string;
  readonly operation: HostLocalInferenceOperation;
  readonly paths: ManagedLlamaCppStatePaths;
  readonly receipt: HostLocalInferenceReceipt;
  readonly selection: ResolvedLlamaCppInferenceSelection;
}

export interface ManagedLlamaCppLifecycleRehydrationOptions {
  readonly runtimeProvider: RuntimeProviderBundle;
  readonly runtimeOwnerSandboxName: string;
  readonly gatewayPort?: number;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly operation?: HostLocalInferenceOperation;
}

export interface ManagedLlamaCppLifecycleRehydration {
  readonly lifecycle: HostLocalLlamaCppLifecycle;
  readonly operation: HostLocalInferenceOperation;
  readonly owner: NonNullable<ReturnType<typeof loadManagedLlamaCppOwner>>;
  readonly paths: ManagedLlamaCppStatePaths;
  readonly receipt: HostLocalInferenceReceipt;
  readonly selection: ResolvedLlamaCppInferenceSelection;
}

interface DockerNetworkInspection {
  readonly kind: "absent" | "owned";
  readonly id?: string;
}

type ManagedLlamaCppImagePullFailureLayer =
  | "authentication"
  | "daemon behavior"
  | "invalid dependency"
  | "registry availability"
  | "runner network"
  | "storage"
  | "unclassified";

const IMAGE_PULL_LAYER_PATTERNS: ReadonlyArray<{
  readonly code: string;
  readonly layer: ManagedLlamaCppImagePullFailureLayer;
  readonly pattern: RegExp;
}> = [
  {
    code: "authentication-failure",
    layer: "authentication",
    pattern:
      /(?:authentication required|unauthorized|pull access denied|requested access .* denied|credential helper|credentials? store)/iu,
  },
  {
    code: "runner-storage-exhaustion",
    layer: "storage",
    pattern: /(?:no space left on device|disk quota exceeded|insufficient disk space)/iu,
  },
  {
    code: "container-runtime-failure",
    layer: "daemon behavior",
    pattern:
      /(?:cannot connect to the (?:docker|container) daemon|daemon is not running|error during connect|docker pull failed to start)/iu,
  },
  {
    code: "runner-network-failure",
    layer: "runner network",
    pattern:
      /(?:dial tcp|no such host|temporary failure in name resolution|network is unreachable|connection (?:refused|reset)|tls handshake timeout|i\/o timeout|context deadline exceeded|client\.timeout|certificate signed by unknown authority)/iu,
  },
  {
    code: "image-manifest-unavailable",
    layer: "invalid dependency",
    pattern:
      /(?:manifest unknown|manifest .* not found|no matching manifest|no match for platform)/iu,
  },
  {
    code: "registry-availability-failure",
    layer: "registry availability",
    pattern:
      /(?:too many requests|rate limit|service unavailable|bad gateway|gateway timeout|status(?: code)?:? 5\d\d|unexpected status.*5\d\d)/iu,
  },
];

function classifyImagePullFailure(diagnostic: string): {
  readonly code: string;
  readonly layer: ManagedLlamaCppImagePullFailureLayer;
} {
  return (
    IMAGE_PULL_LAYER_PATTERNS.find(({ pattern }) => pattern.test(diagnostic)) ?? {
      code: "unclassified-pull-failure",
      layer: "unclassified",
    }
  );
}

function imagePullFailureDiagnostic(result: ReturnType<ContainerEngine["capture"]>): string {
  const sources = [result.stdout, result.stderr, result.error?.message].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const diagnostic = sources.join("\n");
  const classification = classifyImagePullFailure(diagnostic);
  return `Failure classification: ${classification.layer}. Diagnostic code: ${classification.code}. Exit status: ${String(result.status)}. Raw pull output suppressed.`;
}

function requireSuccess(label: string, result: ReturnType<ContainerEngine["capture"]>): string {
  if (result.error || result.status !== 0) {
    throw new Error(`Managed llama.cpp ${label} failed (exit ${String(result.status)}).`);
  }
  return result.stdout;
}

function parsedSingleRow(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Managed llama.cpp ${label} returned unreadable JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== "object") {
    throw new Error(`Managed llama.cpp ${label} was ambiguous.`);
  }
  return parsed[0] as Record<string, unknown>;
}

function inspectNetwork(engine: ContainerEngine): DockerNetworkInspection {
  const result = engine.capture(
    ["network", "inspect", MANAGED_LLAMA_CPP_NETWORK_NAME],
    DOCKER_INSPECT_TIMEOUT_MS,
  );
  if (
    !result.error &&
    result.status === 1 &&
    /(?:No such network|not found)/iu.test(result.stderr.trim())
  ) {
    return { kind: "absent" };
  }
  const row = parsedSingleRow(requireSuccess("network inspection", result), "network inspection");
  const labels = row.Labels;
  if (
    row.Name !== MANAGED_LLAMA_CPP_NETWORK_NAME ||
    row.Internal !== true ||
    row.Driver !== "bridge" ||
    row.Scope !== "local" ||
    typeof row.Id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.Id) ||
    typeof labels !== "object" ||
    labels === null ||
    Array.isArray(labels) ||
    (labels as Record<string, unknown>)[MANAGED_LLAMA_CPP_OWNER_LABEL] !==
      MANAGED_LLAMA_CPP_OWNER_VALUE
  ) {
    throw new Error("The managed llama.cpp network name belongs to another runtime.");
  }
  return { kind: "owned", id: row.Id };
}

function assertContainerNameAvailable(
  engine: ContainerEngine,
  receipt: HostLocalInferenceReceipt | null,
): void {
  if (receipt !== null) return;
  const result = engine.capture(
    ["container", "inspect", MANAGED_LLAMA_CPP_CONTAINER_NAME],
    DOCKER_INSPECT_TIMEOUT_MS,
  );
  if (
    !result.error &&
    result.status === 1 &&
    /(?:No such container|No such object)/iu.test(result.stderr.trim())
  ) {
    return;
  }
  if (!result.error && result.status === 0) {
    throw new Error("The managed llama.cpp container name belongs to another runtime.");
  }
  throw new Error("Managed llama.cpp could not prove that its container name is available.");
}

function rollbackFreshUnjournaledInstall(input: {
  readonly engine: ContainerEngine | null;
  readonly owner: ReturnType<typeof claimManagedLlamaCppOwner>["owner"] | null;
  readonly ownerCreated: boolean;
  readonly paths: ManagedLlamaCppStatePaths;
}): string | null {
  if (!input.ownerCreated || input.owner === null) return null;
  try {
    const journalStore = createHostLocalCreateJournalStore(input.paths.stateDir);
    if (journalStore.list().length > 0 || loadManagedLlamaCppReceipt(input.paths) !== null) {
      return null;
    }
    if (JSON.stringify(loadManagedLlamaCppOwner(input.paths)) !== JSON.stringify(input.owner)) {
      throw new Error("gateway ownership changed before rollback");
    }
    if (input.engine !== null) {
      assertContainerNameAvailable(input.engine, null);
    }
    if (
      journalStore.list().length > 0 ||
      loadManagedLlamaCppReceipt(input.paths) !== null ||
      JSON.stringify(loadManagedLlamaCppOwner(input.paths)) !== JSON.stringify(input.owner)
    ) {
      throw new Error("managed state changed before rollback");
    }
    fs.rmSync(input.paths.stateDir, { recursive: true });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function sharedHuggingFaceCacheRoot(homeDir: string): string {
  return path.join(homeDir, ".cache", "huggingface");
}

function createDirectoryIfAbsent(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function requireCurrentUserCacheDirectory(directory: string, label: string): void {
  const status = fs.lstatSync(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== uid ||
    (status.mode & 0o022) !== 0 ||
    fs.realpathSync(directory) !== directory
  ) {
    throw new Error(`${label} is not current-user filesystem authority.`);
  }
}

function ensureSharedHuggingFaceCache(homeDir: string): string {
  const cacheParent = path.join(homeDir, ".cache");
  const cacheRoot = sharedHuggingFaceCacheRoot(homeDir);
  createDirectoryIfAbsent(cacheParent);
  requireCurrentUserCacheDirectory(cacheParent, "The shared cache parent");
  createDirectoryIfAbsent(cacheRoot);
  requireCurrentUserCacheDirectory(cacheParent, "The shared cache parent");
  requireCurrentUserCacheDirectory(cacheRoot, "The shared Hugging Face cache");
  return cacheRoot;
}

function runtimeIdentity(): { uid: number; gid: number; dockerUser: string } {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new Error("Managed llama.cpp requires numeric host user identity.");
  }
  const uid = process.getuid();
  const gid = process.getgid();
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
    throw new Error("Managed llama.cpp must run as a non-root host identity.");
  }
  return { uid, gid, dockerUser: `${String(uid)}:${String(gid)}` };
}

function launchContract(
  selection: ResolvedLlamaCppInferenceSelection,
): LlamaCppHostLocalLaunchContract {
  const { recipe } = selection;
  const file = recipe.spec.model.files[0]!;
  return {
    model: {
      servedName: recipe.spec.model.servedName,
      file: { digest: file.digest, path: file.path, sizeBytes: file.sizeBytes },
    },
    policy: recipe.spec.policy,
    runtime: {
      restartPolicy: recipe.spec.runtime.restartPolicy,
      gpu: recipe.spec.runtime.gpu,
      resources: recipe.spec.runtime.resources,
    },
    serve: {
      authentication: recipe.spec.serve.authentication,
      batchSize: recipe.spec.serve.batchSize,
      chatTemplate: recipe.spec.serve.chatTemplate,
      ...(recipe.spec.serve.chatTemplateFile
        ? { chatTemplateFile: recipe.spec.serve.chatTemplateFile }
        : {}),
      ...(recipe.spec.serve.chatTemplateArguments
        ? { chatTemplateArguments: recipe.spec.serve.chatTemplateArguments }
        : {}),
      ...(recipe.spec.serve.reasoning ? { reasoning: recipe.spec.serve.reasoning } : {}),
      contextSize: recipe.spec.serve.contextSize,
      flashAttention: recipe.spec.serve.flashAttention,
      idleSleepSeconds: recipe.spec.serve.idleSleepSeconds,
      kvCache: recipe.spec.serve.kvCache,
      limits: {
        maxRequestBodyBytes: recipe.spec.serve.limits.maxRequestBodyBytes,
        maxRequestHeaderBytes: recipe.spec.serve.limits.maxRequestHeaderBytes,
        maxOutputTokens: recipe.spec.serve.limits.maxOutputTokens,
        requestTimeoutSeconds: recipe.spec.serve.limits.requestTimeoutSeconds,
        shutdownTimeoutSeconds: recipe.spec.serve.limits.shutdownTimeoutSeconds,
      },
      requestGuard: { upstreamPort: recipe.spec.serve.requestGuard.upstreamPort },
      microBatchSize: recipe.spec.serve.microBatchSize,
      port: recipe.spec.serve.port,
      protocol: recipe.spec.serve.protocol,
      slots: recipe.spec.serve.slots,
      speculativeDecoding: recipe.spec.serve.speculativeDecoding,
    },
    surfaces: recipe.spec.surfaces,
  };
}

async function pullExactImages(
  images: readonly string[],
  engine: ContainerEngine,
  log: (message: string) => void,
): Promise<void> {
  for (const image of new Set(images)) {
    const before = engine.capture(["image", "inspect", image], DOCKER_INSPECT_TIMEOUT_MS);
    if (!before.error && before.status === 0) continue;
    if (
      before.error ||
      before.status !== 1 ||
      !/(?:No such image|No such object|not found)/iu.test(before.stderr.trim())
    ) {
      throw new Error(`Managed llama.cpp could not prove local image availability for ${image}.`);
    }
    log(`  Pulling pinned managed-inference image ${image}`);
    const result = engine.capture(["pull", image], IMAGE_PULL_TIMEOUT_MS);
    if (result.status !== 0 || result.error !== undefined) {
      throw new Error(
        `Pinned managed-inference image pull failed for ${image}. ${imagePullFailureDiagnostic(result)}`,
      );
    }
    const after = engine.capture(["image", "inspect", image], DOCKER_INSPECT_TIMEOUT_MS);
    if (after.error || after.status !== 0) {
      throw new Error(`Pinned managed-inference image is unavailable after pull for ${image}.`);
    }
  }
}

function requireExactImagesPresent(engine: ContainerEngine, images: readonly string[]): void {
  for (const image of new Set(images)) {
    const result = engine.capture(["image", "inspect", image], DOCKER_INSPECT_TIMEOUT_MS);
    if (result.error || result.status !== 0) {
      throw new Error(`Managed llama.cpp resume requires the pinned local image ${image}.`);
    }
  }
}

export function resolveManagedLlamaCppOwnerSelection(
  owner: NonNullable<ReturnType<typeof loadManagedLlamaCppOwner>>,
): ResolvedLlamaCppInferenceSelection {
  const catalog = loadManagedInferenceCatalog();
  if (catalog.catalogDigest !== owner.catalogDigest) {
    throw new Error("Managed llama.cpp catalog authority changed; rerun onboarding.");
  }
  const recipe = catalog.recipes.find(({ metadata }) => metadata.id === owner.recipeId);
  const candidatePresets = catalog.presets.filter(
    ({ spec }) =>
      spec.selection !== "disabled" &&
      spec.plan.backend === "install-llama-cpp" &&
      spec.plan.recipeRef === owner.recipeId,
  );
  if (!recipe || !isLlamaCppServingRecipe(recipe) || candidatePresets.length === 0) {
    throw new Error("Managed llama.cpp declarative authority is unavailable.");
  }
  const matchingPresets = candidatePresets.filter(({ metadata }) =>
    catalog.sources.some(
      ({ kind, id, digest }) =>
        kind === "ServingPreset" && id === metadata.id && digest === owner.presetDigest,
    ),
  );
  if (matchingPresets.length !== 1) {
    throw new Error("Managed llama.cpp recipe authority changed; rerun onboarding.");
  }
  const preset = matchingPresets[0]!;
  const recipeDigest = catalog.sources.find(
    ({ kind, id }) => kind === "ServingRecipe" && id === recipe.metadata.id,
  )?.digest;
  const presetDigest = catalog.sources.find(
    ({ kind, id }) => kind === "ServingPreset" && id === preset.metadata.id,
  )?.digest;
  if (recipeDigest !== owner.recipeDigest || presetDigest !== owner.presetDigest) {
    throw new Error("Managed llama.cpp recipe authority changed; rerun onboarding.");
  }
  return {
    outcome: "selected",
    selection: "explicit",
    catalogDigest: catalog.catalogDigest,
    recipeDigest,
    presetDigest,
    recipe,
    preset,
  };
}

function lifecycleFor(input: {
  readonly selection: ResolvedLlamaCppInferenceSelection;
  readonly paths: ManagedLlamaCppStatePaths;
  readonly cacheRoot: string;
  readonly artifact: VerifiedLocalModelArtifact;
  readonly operation: HostLocalInferenceOperation;
}): HostLocalLlamaCppLifecycle {
  const identity = runtimeIdentity();
  const recipe = input.selection.recipe;
  return input.operation.createLlamaCppLifecycle({
    authorityStore: createFilePersistedEngineAuthorityStore(input.paths.stateDir),
    apiKeyRootHostPath: input.paths.stateDir,
    bindingSha256: input.operation.bindingSha256,
    bindings: {
      apiKeyHostPath: input.paths.apiKeyPath,
      containerName: MANAGED_LLAMA_CPP_CONTAINER_NAME,
      hostPort: recipe.spec.serve.port,
      imageReference: recipe.spec.runtime.image,
      model: input.artifact,
      network: { isolation: "docker-internal", name: MANAGED_LLAMA_CPP_NETWORK_NAME },
      ownerLabel: {
        name: MANAGED_LLAMA_CPP_OWNER_LABEL,
        value: MANAGED_LLAMA_CPP_OWNER_VALUE,
      },
      identityLabels: [{ name: "io.nvidia.nemoclaw.llama-cpp.recipe", value: recipe.metadata.id }],
      runtimeGid: identity.gid,
      runtimeUid: identity.uid,
    },
    cacheRootHostPath: input.cacheRoot,
    contract: launchContract(input.selection),
    engine: input.operation.engine,
    journalStore: createHostLocalCreateJournalStore(input.paths.stateDir),
    plan: compileLlamaCppGgufCachePlan(recipe),
    probeImageReference: recipe.spec.readiness.probeImage,
    readinessTimeoutSeconds: recipe.spec.readiness.timeoutSeconds,
  });
}

function currentManagedLlamaCppArtifact(
  selection: ResolvedLlamaCppInferenceSelection,
  homeDir: string,
): { readonly artifact: VerifiedLocalModelArtifact; readonly cacheRoot: string } {
  const cacheRoot = sharedHuggingFaceCacheRoot(homeDir);
  const plan = compileLlamaCppGgufCachePlan(selection.recipe);
  const source = plan.acquisition.source;
  const snapshotEntry = path.join(
    cacheRoot,
    "hub",
    `models--${source.repository.replaceAll("/", "--")}`,
    "snapshots",
    source.revision,
    source.file.path,
  );
  let hostPath: string;
  let status: fs.BigIntStats;
  try {
    hostPath = fs.realpathSync(snapshotEntry);
    status = fs.lstatSync(hostPath, { bigint: true });
  } catch {
    throw new Error("Managed llama.cpp exact GGUF cache entry is unavailable.");
  }
  if (!status.isFile()) {
    throw new Error("Managed llama.cpp exact GGUF cache entry is not a regular file.");
  }
  return {
    cacheRoot,
    artifact: {
      digest: source.file.digest,
      filesystemIdentity: {
        ctimeNs: status.ctimeNs,
        dev: status.dev,
        ino: status.ino,
        mtimeNs: status.mtimeNs,
        size: status.size,
      },
      hostPath,
      sizeBytes: source.file.sizeBytes,
    },
  };
}

/**
 * Reconstruct the existing private llama.cpp lifecycle without changing its
 * owner, journal, API key, or receipt. The caller supplies durable explicit
 * lifecycle provenance before this seam is reached.
 */
export function rehydrateManagedLlamaCppLifecycle(
  options: ManagedLlamaCppLifecycleRehydrationOptions,
): ManagedLlamaCppLifecycleRehydration {
  const homeDir = fs.realpathSync(options.homeDir ?? os.homedir());
  const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
  const owner = loadManagedLlamaCppOwner(paths);
  if (!owner || owner.sandboxName !== options.runtimeOwnerSandboxName) {
    throw new Error("Managed llama.cpp private owner differs from lifecycle provenance.");
  }
  const receipt = loadManagedLlamaCppReceipt(paths);
  if (!receipt) throw new Error("Managed llama.cpp private receipt is unavailable.");
  const selection = resolveManagedLlamaCppOwnerSelection(owner);
  const operation = requireRuntimeProviderHostLocalInferenceOperation(
    options.runtimeProvider,
    "llama-cpp",
    { env: options.env ?? process.env },
    options.operation,
  );
  operation.assertAuthority();
  const current = currentManagedLlamaCppArtifact(selection, homeDir);
  return Object.freeze({
    lifecycle: lifecycleFor({
      selection,
      paths,
      cacheRoot: current.cacheRoot,
      artifact: current.artifact,
      operation,
    }),
    operation,
    owner,
    paths,
    receipt,
    selection,
  });
}

/** Reconstruct current declarative and filesystem authority, then use the lifecycle's exact inspector. */
export function inspectManagedLlamaCppRuntimeExact(
  options: ManagedLlamaCppExactInspectionOptions,
): ReturnType<HostLocalLlamaCppLifecycle["runtime"]["inspectManaged"]> {
  const current = currentManagedLlamaCppArtifact(options.selection, options.homeDir);
  return lifecycleFor({
    selection: options.selection,
    paths: options.paths,
    cacheRoot: current.cacheRoot,
    artifact: current.artifact,
    operation: options.operation,
  }).runtime.inspectManaged(options.receipt);
}

/** Activate one catalog-selected managed llama.cpp runtime for a gateway owner. */
export async function installManagedLlamaCpp(
  selection: ResolvedLlamaCppInferenceSelection,
  options: ManagedLlamaCppInstallOptions,
): Promise<ManagedLlamaCppInstallResult> {
  const env = options.env ?? process.env;
  const homeDir = fs.realpathSync(options.homeDir ?? os.homedir());
  const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
  const acquire = options.acquireGguf ?? acquireVerifiedLlamaCppGguf;
  const verify = options.verifyGguf ?? verifyLlamaCppGgufCacheEntry;
  const checkPort = options.checkPort ?? checkPortAvailable;
  const log = options.log ?? ((message: string) => console.log(message));
  const recipe = selection.recipe;
  const hostPort = recipe.spec.serve.port;
  let engine: ContainerEngine | null = null;
  let operation: HostLocalInferenceOperation | null = null;
  let owner: ReturnType<typeof claimManagedLlamaCppOwner>["owner"] | null = null;
  let ownerCreated = false;

  try {
    operation = requireRuntimeProviderHostLocalInferenceOperation(
      options.runtimeProvider,
      "llama-cpp",
      { env },
    );
    engine = operation.engine;
    options.revalidateSandboxIdentity?.("reserve the managed llama.cpp runtime");
    const reservation = claimManagedLlamaCppOwner(paths, {
      schemaVersion: 1,
      sandboxName: options.sandboxName,
      catalogDigest: selection.catalogDigest,
      presetDigest: selection.presetDigest,
      recipeDigest: selection.recipeDigest,
      recipeId: recipe.metadata.id,
    });
    owner = reservation.owner;
    ownerCreated = reservation.created;
    createFilePersistedEngineAuthorityStore(paths.stateDir).record(
      createPersistedEngineAuthority(operation.providerId, engine, operation.bindingSha256),
    );
    const persistedReceipt = loadManagedLlamaCppReceipt(paths);
    const journalStore = createHostLocalCreateJournalStore(paths.stateDir);
    const pending = journalStore.list().filter(({ phase }) => phase !== "finalized");
    if (pending.length > 1) {
      throw new Error("Managed llama.cpp has more than one unfinished create transaction.");
    }
    inspectNetwork(engine);
    assertContainerNameAvailable(engine, persistedReceipt);

    if (persistedReceipt === null && pending.length === 0) {
      const port = await checkPort(hostPort);
      if (!port.ok) {
        throw new Error(
          `Managed llama.cpp port ${String(hostPort)} is unavailable: ${port.reason}`,
        );
      }
    }

    const plan = compileLlamaCppGgufCachePlan(recipe);
    const dockerEnv = buildVllmDockerEnv({}, env);
    for (const name of [
      "DOCKER_CERT_PATH",
      "DOCKER_CONFIG",
      "DOCKER_CONTEXT",
      "DOCKER_HOST",
      "DOCKER_TLS",
      "DOCKER_TLS_VERIFY",
    ]) {
      delete dockerEnv[name];
    }
    const cacheRoot = ensureSharedHuggingFaceCache(homeDir);
    let artifact: VerifiedLocalModelArtifact | null = null;
    let acquireModel = false;
    try {
      log("  Verifying the exact llama.cpp GGUF in the shared Hugging Face cache");
      artifact = await verify(plan, cacheRoot);
    } catch {
      acquireModel = true;
    }
    await pullExactImages(
      [
        ...(acquireModel ? [plan.acquisition.downloaderImage] : []),
        recipe.spec.runtime.image,
        recipe.spec.readiness.probeImage,
      ],
      engine,
      log,
    );
    if (acquireModel) {
      log("  Acquiring and verifying the exact llama.cpp GGUF in the shared Hugging Face cache");
      const identity = runtimeIdentity();
      artifact = await acquire({
        assertDockerAuthority: operation.assertAuthority,
        execution: {
          credentialEnv: env,
          dockerEnv,
          downloaderImage: plan.acquisition.downloaderImage,
          hostCacheDir: cacheRoot,
          spawnDocker: operation.spawn,
          userIdentity: identity.dockerUser,
        },
        observer: {
          logLine: (line) => log(`  ${line}`),
          onRateLimit: () => log("  Hugging Face rate limit reached; set HF_TOKEN and retry."),
        },
        plan,
      });
    }
    if (artifact === null) {
      throw new Error("Managed llama.cpp could not verify its exact GGUF artifact.");
    }
    options.revalidateSandboxIdentity?.("activate the managed llama.cpp runtime");
    loadOrCreateManagedLlamaCppApiKey(paths);
    const lifecycle = lifecycleFor({
      selection,
      paths,
      cacheRoot,
      artifact,
      operation,
    });

    if (pending.length === 1) {
      const recovery = lifecycle.recoverUnfinished(
        createManagedLlamaCppReceiptWriter(paths, pending[0]!.transactionId),
      );
      if (recovery.failures.length > 0) {
        throw new Error(`Managed llama.cpp recovery failed: ${recovery.failures[0]!.message}`);
      }
    }

    let receipt = loadManagedLlamaCppReceipt(paths);
    if (receipt !== null) {
      options.revalidateSandboxIdentity?.("resume the managed llama.cpp runtime");
      receipt = lifecycle.resume(receipt);
    } else {
      const port = await checkPort(hostPort);
      if (!port.ok) {
        throw new Error(
          `Managed llama.cpp port ${String(hostPort)} is unavailable: ${port.reason}`,
        );
      }
      options.revalidateSandboxIdentity?.("start the managed llama.cpp runtime");
      const transactionId = randomBytes(32).toString("hex");
      receipt = lifecycle.start(createManagedLlamaCppReceiptWriter(paths, transactionId));
    }
    options.revalidateSandboxIdentity?.("report successful managed llama.cpp runtime activation");
    const apiKey = loadOrCreateManagedLlamaCppApiKey(paths);
    env[LLAMA_CPP_CREDENTIAL_ENV] = apiKey;
    return { ok: true, apiKey, model: recipe.spec.model.servedName, receipt };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const rollbackError = rollbackFreshUnjournaledInstall({
      engine,
      owner,
      ownerCreated,
      paths,
    });
    return {
      ok: false,
      reason:
        rollbackError === null
          ? reason
          : `${reason} Fresh ownership rollback also failed: ${rollbackError}`,
    };
  }
}

/** Recover one exact gateway-owned runtime during normal resume or rebuild. */
export async function resumeManagedLlamaCppRuntime(
  sandboxName: string,
  options: ManagedLlamaCppResumeOptions,
): Promise<boolean> {
  const env = options.env ?? process.env;
  const homeDir = fs.realpathSync(options.homeDir ?? os.homedir());
  const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
  if (!fs.existsSync(paths.ownerPath)) return false;
  const owner = loadManagedLlamaCppOwner(paths);
  if (owner === null) return false;
  if (owner.sandboxName !== sandboxName) {
    throw new Error(
      `Managed llama.cpp on this gateway is owned by sandbox '${owner.sandboxName}', not '${sandboxName}'.`,
    );
  }

  const selection = resolveManagedLlamaCppOwnerSelection(owner);
  const operation = requireRuntimeProviderHostLocalInferenceOperation(
    options.runtimeProvider,
    "llama-cpp",
    { env },
  );
  options.revalidateSandboxIdentity?.("inspect the managed llama.cpp runtime");
  const engine = operation.engine;
  const verify = options.verifyGguf ?? verifyLlamaCppGgufCacheEntry;
  const checkPort = options.checkPort ?? checkPortAvailable;
  const hostPort = selection.recipe.spec.serve.port;
  const plan = compileLlamaCppGgufCachePlan(selection.recipe);
  const cacheRoot = ensureSharedHuggingFaceCache(homeDir);
  const artifact = await verify(plan, cacheRoot);
  const journalStore = createHostLocalCreateJournalStore(paths.stateDir);
  const pending = journalStore.list().filter(({ phase }) => phase !== "finalized");
  if (pending.length > 1) {
    throw new Error("Managed llama.cpp has more than one unfinished create transaction.");
  }
  let receipt = loadManagedLlamaCppReceipt(paths);
  requireExactImagesPresent(
    engine,
    receipt === null
      ? [selection.recipe.spec.runtime.image, selection.recipe.spec.readiness.probeImage]
      : [selection.recipe.spec.readiness.probeImage],
  );
  const network = inspectNetwork(engine);
  if (network.kind === "absent") {
    if (receipt !== null || pending.some(({ phase }) => phase !== "network-creating")) {
      throw new Error("Managed llama.cpp internal network is absent from persisted authority.");
    }
  }
  const existingKey = loadManagedLlamaCppApiKey(paths);
  if ((receipt !== null || pending.length > 0) && existingKey === null) {
    throw new Error("Managed llama.cpp API-key authority is missing.");
  }
  const lifecycle = lifecycleFor({
    selection,
    paths,
    cacheRoot,
    artifact,
    operation,
  });
  options.revalidateSandboxIdentity?.("recover the managed llama.cpp runtime");
  if (pending.length === 1) {
    const recovery = lifecycle.recoverUnfinished(
      createManagedLlamaCppReceiptWriter(paths, pending[0]!.transactionId),
    );
    if (recovery.failures.length > 0) {
      throw new Error(`Managed llama.cpp recovery failed: ${recovery.failures[0]!.message}`);
    }
    receipt = loadManagedLlamaCppReceipt(paths);
  }
  if (receipt === null) {
    const port = await checkPort(hostPort);
    if (!port.ok) {
      throw new Error(`Managed llama.cpp port ${String(hostPort)} is unavailable: ${port.reason}`);
    }
    options.revalidateSandboxIdentity?.("start the managed llama.cpp runtime");
    loadOrCreateManagedLlamaCppApiKey(paths);
    const transactionId = randomBytes(32).toString("hex");
    lifecycle.start(createManagedLlamaCppReceiptWriter(paths, transactionId));
  } else {
    options.revalidateSandboxIdentity?.("resume the managed llama.cpp runtime");
    lifecycle.resume(receipt);
  }
  options.revalidateSandboxIdentity?.("report successful managed llama.cpp runtime recovery");
  const apiKey = loadManagedLlamaCppApiKey(paths);
  if (apiKey === null) throw new Error("Managed llama.cpp API-key authority is missing.");
  env[LLAMA_CPP_CREDENTIAL_ENV] = apiKey;
  return true;
}
