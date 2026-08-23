// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  isManagedImagePlatform,
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
  type ManagedImagePlatform,
  type ManagedImagePublicationCohort,
  managedImagePlatformForNodeArchitecture,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "./contract";
import type { ManagedImageRegistryFetchSession } from "./registry-fetch";

const GHCR_ORIGIN = "https://ghcr.io";
const GHCR_TOKEN_PATH = "/token";
const GHCR_BLOB_ORIGIN = "https://pkg-containers.githubusercontent.com";
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_PATTERN = /^v[0-9]+(?:\.[0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const COHORT_PATTERN = /^ghrun-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/u;
const MAX_REGISTRY_JSON_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

type Fetch = typeof fetch;
type RegistryRedirect = "error" | "manual";

type OciDescriptor = {
  readonly digest?: unknown;
  readonly mediaType?: unknown;
  readonly platform?: {
    readonly architecture?: unknown;
    readonly os?: unknown;
  };
};

type OciIndex = {
  readonly mediaType?: unknown;
  readonly manifests?: unknown;
};

type OciManifest = {
  readonly mediaType?: unknown;
  readonly config?: OciDescriptor;
};

type OciImageConfig = {
  readonly architecture?: unknown;
  readonly os?: unknown;
  readonly config?: {
    readonly Labels?: unknown;
  };
};

export class ManagedImageCatalogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Managed image catalog resolution failed: ${message}`, options);
    this.name = "ManagedImageCatalogError";
  }
}

export class ManagedImageCatalogUnavailableError extends ManagedImageCatalogError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedImageCatalogUnavailableError";
  }
}

function invalid(message: string, options?: ErrorOptions): never {
  throw new ManagedImageCatalogError(message, options);
}

function unavailable(message: string, options?: ErrorOptions): never {
  throw new ManagedImageCatalogUnavailableError(message, options);
}

function isRegistryAvailabilityStatus(status: number): boolean {
  return status === 404 || status === 408 || status === 410 || status === 429 || status >= 500;
}

function registryHttpError(description: string, status: number): never {
  const message = `${description} request returned HTTP ${status}`;
  if (isRegistryAvailabilityStatus(status)) {
    return unavailable(message);
  }
  return invalid(message);
}

async function withRegistryFetch<T>(
  fetchImpl: Fetch | undefined,
  environment: NodeJS.ProcessEnv | undefined,
  operation: (resolvedFetch: Fetch) => Promise<T>,
): Promise<T> {
  if (fetchImpl !== undefined) return operation(fetchImpl);
  let session: ManagedImageRegistryFetchSession;
  try {
    const { createManagedImageRegistryFetchSession } = await import("./registry-fetch");
    session = createManagedImageRegistryFetchSession({ environment });
  } catch (error) {
    return invalid("registry transport could not be configured", { cause: error });
  }
  try {
    return await operation(session.fetchImpl);
  } finally {
    await session.close();
  }
}

function registryRepository(agent: ShippedManagedImageAgent): string {
  const prefix = "ghcr.io/";
  const repository = MANAGED_IMAGE_REPOSITORIES[agent];
  if (!repository.startsWith(prefix)) {
    return invalid(`repository for '${agent}' is not hosted on GHCR`);
  }
  return repository.slice(prefix.length);
}

function requireDigest(value: unknown, field: string): `sha256:${string}` {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    return invalid(`${field} is not a lowercase sha256 digest`);
  }
  return value as `sha256:${string}`;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

async function readBoundedBody(response: Response, field: string): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > MAX_REGISTRY_JSON_BYTES)
  ) {
    return invalid(`${field} exceeds the registry response limit`);
  }
  if (response.body === null) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REGISTRY_JSON_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-response error.
        }
        return invalid(`${field} exceeds the registry response limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function requireBodyDigest(body: Buffer, digest: `sha256:${string}`, field: string): void {
  const actual = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (actual !== digest) {
    invalid(`${field} bytes do not match digest ${digest}`);
  }
}

async function readBoundedJson(
  response: Response,
  field: string,
  expectedDigest?: `sha256:${string}`,
): Promise<unknown> {
  const body = await readBoundedBody(response, field);
  if (expectedDigest !== undefined) requireBodyDigest(body, expectedDigest, field);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch (error) {
    return invalid(`${field} is not JSON`, { cause: error });
  }
}

function bearerChallenge(response: Response, expectedScope: string): URL {
  const raw = response.headers.get("www-authenticate");
  if (!raw?.startsWith("Bearer ")) {
    return invalid("GHCR did not return a Bearer authentication challenge");
  }
  const parameters = new Map<string, string>();
  for (const match of raw.slice("Bearer ".length).matchAll(/([a-z]+)="([^"]*)"/gu)) {
    if (parameters.has(match[1])) return invalid("GHCR returned a duplicate challenge parameter");
    parameters.set(match[1], match[2]);
  }
  const realm = parameters.get("realm");
  const service = parameters.get("service");
  const scope = parameters.get("scope");
  let tokenUrl: URL;
  try {
    tokenUrl = new URL(realm ?? "");
  } catch (error) {
    return invalid("GHCR returned an invalid token realm", { cause: error });
  }
  if (
    tokenUrl.origin !== GHCR_ORIGIN ||
    tokenUrl.pathname !== GHCR_TOKEN_PATH ||
    tokenUrl.username ||
    tokenUrl.password ||
    tokenUrl.search ||
    tokenUrl.hash ||
    service !== "ghcr.io" ||
    scope !== expectedScope
  ) {
    return invalid("GHCR returned an unexpected authentication challenge");
  }
  tokenUrl.searchParams.set("service", service);
  tokenUrl.searchParams.set("scope", scope);
  return tokenUrl;
}

async function requestRegistry(
  fetchImpl: Fetch,
  url: URL,
  init: RequestInit,
  description: string,
  redirect: RegistryRedirect = "error",
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return unavailable(`${description} request failed`, { cause: error });
  }
  return response;
}

function redirectedBlobUrl(response: Response, digest: `sha256:${string}`): URL {
  if (response.status !== 307) {
    if (isRegistryAvailabilityStatus(response.status)) {
      return registryHttpError("GHCR image config", response.status);
    }
    return invalid(`GHCR image config request returned HTTP ${response.status}, expected 307`);
  }
  const location = response.headers.get("location");
  let target: URL;
  try {
    target = new URL(location ?? "");
  } catch (error) {
    return invalid("GHCR image config returned an invalid redirect target", { cause: error });
  }
  const pathSegments = target.pathname.split("/");
  if (
    target.origin !== GHCR_BLOB_ORIGIN ||
    target.username ||
    target.password ||
    target.hash ||
    pathSegments.length !== 4 ||
    !/^[A-Za-z0-9._-]+$/u.test(pathSegments[1] ?? "") ||
    pathSegments[2] !== "blobs" ||
    pathSegments[3] !== digest
  ) {
    return invalid("GHCR image config returned an unexpected redirect target");
  }
  return target;
}

async function getAnonymousToken(
  fetchImpl: Fetch,
  challengeResponse: Response,
  expectedScope: string,
): Promise<string> {
  const tokenUrl = bearerChallenge(challengeResponse, expectedScope);
  const response = await requestRegistry(fetchImpl, tokenUrl, { method: "GET" }, "GHCR token");
  if (!response.ok) return registryHttpError("GHCR token", response.status);
  const document = requireObject(await readBoundedJson(response, "GHCR token response"), "token");
  const token = document.token;
  if (typeof token !== "string" || token.length < 16 || token.length > 16_384) {
    return invalid("GHCR token response did not contain a bounded token");
  }
  return token;
}

async function getManifest(
  fetchImpl: Fetch,
  repository: string,
  reference: string,
  token?: string,
): Promise<{
  readonly digest: `sha256:${string}`;
  readonly document: unknown;
  readonly token: string;
}> {
  const manifestUrl = new URL(`/v2/${repository}/manifests/${reference}`, GHCR_ORIGIN);
  const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response = await requestRegistry(
    fetchImpl,
    manifestUrl,
    { headers, method: "GET" },
    "GHCR manifest",
  );
  let resolvedToken = token;
  if (response.status === 401 && !resolvedToken) {
    const scope = `repository:${repository}:pull`;
    resolvedToken = await getAnonymousToken(fetchImpl, response, scope);
    response = await requestRegistry(
      fetchImpl,
      manifestUrl,
      {
        headers: { ...headers, Authorization: `Bearer ${resolvedToken}` },
        method: "GET",
      },
      "authenticated GHCR manifest",
    );
  }
  if (!resolvedToken) return invalid("GHCR manifest did not establish anonymous pull identity");
  if (!response.ok) return registryHttpError("GHCR manifest", response.status);
  const digest = requireDigest(response.headers.get("docker-content-digest"), "manifest digest");
  if (DIGEST_PATTERN.test(reference) && digest !== reference) {
    return invalid("GHCR returned a manifest digest different from the requested digest");
  }
  return {
    digest,
    document: await readBoundedJson(response, "GHCR manifest", digest),
    token: resolvedToken,
  };
}

function platformArchitecture(platform: ManagedImagePlatform): string {
  return platform.slice("linux/".length);
}

function resolveCatalogPlatform(options: {
  readonly platform?: ManagedImagePlatform;
  readonly nodeArchitecture?: string;
}): ManagedImagePlatform {
  if (options.platform !== undefined) {
    if (!isManagedImagePlatform(options.platform)) {
      return invalid(`'${String(options.platform)}' is not a supported managed-image platform`);
    }
    return options.platform;
  }
  const nodeArchitecture = options.nodeArchitecture ?? process.arch;
  const platform = managedImagePlatformForNodeArchitecture(nodeArchitecture);
  if (platform === null) {
    return invalid(`host architecture '${nodeArchitecture}' has no managed-image platform`);
  }
  return platform;
}

function selectImageManifest(
  document: unknown,
  platform: ManagedImagePlatform,
): `sha256:${string}` | null {
  const root = requireObject(document, "manifest") as OciIndex;
  if (typeof root.mediaType !== "string") return invalid("manifest mediaType is missing");
  if (MANIFEST_MEDIA_TYPES.has(root.mediaType)) return null;
  if (!INDEX_MEDIA_TYPES.has(root.mediaType) || !Array.isArray(root.manifests)) {
    return invalid(`unsupported manifest mediaType '${root.mediaType}'`);
  }
  const architecture = platformArchitecture(platform);
  const candidates = (root.manifests as OciDescriptor[]).filter(
    (descriptor) =>
      descriptor.platform?.os === "linux" && descriptor.platform.architecture === architecture,
  );
  if (candidates.length !== 1) {
    return invalid(`manifest index contains ${candidates.length} ${platform} image manifests`);
  }
  return requireDigest(candidates[0]?.digest, `${platform} manifest digest`);
}

function configDigest(document: unknown): `sha256:${string}` {
  const manifest = requireObject(document, "image manifest") as OciManifest;
  if (typeof manifest.mediaType !== "string" || !MANIFEST_MEDIA_TYPES.has(manifest.mediaType)) {
    return invalid("selected platform descriptor is not an OCI/Docker image manifest");
  }
  return requireDigest(manifest.config?.digest, "image config digest");
}

async function getImageConfig(
  fetchImpl: Fetch,
  repository: string,
  digest: `sha256:${string}`,
  token: string,
): Promise<OciImageConfig> {
  const url = new URL(`/v2/${repository}/blobs/${digest}`, GHCR_ORIGIN);
  const redirectResponse = await requestRegistry(
    fetchImpl,
    url,
    { headers: { Authorization: `Bearer ${token}` }, method: "GET" },
    "GHCR image config",
    "manual",
  );
  const target = redirectedBlobUrl(redirectResponse, digest);
  const response = await requestRegistry(
    fetchImpl,
    target,
    { method: "GET" },
    "GHCR redirected image config",
    "manual",
  );
  if (response.status >= 300 && response.status < 400) {
    return invalid("GHCR image config redirect target attempted another redirect");
  }
  if (!response.ok) return registryHttpError("GHCR redirected image config", response.status);
  return requireObject(
    await readBoundedJson(response, "GHCR image config", digest),
    "image config",
  );
}

function validateImageLabels(
  agent: ShippedManagedImageAgent,
  imageConfig: OciImageConfig,
  platform: ManagedImagePlatform,
  expectedRelease?: string,
): {
  readonly cohort: ManagedImagePublicationCohort;
  readonly revision: string;
} {
  if (imageConfig.os !== "linux" || imageConfig.architecture !== platformArchitecture(platform)) {
    return invalid(`'${agent}' image config is not ${platform}`);
  }
  const labels = requireObject(imageConfig.config?.Labels, "image labels");
  const expected: Readonly<Record<string, string>> = {
    "io.nvidia.nemoclaw.agent": agent,
    "io.nvidia.nemoclaw.managed-image.contract": String(MANAGED_IMAGE_CONTRACT_VERSION),
    "io.nvidia.nemoclaw.managed-image.platform": platform,
    "io.nvidia.nemoclaw.managed-image.startup-profile": String(
      MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    ),
    "io.nvidia.nemoclaw.managed-image.capabilities": String(
      MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    ),
    "org.opencontainers.image.source": `https://github.com/${MANAGED_IMAGE_SOURCE_REPOSITORY}`,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (labels[key] !== value) return invalid(`'${agent}' image label ${key} does not match`);
  }
  const revision = labels["org.opencontainers.image.revision"];
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) {
    return invalid(`'${agent}' image source revision is not a full lowercase SHA`);
  }
  const cohort = labels["io.nvidia.nemoclaw.managed-image.cohort"];
  if (typeof cohort !== "string" || !COHORT_PATTERN.test(cohort)) {
    return invalid(`'${agent}' image publication cohort is not a supported identity`);
  }
  if (
    expectedRelease !== undefined &&
    labels["org.opencontainers.image.version"] !== expectedRelease
  ) {
    return invalid(`'${agent}' image release does not match the expected release`);
  }
  return {
    cohort: cohort as ManagedImagePublicationCohort,
    revision,
  };
}

export function normalizeManagedImageRelease(version: string): string {
  const release = version.startsWith("v") ? version : `v${version}`;
  if (!RELEASE_PATTERN.test(release)) {
    return invalid(`'${version}' is not a supported release version`);
  }
  return release;
}

async function resolveManagedImageContractAtReferenceFromGhcr(options: {
  readonly agent: ShippedManagedImageAgent;
  readonly reference: string;
  readonly release: string;
  readonly fetchImpl: Fetch;
  readonly expectedCohort?: ManagedImagePublicationCohort;
  readonly expectedRelease?: string;
  readonly expectedRevision?: string;
  readonly platform: ManagedImagePlatform;
}): Promise<ManagedImageContractV1> {
  const { agent, reference } = options;
  const release = normalizeManagedImageRelease(options.release);
  const fetchImpl = options.fetchImpl;
  const repository = registryRepository(agent);
  const root = await getManifest(fetchImpl, repository, reference);
  const platformDigest = selectImageManifest(root.document, options.platform);
  const workloadDigest = platformDigest ?? root.digest;
  const imageManifest =
    platformDigest === null
      ? root.document
      : (await getManifest(fetchImpl, repository, platformDigest, root.token)).document;
  const imageConfig = await getImageConfig(
    fetchImpl,
    repository,
    configDigest(imageManifest),
    root.token,
  );
  const identity = validateImageLabels(
    agent,
    imageConfig,
    options.platform,
    options.expectedRelease,
  );
  if (options.expectedCohort !== undefined && identity.cohort !== options.expectedCohort) {
    return invalid(`'${agent}' image publication cohort does not match the OpenClaw cohort`);
  }
  if (options.expectedRevision !== undefined && identity.revision !== options.expectedRevision) {
    return invalid(`'${agent}' image source revision does not match the expected revision`);
  }
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: options.platform,
    image,
    digest: workloadDigest,
    reference: `${image}@${workloadDigest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: identity.revision,
      release,
      cohort: identity.cohort,
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

/**
 * Resolve the single public release pointer.
 *
 * Only OpenClaw carries the consumer-facing release alias. The complete
 * catalog must be resolved through {@link resolveManagedImageCatalogFromGhcr}
 * so the other shipped agents are bound to OpenClaw's immutable cohort.
 */
export async function resolveManagedImageContractFromGhcr(options: {
  readonly agent: ShippedManagedImageAgent;
  readonly release: string;
  readonly platform?: ManagedImagePlatform;
  readonly nodeArchitecture?: string;
  readonly fetchImpl?: Fetch;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<ManagedImageContractV1> {
  if (options.agent !== "openclaw") {
    return invalid("release aliases may only be resolved from the OpenClaw cohort pointer");
  }
  const release = normalizeManagedImageRelease(options.release);
  const platform = resolveCatalogPlatform(options);
  return withRegistryFetch(options.fetchImpl, options.environment, (fetchImpl) =>
    resolveManagedImageContractAtReferenceFromGhcr({
      agent: options.agent,
      reference: release,
      release,
      platform,
      fetchImpl,
    }),
  );
}

export async function resolveManagedImageCatalogFromGhcr(options: {
  readonly release: string;
  /** Immutable source revision selected by a live qualification run. */
  readonly revision?: string;
  readonly platform?: ManagedImagePlatform;
  readonly nodeArchitecture?: string;
  readonly fetchImpl?: Fetch;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<ManagedImageContractCatalog> {
  const release = normalizeManagedImageRelease(options.release);
  const revision = options.revision;
  if (revision !== undefined && !REVISION_PATTERN.test(revision)) {
    return invalid(`managed image revision '${revision}' is not a full lowercase SHA`);
  }
  const platform = resolveCatalogPlatform(options);
  return withRegistryFetch(options.fetchImpl, options.environment, async (fetchImpl) => {
    const openclaw = await resolveManagedImageContractAtReferenceFromGhcr({
      agent: "openclaw",
      reference: revision ?? release,
      release,
      platform,
      fetchImpl,
      ...(revision === undefined ? {} : { expectedRevision: revision }),
      ...(revision === undefined ? {} : { expectedRelease: release }),
    });
    const cohortReference = `cohort-${openclaw.source.cohort}`;
    const dependentResults = await Promise.allSettled(
      SHIPPED_MANAGED_IMAGE_AGENTS.filter((agent) => agent !== "openclaw").map(
        async (agent) =>
          [
            agent,
            await resolveManagedImageContractAtReferenceFromGhcr({
              agent,
              reference: cohortReference,
              release,
              platform,
              fetchImpl,
              expectedCohort: openclaw.source.cohort,
              ...(revision === undefined ? {} : { expectedRelease: release }),
              expectedRevision: openclaw.source.revision,
            }),
          ] as const,
      ),
    );
    const dependentEntries: Array<readonly [ShippedManagedImageAgent, ManagedImageContractV1]> = [];
    let unavailable: ManagedImageCatalogUnavailableError | undefined;
    for (const result of dependentResults) {
      if (result.status === "fulfilled") {
        dependentEntries.push(result.value);
      } else if (!(result.reason instanceof ManagedImageCatalogUnavailableError)) {
        throw result.reason;
      } else if (unavailable === undefined) {
        unavailable = result.reason;
      }
    }
    if (unavailable !== undefined) throw unavailable;
    return Object.fromEntries([["openclaw", openclaw], ...dependentEntries]);
  });
}
