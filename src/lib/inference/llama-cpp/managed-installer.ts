// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  dockerCapture,
  dockerForceRm,
  dockerPullWithProgressWatchdog,
  dockerRun,
} from "../../adapters/docker/local-model-runtime";
import {
  ensureLocalAdapterStateDir,
  removeLocalAdapterFile,
  writeLocalAdapterJsonFile,
} from "../local-adapter-lifecycle";
import { runtimeAuthFingerprint } from "../serving/runtime-auth-fingerprint";
import type { LlamaCppServingRecipe } from "../serving/types";
import { compileLlamaCppGgufCachePlan, type LlamaCppGgufCachePlan } from "./gguf-cache-plan";
import {
  createLlamaCppGgufCacheEntryReceipt,
  type LlamaCppGgufCacheOwner,
  parseLlamaCppGgufCacheEntryReceipt,
} from "./gguf-cache-receipt";
import {
  buildLlamaCppHostLocalDockerArgv,
  type LlamaCppHostLocalLaunchContract,
  type VerifiedLocalModelArtifact,
} from "./host-local-runtime";
import { LLAMA_CPP_CREDENTIAL_ENV, LLAMA_CPP_PORT, probeLlamaCppAttachment } from "./index";

export const MANAGED_LLAMA_CPP_CONTAINER_NAME = "nemoclaw-llama-cpp" as const;
export const MANAGED_LLAMA_CPP_NETWORK_NAME = "nemoclaw-llama-cpp-internal" as const;
export const MANAGED_LLAMA_CPP_OWNER_LABEL = "com.nvidia.nemoclaw.managed-llama-cpp" as const;
export const MANAGED_LLAMA_CPP_OWNER_VALUE = "local-model-profile-v1" as const;
export const MANAGED_LLAMA_CPP_CACHE_OWNER_ID = "nemoclaw-local-model-profile" as const;
export const MANAGED_LLAMA_CPP_AUTH_LABEL = "com.nvidia.nemoclaw.llama-cpp-auth" as const;
export const MANAGED_LLAMA_CPP_GENERATION_LABEL =
  "com.nvidia.nemoclaw.llama-cpp-generation" as const;
export const MANAGED_LLAMA_CPP_RUNTIME_RECEIPT_FILE = "runtime.json" as const;

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export interface ManagedLlamaCppInstallOptions {
  homeDir?: string;
  fetchImpl?: typeof fetch;
  dockerCaptureImpl?: typeof dockerCapture;
  dockerForceRmImpl?: typeof dockerForceRm;
  dockerRunImpl?: typeof dockerRun;
  dockerPullImpl?: typeof dockerPullWithProgressWatchdog;
  probeImpl?: typeof probeLlamaCppAttachment;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  randomBytes?: typeof crypto.randomBytes;
  now?: () => number;
  log?: (message: string) => void;
}

export type ManagedLlamaCppInstallResult =
  | { ok: true; apiKey: string; model: string }
  | { ok: false; reason: string };

function stateDir(homeDir: string): string {
  return path.join(homeDir, ".nemoclaw", "managed-llama-cpp");
}

function cacheRoot(homeDir: string): string {
  return path.join(homeDir, ".cache", "nemoclaw", "llama-cpp");
}

function cacheEntryDir(homeDir: string, plan: LlamaCppGgufCachePlan): string {
  return path.join(cacheRoot(homeDir), plan.cache.key);
}

function ensurePrivateDirectory(directory: string): void {
  ensureLocalAdapterStateDir(directory);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe llama.cpp directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`llama.cpp directory is not owned by the current user: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

function readPrivateRegularFile(filePath: string): string | null {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Secure no-follow file opens are unavailable on this platform.");
  }
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Managed llama.cpp state is not an owner-only regular file: ${filePath}`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Managed llama.cpp state has an unexpected owner: ${filePath}`);
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function createPrivateFile(filePath: string, value: string): void {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Secure no-follow file opens are unavailable on this platform.");
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(fd, value, "utf8");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function ownerForCache(
  directory: string,
  randomBytes: typeof crypto.randomBytes,
): LlamaCppGgufCacheOwner {
  const ownerPath = path.join(directory, "owner.json");
  const raw = readPrivateRegularFile(ownerPath);
  let existing: Record<string, unknown> | null = null;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      existing = parsed as Record<string, unknown>;
    } catch {
      throw new Error("Managed llama.cpp owner state is malformed.");
    }
  }
  if (existing) {
    if (
      existing.id !== MANAGED_LLAMA_CPP_CACHE_OWNER_ID ||
      typeof existing.generation !== "string" ||
      !/^[a-f0-9]{32}$/.test(existing.generation)
    ) {
      throw new Error("Managed llama.cpp owner state is malformed.");
    }
    return {
      id: MANAGED_LLAMA_CPP_CACHE_OWNER_ID,
      generation: existing.generation,
    };
  }
  const owner = {
    id: MANAGED_LLAMA_CPP_CACHE_OWNER_ID,
    generation: randomBytes(16).toString("hex"),
  } as const;
  createPrivateFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
  return owner;
}

function bindOwnerToRuntimeState(directory: string, owner: LlamaCppGgufCacheOwner): void {
  const ownerPath = path.join(directory, "owner.json");
  const raw = readPrivateRegularFile(ownerPath);
  if (!raw) {
    createPrivateFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Managed llama.cpp runtime owner state is malformed.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).id !== owner.id ||
    (parsed as Record<string, unknown>).generation !== owner.generation ||
    Object.keys(parsed as Record<string, unknown>)
      .sort()
      .join(",") !== "generation,id"
  ) {
    throw new Error("Managed llama.cpp runtime owner does not match the cache owner.");
  }
}

function persistRuntimeReceipt(
  directory: string,
  input: {
    owner: LlamaCppGgufCacheOwner;
    apiKeyFingerprint: string;
    containerId: string;
    networkId: string;
    recipe: LlamaCppServingRecipe;
    artifact: VerifiedLocalModelArtifact;
  },
): void {
  writeLocalAdapterJsonFile(path.join(directory, MANAGED_LLAMA_CPP_RUNTIME_RECEIPT_FILE), {
    schemaVersion: 1,
    receiptRef: "llama-cpp.host-local.receipt/v1",
    owner: input.owner,
    authentication: { fingerprint: input.apiKeyFingerprint },
    container: {
      name: MANAGED_LLAMA_CPP_CONTAINER_NAME,
      id: input.containerId,
    },
    network: { name: MANAGED_LLAMA_CPP_NETWORK_NAME, id: input.networkId },
    runtime: { image: input.recipe.spec.runtime.image },
    model: {
      servedName: input.recipe.spec.model.servedName,
      digest: input.artifact.digest,
      sizeBytes: input.artifact.sizeBytes,
    },
  });
}

function apiKeyForState(directory: string, randomBytes: typeof crypto.randomBytes): string {
  const keyPath = path.join(directory, "api-key");
  const existing = readPrivateRegularFile(keyPath)?.trim() ?? null;
  if (existing) {
    if (!/^[a-f0-9]{64}$/.test(existing)) {
      throw new Error("Managed llama.cpp API-key state is malformed.");
    }
    return existing;
  }
  const key = randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Could not generate a llama.cpp API key.");
  createPrivateFile(keyPath, `${key}\n`);
  return key;
}

async function digestFile(filePath: string): Promise<VerifiedLocalModelArtifact> {
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof nonBlock !== "number") {
    throw new Error("Secure file flags are unavailable for llama.cpp model verification.");
  }
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow | nonBlock);
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  try {
    const beforeDescriptor = await handle.stat({ bigint: true });
    const beforePath = fs.lstatSync(filePath, { bigint: true });
    if (
      !beforeDescriptor.isFile() ||
      !beforePath.isFile() ||
      beforeDescriptor.dev !== beforePath.dev ||
      beforeDescriptor.ino !== beforePath.ino ||
      (beforeDescriptor.mode & 0o077n) !== 0n ||
      (typeof process.getuid === "function" && beforeDescriptor.uid !== BigInt(process.getuid()))
    ) {
      throw new Error("The managed llama.cpp cached model is not an owner-only regular file.");
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      sizeBytes += bytesRead;
      if (!Number.isSafeInteger(sizeBytes)) {
        throw new Error("The managed llama.cpp cached model exceeds the supported size.");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const afterDescriptor = await handle.stat({ bigint: true });
    const afterPath = fs.lstatSync(filePath, { bigint: true });
    for (const status of [beforeDescriptor, afterPath]) {
      if (
        status.dev !== afterDescriptor.dev ||
        status.ino !== afterDescriptor.ino ||
        status.size !== afterDescriptor.size ||
        status.mtimeNs !== afterDescriptor.mtimeNs ||
        status.ctimeNs !== afterDescriptor.ctimeNs
      ) {
        throw new Error("The managed llama.cpp cached model changed during verification.");
      }
    }
    return {
      digest: `sha256:${hash.digest("hex")}`,
      filesystemIdentity: {
        ctimeNs: afterDescriptor.ctimeNs,
        dev: afterDescriptor.dev,
        ino: afterDescriptor.ino,
        mtimeNs: afterDescriptor.mtimeNs,
        size: afterDescriptor.size,
      },
      hostPath: fs.realpathSync(filePath),
      sizeBytes,
    };
  } finally {
    await handle.close();
  }
}

async function verifyCachedArtifact(
  plan: LlamaCppGgufCachePlan,
  owner: LlamaCppGgufCacheOwner,
  entryDir: string,
): Promise<VerifiedLocalModelArtifact | null> {
  const modelPath = path.join(entryDir, plan.acquisition.source.file.path);
  const receiptPath = path.join(entryDir, "receipt.json");
  const modelExists = fs.existsSync(modelPath);
  const receiptExists = fs.existsSync(receiptPath);
  if (!modelExists && !receiptExists) return null;
  if (!modelExists) throw new Error("The managed llama.cpp cache receipt has no model artifact.");

  const identity = await digestFile(modelPath);
  if (
    identity.sizeBytes !== plan.acquisition.source.file.sizeBytes ||
    identity.digest !== plan.acquisition.source.file.digest
  ) {
    throw new Error("The managed llama.cpp cached model failed size or digest verification.");
  }

  if (!receiptExists) {
    const receipt = createLlamaCppGgufCacheEntryReceipt(plan, owner);
    writeLocalAdapterJsonFile(receiptPath, receipt);
  } else {
    parseLlamaCppGgufCacheEntryReceipt(fs.readFileSync(receiptPath, "utf8"), plan, owner);
  }
  return identity;
}

function trustedHuggingFaceHost(hostname: string): boolean {
  return hostname === "huggingface.co" || hostname.endsWith(".huggingface.co");
}

async function fetchWithBoundedRedirects(
  initialUrl: string,
  token: string | null,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let current = new URL(initialUrl);
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (current.protocol !== "https:" || current.username || current.password)
      throw new Error("llama.cpp model acquisition requires HTTPS.");
    const headers: Record<string, string> = { "Accept-Encoding": "identity" };
    if (token && trustedHuggingFaceHost(current.hostname)) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(current, {
      headers,
      redirect: "manual",
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === MAX_REDIRECTS) {
      throw new Error("llama.cpp model download exceeded the redirect limit.");
    }
    await response.body?.cancel();
    current = new URL(location, current);
  }
  throw new Error("llama.cpp model download exceeded the redirect limit.");
}

async function acquireArtifact(
  plan: LlamaCppGgufCachePlan,
  owner: LlamaCppGgufCacheOwner,
  homeDir: string,
  fetchImpl: typeof fetch,
  randomBytes: typeof crypto.randomBytes,
): Promise<VerifiedLocalModelArtifact> {
  const entryDir = cacheEntryDir(homeDir, plan);
  ensurePrivateDirectory(entryDir);
  const cached = await verifyCachedArtifact(plan, owner, entryDir);
  if (cached) return cached;

  const storage = fs.statfsSync(entryDir);
  const availableBytes = BigInt(storage.bavail) * BigInt(storage.bsize);
  const requiredBytes =
    BigInt(plan.acquisition.source.file.sizeBytes) + BigInt(plan.cache.stagingHeadroomBytes);
  if (availableBytes < requiredBytes) {
    throw new Error(
      "Insufficient owner-cache storage for the llama.cpp model and staging headroom.",
    );
  }

  const destination = path.join(entryDir, plan.acquisition.source.file.path);
  const staging = path.join(entryDir, `.download-${randomBytes(12).toString("hex")}.partial`);
  const response = await fetchWithBoundedRedirects(
    plan.acquisition.url,
    String(process.env.HF_TOKEN ?? "").trim() || null,
    fetchImpl,
  );
  if (!response.ok || !response.body) {
    throw new Error(`llama.cpp model download returned HTTP ${String(response.status)}.`);
  }

  const handle = await fs.promises.open(staging, "wx", 0o600);
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  try {
    try {
      for await (const chunk of response.body) {
        const data = Buffer.from(chunk);
        sizeBytes += data.length;
        if (sizeBytes > plan.acquisition.source.file.sizeBytes) {
          throw new Error("llama.cpp model download exceeded the declared size.");
        }
        hash.update(data);
        await handle.write(data);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    const digest = `sha256:${hash.digest("hex")}`;
    if (
      sizeBytes !== plan.acquisition.source.file.sizeBytes ||
      digest !== plan.acquisition.source.file.digest
    ) {
      throw new Error("llama.cpp model download failed size or digest verification.");
    }
    try {
      fs.linkSync(staging, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
  const verified = await verifyCachedArtifact(plan, owner, entryDir);
  if (!verified) throw new Error("llama.cpp model cache publication did not complete.");
  return verified;
}

function launchContract(recipe: LlamaCppServingRecipe): LlamaCppHostLocalLaunchContract {
  return {
    model: {
      servedName: recipe.spec.model.servedName,
      file: recipe.spec.model.files[0]!,
    },
    policy: recipe.spec.policy,
    runtime: {
      gpu: recipe.spec.runtime.gpu,
      resources: recipe.spec.runtime.resources,
    },
    serve: {
      authentication: recipe.spec.serve.authentication,
      batchSize: recipe.spec.serve.batchSize,
      contextSize: recipe.spec.serve.contextSize,
      flashAttention: recipe.spec.serve.flashAttention,
      idleSleepSeconds: recipe.spec.serve.idleSleepSeconds,
      kvCache: recipe.spec.serve.kvCache,
      limits: {
        requestTimeoutSeconds: recipe.spec.serve.limits.requestTimeoutSeconds,
      },
      microBatchSize: recipe.spec.serve.microBatchSize,
      port: recipe.spec.serve.port,
      protocol: recipe.spec.serve.protocol,
      slots: recipe.spec.serve.slots,
      speculativeDecoding: recipe.spec.serve.speculativeDecoding,
    },
    surfaces: recipe.spec.surfaces,
  };
}

function ownedNetwork(
  name: string,
  generation: string,
  capture: typeof dockerCapture,
): { kind: "absent" } | { kind: "foreign" } | { kind: "owned"; id: string } {
  const source = capture(["network", "inspect", name], {
    ignoreError: true,
    timeout: 10_000,
  }).trim();
  if (!source) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Managed llama.cpp network inspection returned invalid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Managed llama.cpp network inspection was ambiguous.");
  }
  const row = parsed[0] as Record<string, unknown>;
  const labels = row.Labels;
  if (
    row.Name !== name ||
    typeof row.Id !== "string" ||
    !/^[a-f0-9]{12,64}$/.test(row.Id) ||
    row.Internal !== true ||
    row.Driver !== "bridge" ||
    row.Scope !== "local" ||
    !labels ||
    typeof labels !== "object" ||
    Array.isArray(labels) ||
    (labels as Record<string, unknown>)[MANAGED_LLAMA_CPP_OWNER_LABEL] !==
      MANAGED_LLAMA_CPP_OWNER_VALUE ||
    (labels as Record<string, unknown>)[MANAGED_LLAMA_CPP_GENERATION_LABEL] !== generation
  ) {
    return { kind: "foreign" };
  }
  return { kind: "owned", id: row.Id };
}

function ownedContainerId(
  name: string,
  generation: string,
  authFingerprint: string,
  capture: typeof dockerCapture,
): { kind: "absent" } | { kind: "foreign" } | { kind: "owned"; id: string } {
  const source = capture(["container", "inspect", name], {
    ignoreError: true,
    timeout: 10_000,
  }).trim();
  if (!source) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Managed llama.cpp container inspection returned invalid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Managed llama.cpp container inspection was ambiguous.");
  }
  const row = parsed[0] as {
    Id?: unknown;
    Name?: unknown;
    Config?: { Labels?: unknown };
  };
  const labels = row.Config?.Labels;
  if (
    row.Name !== `/${name}` ||
    typeof row.Id !== "string" ||
    !/^[a-f0-9]{12,64}$/.test(row.Id) ||
    !labels ||
    typeof labels !== "object" ||
    Array.isArray(labels) ||
    (labels as Record<string, unknown>)[MANAGED_LLAMA_CPP_OWNER_LABEL] !==
      MANAGED_LLAMA_CPP_OWNER_VALUE ||
    (labels as Record<string, unknown>)[MANAGED_LLAMA_CPP_GENERATION_LABEL] !== generation ||
    (labels as Record<string, unknown>)[MANAGED_LLAMA_CPP_AUTH_LABEL] !== authFingerprint
  ) {
    return { kind: "foreign" };
  }
  return { kind: "owned", id: row.Id };
}

/** Install and validate the disabled llama.cpp profile selected by the dedicated gate. */
export async function installManagedLlamaCpp(
  recipe: LlamaCppServingRecipe,
  options: ManagedLlamaCppInstallOptions = {},
): Promise<ManagedLlamaCppInstallResult> {
  const homeDir = options.homeDir ?? os.homedir();
  const randomBytes = options.randomBytes ?? crypto.randomBytes;
  const fetchImpl = options.fetchImpl ?? fetch;
  const capture = options.dockerCaptureImpl ?? dockerCapture;
  const run = options.dockerRunImpl ?? dockerRun;
  const forceRm = options.dockerForceRmImpl ?? dockerForceRm;
  const pull = options.dockerPullImpl ?? dockerPullWithProgressWatchdog;
  const probe = options.probeImpl ?? probeLlamaCppAttachment;
  const sleep = options.sleepImpl ?? delay;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(message));

  try {
    const plan = compileLlamaCppGgufCachePlan(recipe);
    const privateStateDir = stateDir(homeDir);
    ensurePrivateDirectory(privateStateDir);
    const privateCacheRoot = cacheRoot(homeDir);
    ensurePrivateDirectory(privateCacheRoot);
    const owner = ownerForCache(privateCacheRoot, randomBytes);
    bindOwnerToRuntimeState(privateStateDir, owner);
    const apiKey = apiKeyForState(privateStateDir, randomBytes);
    readPrivateRegularFile(path.join(privateStateDir, MANAGED_LLAMA_CPP_RUNTIME_RECEIPT_FILE));
    const authFingerprint = runtimeAuthFingerprint(apiKey);
    const containerState = ownedContainerId(
      MANAGED_LLAMA_CPP_CONTAINER_NAME,
      owner.generation,
      authFingerprint,
      capture,
    );
    if (containerState.kind === "foreign") {
      return {
        ok: false,
        reason: "the llama.cpp container name is owned by another runtime",
      };
    }
    const networkState = ownedNetwork(MANAGED_LLAMA_CPP_NETWORK_NAME, owner.generation, capture);
    if (networkState.kind === "foreign") {
      return {
        ok: false,
        reason: "the llama.cpp network name is owned by another runtime",
      };
    }
    log("  Staging the exact llama.cpp model artifact");
    const artifact = await acquireArtifact(plan, owner, homeDir, fetchImpl, randomBytes);

    const pullResult = await pull(recipe.spec.runtime.image, {
      maxTimeoutMs: 12 * 60 * 60 * 1000,
      logLine: (line) => log(`  ${line}`),
    });
    if (pullResult.status !== 0) {
      return {
        ok: false,
        reason: "the pinned llama.cpp image could not be pulled",
      };
    }

    if (containerState.kind === "owned") {
      const removal = forceRm(containerState.id, { suppressOutput: true });
      if (removal.status !== 0) {
        return {
          ok: false,
          reason: "the prior managed llama.cpp container could not be removed",
        };
      }
    }
    const createdNetwork = networkState.kind === "absent";
    if (createdNetwork) {
      const created = run([
        "network",
        "create",
        "--internal",
        "--label",
        `${MANAGED_LLAMA_CPP_OWNER_LABEL}=${MANAGED_LLAMA_CPP_OWNER_VALUE}`,
        "--label",
        `${MANAGED_LLAMA_CPP_GENERATION_LABEL}=${owner.generation}`,
        MANAGED_LLAMA_CPP_NETWORK_NAME,
      ]);
      if (created.status !== 0) return { ok: false, reason: "could not create llama.cpp network" };
    }

    const runtimeUid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const runtimeGid = typeof process.getgid === "function" ? process.getgid() : 1000;
    if (runtimeUid < 1 || runtimeGid < 1) {
      return {
        ok: false,
        reason: "managed llama.cpp must run as a non-root host identity",
      };
    }
    const argv = buildLlamaCppHostLocalDockerArgv(launchContract(recipe), {
      apiKeyHostPath: path.join(privateStateDir, "api-key"),
      containerName: MANAGED_LLAMA_CPP_CONTAINER_NAME,
      hostPort: LLAMA_CPP_PORT,
      imageReference: recipe.spec.runtime.image,
      model: artifact,
      network: {
        isolation: "docker-internal",
        name: MANAGED_LLAMA_CPP_NETWORK_NAME,
      },
      ownerLabel: {
        name: MANAGED_LLAMA_CPP_OWNER_LABEL,
        value: MANAGED_LLAMA_CPP_OWNER_VALUE,
      },
      identityLabels: [
        { name: MANAGED_LLAMA_CPP_GENERATION_LABEL, value: owner.generation },
        { name: MANAGED_LLAMA_CPP_AUTH_LABEL, value: authFingerprint },
      ],
      runtimeGid,
      runtimeUid,
    });
    const started = run(argv);
    if (started.status !== 0) return { ok: false, reason: "the llama.cpp container did not start" };

    const launchedContainer = ownedContainerId(
      MANAGED_LLAMA_CPP_CONTAINER_NAME,
      owner.generation,
      authFingerprint,
      capture,
    );
    const launchedNetwork = ownedNetwork(MANAGED_LLAMA_CPP_NETWORK_NAME, owner.generation, capture);
    if (launchedContainer.kind !== "owned" || launchedNetwork.kind !== "owned") {
      return {
        ok: false,
        reason: "the llama.cpp runtime identity could not be verified",
      };
    }
    try {
      persistRuntimeReceipt(privateStateDir, {
        owner,
        apiKeyFingerprint: authFingerprint,
        containerId: launchedContainer.id,
        networkId: launchedNetwork.id,
        recipe,
        artifact,
      });
    } catch (error) {
      forceRm(launchedContainer.id, {
        ignoreError: true,
        suppressOutput: true,
      });
      if (createdNetwork) {
        run(["network", "rm", launchedNetwork.id], {
          ignoreError: true,
          suppressOutput: true,
        });
      }
      return {
        ok: false,
        reason: `could not persist llama.cpp runtime receipt: ${(error as Error).message}`,
      };
    }

    const deadline = now() + recipe.spec.readiness.timeoutSeconds * 1000;
    while (now() <= deadline) {
      const attachment = probe(apiKey, {
        requestedModel: recipe.spec.readiness.expectedModel,
      });
      if (attachment.ok) {
        process.env[LLAMA_CPP_CREDENTIAL_ENV] = apiKey;
        return { ok: true, apiKey, model: attachment.model };
      }
      await sleep(2_000);
    }
    const removal = forceRm(launchedContainer.id, {
      ignoreError: true,
      suppressOutput: true,
    });
    if (removal.status === 0) {
      removeLocalAdapterFile(path.join(privateStateDir, MANAGED_LLAMA_CPP_RUNTIME_RECEIPT_FILE));
    }
    return {
      ok: false,
      reason: "llama.cpp did not satisfy readiness before the timeout",
    };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}
