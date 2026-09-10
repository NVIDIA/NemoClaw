// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OPENSHELL_API_ROOT = "https://api.github.com/repos/NVIDIA/OpenShell";
const DEV_RELEASE_URL = `${OPENSHELL_API_ROOT}/releases/tags/dev`;
const ASSET_API_PREFIX = `${OPENSHELL_API_ROOT}/releases/assets/`;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export const OPENSHELL_DEV_ASSET_NAMES = [
  "openshell-x86_64-unknown-linux-musl.tar.gz",
  "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
  "openshell-sandbox-x86_64-unknown-linux-musl.tar.gz",
  "openshell-checksums-sha256.txt",
  "openshell-gateway-checksums-sha256.txt",
  "openshell-sandbox-checksums-sha256.txt",
] as const;

type JsonRecord = Record<string, unknown>;
type Fetch = typeof fetch;

type ReleaseAsset = {
  id: number;
  name: string;
  size: number;
  digest: string;
  apiUrl: string;
  browserDownloadUrl: string;
};

type ReleaseSnapshot = {
  id: number;
  tag: "dev";
  apiUrl: string;
  htmlUrl: string;
  sourceCommit: string;
  updatedAt: string;
  assets: ReleaseAsset[];
};

export type OpenShellDevArtifactManifest = {
  schemaVersion: 1;
  release: Omit<ReleaseSnapshot, "assets">;
  assets: ReleaseAsset[];
};

export type OpenShellDevArtifactResolution = {
  schemaVersion: 1;
  classification: "resolved" | "infrastructure-failure";
  identifier: string;
  sourceUrl: string;
  message: string;
  artifactName?: string;
  manifestSha256?: string;
  sourceCommit?: string;
};

export class OpenShellDevArtifactInfrastructureError extends Error {
  readonly identifier: string;
  readonly sourceUrl: string;

  constructor(message: string, identifier: string, sourceUrl: string) {
    super(message);
    this.name = "OpenShellDevArtifactInfrastructureError";
    this.identifier = identifier;
    this.sourceUrl = sourceUrl;
  }
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value as JsonRecord;
}

function stringField(value: JsonRecord, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`expected non-empty string field ${key}`);
  }
  return field;
}

function integerField(value: JsonRecord, key: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) <= 0) {
    throw new Error(`expected positive integer field ${key}`);
  }
  return field as number;
}

function infrastructureError(error: unknown, identifier: string, sourceUrl: string) {
  if (error instanceof OpenShellDevArtifactInfrastructureError) return error;
  return new OpenShellDevArtifactInfrastructureError(
    error instanceof Error ? error.message : String(error),
    identifier,
    sourceUrl,
  );
}

async function fetchJson(fetchFn: Fetch, url: string, identifier: string): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
    });
  } catch (error) {
    throw infrastructureError(error, identifier, url);
  }
  if (!response.ok) {
    throw new OpenShellDevArtifactInfrastructureError(
      `GitHub returned HTTP ${response.status}`,
      identifier,
      url,
    );
  }
  try {
    return record(await response.json());
  } catch (error) {
    throw infrastructureError(error, identifier, url);
  }
}

function parseAsset(value: unknown): ReleaseAsset {
  const asset = record(value);
  const id = integerField(asset, "id");
  const name = stringField(asset, "name");
  const size = integerField(asset, "size");
  const digestValue = stringField(asset, "digest");
  const [algorithm, digest] = digestValue.split(":", 2);
  const apiUrl = stringField(asset, "url");
  const browserDownloadUrl = stringField(asset, "browser_download_url");
  if (algorithm !== "sha256" || !SHA256_PATTERN.test(digest ?? "")) {
    throw new OpenShellDevArtifactInfrastructureError(
      `OpenShell release asset ${name} has no valid SHA-256 digest`,
      `asset:${name}:id:${id}`,
      apiUrl,
    );
  }
  if (apiUrl !== `${ASSET_API_PREFIX}${id}`) {
    throw new OpenShellDevArtifactInfrastructureError(
      `OpenShell release asset ${name} has an unexpected API URL`,
      `asset:${name}:id:${id}`,
      apiUrl,
    );
  }
  if (size > MAX_ASSET_BYTES) {
    throw new OpenShellDevArtifactInfrastructureError(
      `OpenShell release asset ${name} exceeds the ${MAX_ASSET_BYTES}-byte limit`,
      `asset:${name}:id:${id}`,
      apiUrl,
    );
  }
  return { id, name, size, digest, apiUrl, browserDownloadUrl };
}

async function readReleaseSnapshot(fetchFn: Fetch): Promise<ReleaseSnapshot> {
  const release = await fetchJson(fetchFn, DEV_RELEASE_URL, "release:dev");
  const id = integerField(release, "id");
  const tag = stringField(release, "tag_name");
  if (tag !== "dev") {
    throw new OpenShellDevArtifactInfrastructureError(
      `OpenShell release lookup returned unexpected tag ${tag}`,
      `release:${id}`,
      DEV_RELEASE_URL,
    );
  }
  const apiUrl = stringField(release, "url");
  const htmlUrl = stringField(release, "html_url");
  const updatedAt = stringField(release, "updated_at");
  const sourceCommit = stringField(release, "target_commitish");
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new OpenShellDevArtifactInfrastructureError(
      "OpenShell dev release target is not an immutable commit",
      `release:${id}:tag:dev`,
      DEV_RELEASE_URL,
    );
  }
  if (
    apiUrl !== `${OPENSHELL_API_ROOT}/releases/${id}` ||
    htmlUrl !== "https://github.com/NVIDIA/OpenShell/releases/tag/dev"
  ) {
    throw new OpenShellDevArtifactInfrastructureError(
      "OpenShell dev release returned an unexpected source URL",
      `release:${id}:tag:dev`,
      apiUrl,
    );
  }
  if (!Array.isArray(release.assets)) {
    throw new OpenShellDevArtifactInfrastructureError(
      "OpenShell dev release has no asset list",
      `release:${id}:tag:dev`,
      DEV_RELEASE_URL,
    );
  }
  const parsedAssets = release.assets.map(parseAsset);
  const assetsByName = new Map(parsedAssets.map((asset) => [asset.name, asset] as const));
  if (assetsByName.size !== parsedAssets.length) {
    throw new OpenShellDevArtifactInfrastructureError(
      "OpenShell dev release contains duplicate asset names",
      `release:${id}:tag:dev`,
      DEV_RELEASE_URL,
    );
  }
  const assets = OPENSHELL_DEV_ASSET_NAMES.map((name) => {
    const asset = assetsByName.get(name);
    if (!asset) {
      throw new OpenShellDevArtifactInfrastructureError(
        `OpenShell dev release is missing required asset ${name}`,
        `release:${id}:asset:${name}`,
        DEV_RELEASE_URL,
      );
    }
    return asset;
  });
  return { id, tag: "dev", apiUrl, htmlUrl, sourceCommit, updatedAt, assets };
}

function snapshotIdentity(snapshot: ReleaseSnapshot): string {
  return JSON.stringify({
    id: snapshot.id,
    sourceCommit: snapshot.sourceCommit,
    updatedAt: snapshot.updatedAt,
    assets: snapshot.assets.map(({ id, name, size, digest, apiUrl }) => ({
      id,
      name,
      size,
      digest,
      apiUrl,
    })),
  });
}

async function downloadAsset(fetchFn: Fetch, asset: ReleaseAsset): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchFn(asset.apiUrl, {
      headers: {
        Accept: "application/octet-stream",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("GitHub asset response omitted its redirect URL");
      const redirectUrl = new URL(location);
      if (
        redirectUrl.protocol !== "https:" ||
        redirectUrl.hostname !== "release-assets.githubusercontent.com"
      ) {
        throw new Error(
          `GitHub asset response redirected to unexpected host ${redirectUrl.hostname}`,
        );
      }
      response = await fetchFn(redirectUrl, { redirect: "error" });
    }
  } catch (error) {
    throw infrastructureError(error, `asset:${asset.name}:id:${asset.id}`, asset.apiUrl);
  }
  if (!response.ok) {
    throw new OpenShellDevArtifactInfrastructureError(
      `GitHub returned HTTP ${response.status} for OpenShell release asset ${asset.name}`,
      `asset:${asset.name}:id:${asset.id}`,
      asset.apiUrl,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw infrastructureError(error, `asset:${asset.name}:id:${asset.id}`, asset.apiUrl);
  }
  if (bytes.byteLength !== asset.size) {
    throw new OpenShellDevArtifactInfrastructureError(
      `OpenShell release asset ${asset.name} size mismatch: expected ${asset.size}, received ${bytes.byteLength}`,
      `asset:${asset.name}:id:${asset.id}`,
      asset.apiUrl,
    );
  }
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== asset.digest) {
    throw new OpenShellDevArtifactInfrastructureError(
      `OpenShell release asset ${asset.name} SHA-256 mismatch`,
      `asset:${asset.name}:id:${asset.id}`,
      asset.apiUrl,
    );
  }
  return bytes;
}

function writeJson(filePath: string, value: unknown, flag: "w" | "wx" = "wx"): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag, mode: 0o600 });
}

function prepareOutputDirectory(outputDirectory: string): void {
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(outputDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("OpenShell dev artifact output path must be a regular directory");
  }
  if (fs.readdirSync(outputDirectory).length !== 0) {
    throw new Error("OpenShell dev artifact output directory must be empty");
  }
}

export async function resolveOpenShellDevArtifact(
  outputDirectory: string,
  fetchFn: Fetch = fetch,
): Promise<OpenShellDevArtifactResolution> {
  prepareOutputDirectory(outputDirectory);
  const assetsDirectory = path.join(outputDirectory, "assets");
  fs.mkdirSync(assetsDirectory, { mode: 0o700 });
  try {
    const initial = await readReleaseSnapshot(fetchFn);
    for (const asset of initial.assets) {
      const bytes = await downloadAsset(fetchFn, asset);
      fs.writeFileSync(path.join(assetsDirectory, asset.name), bytes, { flag: "wx", mode: 0o600 });
    }
    const final = await readReleaseSnapshot(fetchFn);
    if (snapshotIdentity(initial) !== snapshotIdentity(final)) {
      throw new OpenShellDevArtifactInfrastructureError(
        "OpenShell dev release changed while its assets were being resolved",
        `release:${initial.id}:tag:dev:source:${initial.sourceCommit}`,
        DEV_RELEASE_URL,
      );
    }
    const manifest: OpenShellDevArtifactManifest = {
      schemaVersion: 1,
      release: {
        id: initial.id,
        tag: initial.tag,
        apiUrl: initial.apiUrl,
        htmlUrl: initial.htmlUrl,
        sourceCommit: initial.sourceCommit,
        updatedAt: initial.updatedAt,
      },
      assets: initial.assets,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
    const artifactName = `openshell-dev-${initial.sourceCommit}-${manifestSha256}`;
    fs.writeFileSync(path.join(outputDirectory, "manifest.json"), manifestText, {
      flag: "wx",
      mode: 0o600,
    });
    const resolution: OpenShellDevArtifactResolution = {
      schemaVersion: 1,
      classification: "resolved",
      identifier: `release:${initial.id}:tag:dev:source:${initial.sourceCommit}`,
      sourceUrl: DEV_RELEASE_URL,
      message: "OpenShell dev assets resolved and verified",
      artifactName,
      manifestSha256,
      sourceCommit: initial.sourceCommit,
    };
    writeJson(path.join(outputDirectory, "resolution.json"), resolution);
    return resolution;
  } catch (error) {
    fs.rmSync(assetsDirectory, { recursive: true, force: true });
    fs.rmSync(path.join(outputDirectory, "manifest.json"), { force: true });
    const classified = infrastructureError(error, "release:dev", DEV_RELEASE_URL);
    const resolution: OpenShellDevArtifactResolution = {
      schemaVersion: 1,
      classification: "infrastructure-failure",
      identifier: classified.identifier,
      sourceUrl: classified.sourceUrl,
      message: classified.message,
    };
    try {
      writeJson(path.join(outputDirectory, "resolution.json"), resolution, "w");
    } catch (writeError) {
      console.error(
        `Unable to retain OpenShell dev infrastructure-failure evidence: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
      );
    }
    throw classified;
  }
}

function parseManifest(manifestBytes: Buffer): OpenShellDevArtifactManifest {
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.schemaVersion !== 1) throw new Error("unsupported OpenShell dev manifest schema");
  const release = record(manifest.release);
  const assets = manifest.assets;
  if (!Array.isArray(assets)) throw new Error("OpenShell dev manifest has no asset list");
  return {
    schemaVersion: 1,
    release: {
      id: integerField(release, "id"),
      tag: stringField(release, "tag") as "dev",
      apiUrl: stringField(release, "apiUrl"),
      htmlUrl: stringField(release, "htmlUrl"),
      sourceCommit: stringField(release, "sourceCommit"),
      updatedAt: stringField(release, "updatedAt"),
    },
    assets: assets.map(parseManifestAsset),
  };
}

function parseManifestAsset(value: unknown): ReleaseAsset {
  const asset = record(value);
  const parsed = {
    id: integerField(asset, "id"),
    name: stringField(asset, "name"),
    size: integerField(asset, "size"),
    digest: stringField(asset, "digest"),
    apiUrl: stringField(asset, "apiUrl"),
    browserDownloadUrl: stringField(asset, "browserDownloadUrl"),
  };
  if (!SHA256_PATTERN.test(parsed.digest)) throw new Error(`invalid digest for ${parsed.name}`);
  if (parsed.size > MAX_ASSET_BYTES) throw new Error(`asset ${parsed.name} exceeds the size limit`);
  if (parsed.apiUrl !== `${ASSET_API_PREFIX}${parsed.id}`) {
    throw new Error(`unexpected asset API URL for ${parsed.name}`);
  }
  return parsed;
}

function readRegularFileNoFollow(filePath: string, label: string): { bytes: Buffer; size: number } {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    return { bytes: fs.readFileSync(descriptor), size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`${label} must be a regular file`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function verifyOpenShellDevArtifact(
  outputDirectory: string,
  expectedSourceCommit: string,
  expectedManifestSha256: string,
): OpenShellDevArtifactManifest {
  if (!COMMIT_PATTERN.test(expectedSourceCommit) || !SHA256_PATTERN.test(expectedManifestSha256)) {
    throw new Error("expected source commit and manifest SHA-256 must be lowercase hexadecimal");
  }
  const manifestPath = path.join(outputDirectory, "manifest.json");
  const { bytes: manifestBytes } = readRegularFileNoFollow(manifestPath, "OpenShell dev manifest");
  const actualManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (actualManifestSha256 !== expectedManifestSha256) {
    throw new Error("OpenShell dev manifest SHA-256 mismatch");
  }
  const manifest = parseManifest(manifestBytes);
  if (manifest.release.tag !== "dev" || manifest.release.sourceCommit !== expectedSourceCommit) {
    throw new Error("OpenShell dev manifest source identity mismatch");
  }
  if (manifest.assets.map(({ name }) => name).join("\n") !== OPENSHELL_DEV_ASSET_NAMES.join("\n")) {
    throw new Error("OpenShell dev manifest asset set or order mismatch");
  }
  const assetsDirectory = path.join(outputDirectory, "assets");
  const actualNames = fs.readdirSync(assetsDirectory).sort();
  const expectedNames = [...OPENSHELL_DEV_ASSET_NAMES].sort();
  if (actualNames.join("\n") !== expectedNames.join("\n")) {
    throw new Error("OpenShell dev artifact directory contains an unexpected asset set");
  }
  for (const asset of manifest.assets) {
    const assetPath = path.join(assetsDirectory, asset.name);
    const { bytes, size } = readRegularFileNoFollow(assetPath, `OpenShell dev asset ${asset.name}`);
    if (size !== asset.size) throw new Error(`OpenShell dev asset ${asset.name} size mismatch`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.digest)
      throw new Error(`OpenShell dev asset ${asset.name} SHA-256 mismatch`);
  }
  return manifest;
}

function appendGithubOutput(values: Record<string, string>): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
  fs.appendFileSync(
    outputPath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8",
  );
}

async function main(): Promise<void> {
  const [command, outputDirectory, argument3, argument4] = process.argv.slice(2);
  if (!outputDirectory || !path.isAbsolute(outputDirectory)) {
    throw new Error("an absolute OpenShell dev artifact directory is required");
  }
  if (command === "resolve") {
    try {
      const resolution = await resolveOpenShellDevArtifact(outputDirectory);
      if (!resolution.artifactName || !resolution.sourceCommit || !resolution.manifestSha256) {
        throw new Error("successful OpenShell dev resolution omitted its immutable identity");
      }
      appendGithubOutput({
        artifact_name: resolution.artifactName,
        source_commit: resolution.sourceCommit,
        manifest_sha256: resolution.manifestSha256,
      });
      console.log(`Resolved ${resolution.identifier} from ${resolution.sourceUrl}`);
    } catch (error) {
      const classified = infrastructureError(error, "release:dev", DEV_RELEASE_URL);
      const suffix = `${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
      appendGithubOutput({ artifact_name: `openshell-dev-infrastructure-failure-${suffix}` });
      console.error(
        `::error title=OpenShell dev artifact infrastructure failure::identifier=${classified.identifier}; source=${classified.sourceUrl}; ${classified.message}`,
      );
      throw classified;
    }
    return;
  }
  if (command === "verify" && argument3 && argument4) {
    verifyOpenShellDevArtifact(outputDirectory, argument3, argument4);
    console.log(`Verified OpenShell dev artifact source ${argument3}`);
    return;
  }
  throw new Error(
    "usage: openshell-dev-artifact.mts resolve <artifact-directory> | verify <artifact-directory> <source-commit> <manifest-sha256>",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
