// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type ContainerEngine,
  type ContainerEngineCommandCapture,
  createContainerEngineCommand,
} from "../../adapters/container-engine";
import { dockerSpawn } from "../../adapters/docker/exec";
import { dockerPullWithProgressWatchdog } from "../../adapters/docker/pull";
import { checkPortAvailable } from "../../onboard/preflight";
import {
  createDockerLlamaCppManagedLifecycle,
  type DockerLlamaCppManagedLifecycle,
} from "../../onboard/runtime-provider/docker-llama-cpp-managed-lifecycle";
import { createHostLocalCreateJournalStore } from "../../onboard/runtime-provider/host-local-create-journal";
import type { HostLocalInferenceReceipt } from "../../onboard/runtime-provider/host-local-inference";
import {
  createFilePersistedEngineAuthorityStore,
  createPersistedEngineAuthority,
} from "../../onboard/runtime-provider/persisted-engine-authority";
import type { HuggingFaceModelAcquisitionRequest } from "../model-acquisition/hugging-face";
import { isLlamaCppServingRecipe } from "../serving/adapter-registry";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import type { ResolvedLlamaCppInferenceSelection } from "../serving/types";
import { buildVllmDockerEnv } from "../vllm-docker-env";
import { LLAMA_CPP_CREDENTIAL_ENV, LLAMA_CPP_PORT } from "./contract";
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
  readonly gatewayPort?: number;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly engine?: ContainerEngine;
  readonly pullImage?: typeof dockerPullWithProgressWatchdog;
  readonly acquireGguf?: typeof acquireVerifiedLlamaCppGguf;
  readonly verifyGguf?: typeof verifyLlamaCppGgufCacheEntry;
  readonly checkPort?: typeof checkPortAvailable;
  readonly createLifecycle?: typeof createDockerLlamaCppManagedLifecycle;
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
  readonly gatewayPort?: number;
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly engine?: ContainerEngine;
  readonly verifyGguf?: typeof verifyLlamaCppGgufCacheEntry;
  readonly checkPort?: typeof checkPortAvailable;
  readonly createLifecycle?: typeof createDockerLlamaCppManagedLifecycle;
}

export interface ManagedLlamaCppExactInspectionOptions {
  readonly createLifecycle?: typeof createDockerLlamaCppManagedLifecycle;
  readonly engine: ContainerEngine;
  readonly homeDir: string;
  readonly paths: ManagedLlamaCppStatePaths;
  readonly receipt: HostLocalInferenceReceipt;
  readonly selection: ResolvedLlamaCppInferenceSelection;
}

interface DockerNetworkInspection {
  readonly kind: "absent" | "owned";
  readonly id?: string;
}

interface ManagedDockerBinding {
  readonly endpointArgs: readonly string[];
  readonly identity: string;
  readonly guard?: () => void;
}

type DockerSpawn = HuggingFaceModelAcquisitionRequest["spawnDocker"];

export interface ManagedLlamaCppDockerAuthority {
  readonly assertAuthority: () => void;
  readonly engine: ContainerEngine;
  readonly spawnDocker: DockerSpawn;
}

const DOCKER_CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const DOCKER_HOST_PATTERN = /^(?:npipe|ssh|tcp|unix):\/\/[^\s\u0000-\u001f\u007f]+$/u;
const DOCKER_ARGUMENT_MAX_BYTES = 16 * 1024;
const DOCKER_CONTEXT_INSPECT_FORMAT = "{{json .Endpoints.docker}}";

function exactDockerValue(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > DOCKER_ARGUMENT_MAX_BYTES ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`Managed llama.cpp ${label} is invalid.`);
  }
  return value;
}

function absoluteDockerPath(value: string, label: string): string {
  const candidate = exactDockerValue(value, label);
  if (!candidate) throw new Error(`Managed llama.cpp ${label} is invalid.`);
  return path.resolve(candidate);
}

function dockerConfigPath(env: NodeJS.ProcessEnv): string {
  const configured = exactDockerValue(env.DOCKER_CONFIG, "DOCKER_CONFIG");
  if (configured) return path.resolve(configured);
  const home = exactDockerValue(env.HOME, "HOME") ?? os.homedir();
  return path.join(path.resolve(home), ".docker");
}

function dockerTlsArgs(env: NodeJS.ProcessEnv): readonly string[] {
  const tls = exactDockerValue(env.DOCKER_TLS, "DOCKER_TLS") !== undefined;
  const tlsVerify = exactDockerValue(env.DOCKER_TLS_VERIFY, "DOCKER_TLS_VERIFY") !== undefined;
  const certPath = exactDockerValue(env.DOCKER_CERT_PATH, "DOCKER_CERT_PATH");
  const args: string[] = [];
  if (tlsVerify) args.push("--tlsverify");
  else if (tls) args.push("--tls");
  if (certPath) {
    const directory = absoluteDockerPath(certPath, "DOCKER_CERT_PATH");
    args.push(
      "--tlscacert",
      path.join(directory, "ca.pem"),
      "--tlscert",
      path.join(directory, "cert.pem"),
      "--tlskey",
      path.join(directory, "key.pem"),
    );
  }
  return Object.freeze(args);
}

function dockerContextName(value: string, label: string): string {
  const context = exactDockerValue(value, label);
  if (!context || !DOCKER_CONTEXT_PATTERN.test(context)) {
    throw new Error(`Managed llama.cpp ${label} is invalid.`);
  }
  return context;
}

function dockerHost(value: string): string {
  const host = exactDockerValue(value, "DOCKER_HOST");
  if (!host || !DOCKER_HOST_PATTERN.test(host)) {
    throw new Error("Managed llama.cpp DOCKER_HOST is invalid.");
  }
  return host;
}

function dockerBindingProbe(
  endpointArgs: readonly string[],
  capture?: ContainerEngineCommandCapture,
): ContainerEngine {
  return createContainerEngineCommand({
    operation: "host-local-inference",
    engineId: "docker",
    displayName: "Docker",
    authorityId: "docker:qualification",
    executable: "docker",
    endpointArgs,
    ...(capture ? { capture } : {}),
  });
}

function requireDockerProbeOutput(
  result: ReturnType<ContainerEngine["capture"]>,
  label: string,
): string {
  if (result.error || result.status !== 0) {
    throw new Error(`Managed llama.cpp could not ${label}.`);
  }
  const output = result.stdout.trim();
  if (!output) throw new Error(`Managed llama.cpp could not ${label}.`);
  return output;
}

function resolvedDockerContextEndpoint(probe: ContainerEngine, context: string): string {
  const output = requireDockerProbeOutput(
    probe.capture(["context", "inspect", context, "--format", DOCKER_CONTEXT_INSPECT_FORMAT]),
    "qualify the Docker context endpoint",
  );
  let endpoint: unknown;
  try {
    endpoint = JSON.parse(output);
  } catch {
    throw new Error("Managed llama.cpp Docker context endpoint is unreadable.");
  }
  if (
    typeof endpoint !== "object" ||
    endpoint === null ||
    typeof (endpoint as { Host?: unknown }).Host !== "string" ||
    typeof (endpoint as { SkipTLSVerify?: unknown }).SkipTLSVerify !== "boolean"
  ) {
    throw new Error("Managed llama.cpp Docker context endpoint is invalid.");
  }
  return JSON.stringify({
    host: dockerHost((endpoint as { Host: string }).Host),
    skipTlsVerify: (endpoint as { SkipTLSVerify: boolean }).SkipTLSVerify,
  });
}

function dockerClientBinding(
  env: NodeJS.ProcessEnv,
  capture?: ContainerEngineCommandCapture,
): ManagedDockerBinding {
  const configArgs = ["--config", dockerConfigPath(env)] as const;
  const tlsArgs = dockerTlsArgs(env);
  const explicitContext = exactDockerValue(env.DOCKER_CONTEXT, "DOCKER_CONTEXT");
  const explicitHost = exactDockerValue(env.DOCKER_HOST, "DOCKER_HOST");
  if (!explicitContext && explicitHost) {
    const endpointArgs = Object.freeze([
      ...configArgs,
      "--host",
      dockerHost(explicitHost),
      ...tlsArgs,
    ]);
    return {
      endpointArgs,
      identity: createHash("sha256").update(JSON.stringify(endpointArgs)).digest("hex"),
    };
  }

  let context: string;
  if (explicitContext) {
    context = dockerContextName(explicitContext, "DOCKER_CONTEXT");
  } else {
    const selectorProbe = dockerBindingProbe([...configArgs, ...tlsArgs], capture);
    context = dockerContextName(
      requireDockerProbeOutput(
        selectorProbe.capture(["context", "show"]),
        "resolve the Docker context",
      ),
      "current Docker context",
    );
  }
  const endpointArgs = Object.freeze([...configArgs, "--context", context, ...tlsArgs]);
  const endpointProbe = dockerBindingProbe(endpointArgs, capture);
  const qualifiedEndpoint = resolvedDockerContextEndpoint(endpointProbe, context);
  const identity = createHash("sha256")
    .update(JSON.stringify({ endpointArgs, qualifiedEndpoint }))
    .digest("hex");
  return {
    endpointArgs,
    identity,
    guard: () => {
      if (resolvedDockerContextEndpoint(endpointProbe, context) !== qualifiedEndpoint) {
        throw new Error(
          "Managed llama.cpp Docker context endpoint changed after qualification; retry the operation.",
        );
      }
    },
  };
}

export function createManagedLlamaCppEngine(
  env: NodeJS.ProcessEnv = process.env,
  capture?: ContainerEngineCommandCapture,
): ContainerEngine {
  return createManagedLlamaCppDockerAuthority(env, capture).engine;
}

/** Bind synchronous lifecycle commands and streamed acquisition to one qualified daemon. */
export function createManagedLlamaCppDockerAuthority(
  env: NodeJS.ProcessEnv = process.env,
  capture?: ContainerEngineCommandCapture,
  spawnDocker: DockerSpawn = dockerSpawn,
): ManagedLlamaCppDockerAuthority {
  const binding = dockerClientBinding(env, capture);
  const assertAuthority = () => binding.guard?.();
  const engine = createContainerEngineCommand({
    operation: "host-local-inference",
    engineId: "docker",
    displayName: "Docker",
    authorityId: `docker:${binding.identity}`,
    executable: "docker",
    endpointArgs: binding.endpointArgs,
    ...(capture ? { capture } : {}),
    ...(binding.guard ? { guard: binding.guard } : {}),
  });
  return Object.freeze({
    assertAuthority,
    engine,
    spawnDocker: (args: Parameters<DockerSpawn>[0], options?: Parameters<DockerSpawn>[1]) => {
      assertAuthority();
      return spawnDocker([...binding.endpointArgs, ...args], options);
    },
  });
}

export function managedLlamaCppBindingSha256(engine: ContainerEngine): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: engine.operation,
        engineId: engine.engineId,
        authorityId: engine.authorityId,
        executable: "docker",
      }),
    )
    .digest("hex");
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

function ensureSharedHuggingFaceCache(homeDir: string): string {
  const cacheRoot = path.join(homeDir, ".cache", "huggingface");
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const status = fs.lstatSync(cacheRoot);
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== uid ||
    (status.mode & 0o022) !== 0 ||
    fs.realpathSync(cacheRoot) !== cacheRoot
  ) {
    throw new Error("The shared Hugging Face cache is not current-user filesystem authority.");
  }
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
      contextSize: recipe.spec.serve.contextSize,
      flashAttention: recipe.spec.serve.flashAttention,
      idleSleepSeconds: recipe.spec.serve.idleSleepSeconds,
      kvCache: recipe.spec.serve.kvCache,
      limits: { requestTimeoutSeconds: recipe.spec.serve.limits.requestTimeoutSeconds },
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
  pull: typeof dockerPullWithProgressWatchdog | undefined,
  dockerEnv: Record<string, string>,
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
    const result = pull
      ? await pull(image, {
          env: dockerEnv,
          maxTimeoutMs: IMAGE_PULL_TIMEOUT_MS,
          logLine: (line) => log(`  ${line}`),
        })
      : engine.capture(["pull", image], IMAGE_PULL_TIMEOUT_MS);
    if (result.status !== 0 || ("error" in result && result.error !== undefined)) {
      throw new Error(`Pinned managed-inference image pull failed for ${image}.`);
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
  const preset = catalog.presets.find(
    ({ spec }) =>
      spec.selection === "explicit-only" &&
      spec.plan.backend === "install-llama-cpp" &&
      spec.plan.recipeRef === owner.recipeId,
  );
  if (!recipe || !isLlamaCppServingRecipe(recipe) || !preset) {
    throw new Error("Managed llama.cpp declarative authority is unavailable.");
  }
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
  readonly engine: ContainerEngine;
  readonly createLifecycle: typeof createDockerLlamaCppManagedLifecycle;
}): DockerLlamaCppManagedLifecycle {
  const identity = runtimeIdentity();
  const recipe = input.selection.recipe;
  return input.createLifecycle({
    authorityStore: createFilePersistedEngineAuthorityStore(input.paths.stateDir),
    apiKeyRootHostPath: input.paths.stateDir,
    bindingSha256: managedLlamaCppBindingSha256(input.engine),
    bindings: {
      apiKeyHostPath: input.paths.apiKeyPath,
      containerName: MANAGED_LLAMA_CPP_CONTAINER_NAME,
      hostPort: LLAMA_CPP_PORT,
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
    engine: input.engine,
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
  const cacheRoot = path.join(homeDir, ".cache", "huggingface");
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

/** Reconstruct current declarative and filesystem authority, then use the lifecycle's exact inspector. */
export function inspectManagedLlamaCppRuntimeExact(
  options: ManagedLlamaCppExactInspectionOptions,
): ReturnType<DockerLlamaCppManagedLifecycle["runtime"]["inspectManaged"]> {
  const current = currentManagedLlamaCppArtifact(options.selection, options.homeDir);
  return lifecycleFor({
    selection: options.selection,
    paths: options.paths,
    cacheRoot: current.cacheRoot,
    artifact: current.artifact,
    engine: options.engine,
    createLifecycle: options.createLifecycle ?? createDockerLlamaCppManagedLifecycle,
  }).runtime.inspectManaged(options.receipt);
}

/** Activate one catalog-selected managed llama.cpp runtime for a gateway owner. */
export async function installManagedLlamaCpp(
  selection: ResolvedLlamaCppInferenceSelection,
  options: ManagedLlamaCppInstallOptions,
): Promise<ManagedLlamaCppInstallResult> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const paths = managedLlamaCppStatePaths(homeDir, options.gatewayPort);
  const pull = options.pullImage;
  const acquire = options.acquireGguf ?? acquireVerifiedLlamaCppGguf;
  const verify = options.verifyGguf ?? verifyLlamaCppGgufCacheEntry;
  const checkPort = options.checkPort ?? checkPortAvailable;
  const createLifecycle = options.createLifecycle ?? createDockerLlamaCppManagedLifecycle;
  const log = options.log ?? ((message: string) => console.log(message));
  const recipe = selection.recipe;
  let engine: ContainerEngine | null = null;
  let owner: ReturnType<typeof claimManagedLlamaCppOwner>["owner"] | null = null;
  let ownerCreated = false;

  try {
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
    const dockerAuthority = options.engine ? null : createManagedLlamaCppDockerAuthority(env);
    engine = options.engine ?? dockerAuthority!.engine;
    createFilePersistedEngineAuthorityStore(paths.stateDir).record(
      createPersistedEngineAuthority("docker", engine, managedLlamaCppBindingSha256(engine)),
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
      const port = await checkPort(LLAMA_CPP_PORT);
      if (!port.ok) {
        throw new Error(
          `Managed llama.cpp port ${String(LLAMA_CPP_PORT)} is unavailable: ${port.reason}`,
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
      pull,
      dockerEnv,
      log,
    );
    if (acquireModel) {
      if (dockerAuthority === null && options.acquireGguf === undefined) {
        throw new Error(
          "Managed llama.cpp GGUF acquisition requires its qualified Docker authority.",
        );
      }
      log("  Acquiring and verifying the exact llama.cpp GGUF in the shared Hugging Face cache");
      const identity = runtimeIdentity();
      artifact = await acquire({
        ...(dockerAuthority ? { assertDockerAuthority: dockerAuthority.assertAuthority } : {}),
        execution: {
          credentialEnv: env,
          dockerEnv,
          downloaderImage: plan.acquisition.downloaderImage,
          hostCacheDir: cacheRoot,
          spawnDocker:
            dockerAuthority?.spawnDocker ??
            (() => {
              throw new Error(
                "Managed llama.cpp GGUF acquisition requires its qualified Docker authority.",
              );
            }),
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
    loadOrCreateManagedLlamaCppApiKey(paths);
    const lifecycle = lifecycleFor({
      selection,
      paths,
      cacheRoot,
      artifact,
      engine,
      createLifecycle,
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
      receipt = lifecycle.resume(receipt);
    } else {
      const port = await checkPort(LLAMA_CPP_PORT);
      if (!port.ok) {
        throw new Error(
          `Managed llama.cpp port ${String(LLAMA_CPP_PORT)} is unavailable: ${port.reason}`,
        );
      }
      const transactionId = randomBytes(32).toString("hex");
      receipt = lifecycle.start(createManagedLlamaCppReceiptWriter(paths, transactionId));
    }
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
  options: ManagedLlamaCppResumeOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
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
  const engine = options.engine ?? createManagedLlamaCppEngine(env);
  const verify = options.verifyGguf ?? verifyLlamaCppGgufCacheEntry;
  const createLifecycle = options.createLifecycle ?? createDockerLlamaCppManagedLifecycle;
  const checkPort = options.checkPort ?? checkPortAvailable;
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
    engine,
    createLifecycle,
  });
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
    const port = await checkPort(LLAMA_CPP_PORT);
    if (!port.ok) {
      throw new Error(
        `Managed llama.cpp port ${String(LLAMA_CPP_PORT)} is unavailable: ${port.reason}`,
      );
    }
    loadOrCreateManagedLlamaCppApiKey(paths);
    const transactionId = randomBytes(32).toString("hex");
    receipt = lifecycle.start(createManagedLlamaCppReceiptWriter(paths, transactionId));
  } else {
    receipt = lifecycle.resume(receipt);
  }
  const apiKey = loadManagedLlamaCppApiKey(paths);
  if (apiKey === null) throw new Error("Managed llama.cpp API-key authority is missing.");
  env[LLAMA_CPP_CREDENTIAL_ENV] = apiKey;
  return true;
}
