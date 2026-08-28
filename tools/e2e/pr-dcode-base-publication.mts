// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  MANAGED_IMAGE_REPOSITORIES,
  parseManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
} from "../../src/lib/onboard/managed-image/contract.ts";
import {
  githubRequest,
  type PublicationRun,
  waitForBaseImagePublication,
  writePublicationRunOutputs,
} from "./base-image-publication.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const AGENT = "langchain-deepagents-code";
const BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";
const BASE_RESOLUTION_KEY_LABEL = "com.nvidia.nemoclaw.base-resolution-key";
const BASE_RESOLUTION_LABEL = "com.nvidia.nemoclaw.base-resolution";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const KEY_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const MAX_CATALOG_BYTES = 64 * 1024;
const MAX_RESOLUTION_BYTES = 8 * 1024;
const DOCKER_ENV_NAMES = new Set([
  "DOCKER_HOST",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);
const DOCKER_ENV_PREFIXES = ["LC_", "XDG_"] as const;

type JsonRecord = Record<string, unknown>;

export interface DcodeBaseResolution {
  readonly reference: string;
  readonly sourceRevision: string;
}

export interface PrDcodeBasePublication {
  readonly baseReference: string;
  readonly run: PublicationRun;
}

export interface PrDcodeBasePublicationDependencies {
  readonly inspectManagedImage?: (reference: string) => unknown;
  readonly resolvePublication?: (sourceRevision: string) => Promise<PublicationRun>;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function parseCatalog(raw: string, candidateSha: string): ManagedImageContractV1 {
  if (!SHA_PATTERN.test(candidateSha)) throw new Error("candidate SHA is invalid");
  if (!raw || Buffer.byteLength(raw) > MAX_CATALOG_BYTES) {
    throw new Error("exact PR managed-image catalog is missing or oversized");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("exact PR managed-image catalog is invalid JSON");
  }
  const catalog = record(parsed, "exact PR managed-image catalog");
  exactKeys(catalog, SHIPPED_MANAGED_IMAGE_AGENTS, "exact PR managed-image catalog");
  const contracts = SHIPPED_MANAGED_IMAGE_AGENTS.map((agent) =>
    parseManagedImageContractV1(catalog[agent], agent, "linux/amd64"),
  );
  if (
    new Set(contracts.map((contract) => contract.source.revision)).size !== 1 ||
    contracts[0]?.source.revision !== candidateSha
  ) {
    throw new Error("exact PR managed-image contracts do not match the candidate commit");
  }
  if (
    new Set(contracts.map((contract) => contract.source.release)).size !== 1 ||
    new Set(contracts.map((contract) => contract.source.cohort)).size !== 1
  ) {
    throw new Error("exact PR managed-image contracts do not form one publication cohort");
  }
  const assembled = Object.fromEntries(
    contracts.map((contract) => [contract.agent, contract]),
  ) as ManagedImageContractCatalog;
  return parseManagedImageContractV1(assembled[AGENT], AGENT, "linux/amd64");
}

/** Limit controller data exposed to the Docker image inspection subprocess. */
export function buildDockerInspectionEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined &&
        (DOCKER_ENV_NAMES.has(name) ||
          DOCKER_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))),
    ),
  );
}

function defaultInspectManagedImage(reference: string): unknown {
  const env = buildDockerInspectionEnvironment(process.env);
  execFileSync("docker", ["pull", "--platform", "linux/amd64", reference], {
    encoding: "utf8",
    env,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 600_000,
  });
  return JSON.parse(
    execFileSync("docker", ["image", "inspect", reference], {
      encoding: "utf8",
      env,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }),
  ) as unknown;
}

function parseResolutionLabel(raw: string): JsonRecord {
  if (
    !BASE64URL_PATTERN.test(raw) ||
    raw.length > MAX_RESOLUTION_BYTES ||
    Buffer.from(raw, "base64url").toString("base64url") !== raw
  ) {
    throw new Error("Deep Agents Code managed image base resolution label is invalid");
  }
  try {
    return record(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown,
      "Deep Agents Code managed image base resolution",
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("must be a JSON object")) throw error;
    throw new Error("Deep Agents Code managed image base resolution label is invalid JSON");
  }
}

/** Bind the exact PR managed image to the base reference recorded by its trusted producer. */
export function readDcodeBaseResolution(
  inspection: unknown,
  contract: ManagedImageContractV1,
  candidateSha: string,
): DcodeBaseResolution {
  if (
    contract.agent !== AGENT ||
    contract.image !== MANAGED_IMAGE_REPOSITORIES[AGENT] ||
    contract.platform !== "linux/amd64" ||
    contract.source.revision !== candidateSha
  ) {
    throw new Error("Deep Agents Code managed-image contract does not match the candidate");
  }
  if (!Array.isArray(inspection) || inspection.length !== 1) {
    throw new Error("Deep Agents Code managed image inspection must contain one image");
  }
  const image = record(inspection[0], "Deep Agents Code managed image inspection");
  if (
    image.Os !== "linux" ||
    image.Architecture !== "amd64" ||
    !Array.isArray(image.RepoDigests) ||
    !image.RepoDigests.includes(contract.reference)
  ) {
    throw new Error("Deep Agents Code managed image inspection does not match its exact reference");
  }
  const labels = record(
    record(image.Config, "Deep Agents Code managed image configuration").Labels,
    "Deep Agents Code managed image labels",
  );
  const rawResolution = labels[BASE_RESOLUTION_LABEL];
  const resolutionKey = labels[BASE_RESOLUTION_KEY_LABEL];
  if (
    labels["io.nvidia.nemoclaw.agent"] !== AGENT ||
    labels["io.nvidia.nemoclaw.managed-image.contract"] !== "1" ||
    labels["io.nvidia.nemoclaw.managed-image.platform"] !== "linux/amd64" ||
    labels["io.nvidia.nemoclaw.managed-image.cohort"] !== contract.source.cohort ||
    labels["org.opencontainers.image.revision"] !== candidateSha ||
    labels["org.opencontainers.image.version"] !== contract.source.release ||
    typeof rawResolution !== "string" ||
    typeof resolutionKey !== "string"
  ) {
    throw new Error("Deep Agents Code managed image labels do not match its exact contract");
  }

  const resolution = parseResolutionLabel(rawResolution);
  exactKeys(
    resolution,
    [
      "architecture",
      "digest",
      "glibcVersion",
      "imageId",
      "imageName",
      "key",
      "minGlibcVersion",
      "os",
      "ref",
      "requireOpenshellSandboxAbi",
      "schema",
      "source",
      "sourceRevision",
    ],
    "Deep Agents Code managed image base resolution",
  );
  const sourceRevision = resolution.sourceRevision;
  const digest = resolution.digest;
  const reference = resolution.ref;
  if (
    resolution.schema !== 1 ||
    resolution.imageName !== BASE_IMAGE ||
    typeof digest !== "string" ||
    !DIGEST_PATTERN.test(digest) ||
    reference !== `${BASE_IMAGE}@${digest}` ||
    resolution.source !== "override" ||
    typeof sourceRevision !== "string" ||
    !SHA_PATTERN.test(sourceRevision) ||
    resolution.os !== "linux" ||
    resolution.architecture !== "amd64" ||
    typeof resolution.imageId !== "string" ||
    !DIGEST_PATTERN.test(resolution.imageId) ||
    typeof resolution.glibcVersion !== "string" ||
    !/^[0-9]+[.][0-9]+$/u.test(resolution.glibcVersion) ||
    resolution.minGlibcVersion !== "2.39" ||
    resolution.requireOpenshellSandboxAbi !== true ||
    typeof resolution.key !== "string" ||
    !KEY_PATTERN.test(resolution.key) ||
    resolution.key !== resolutionKey
  ) {
    throw new Error("Deep Agents Code managed image base resolution is invalid");
  }
  const canonical = {
    schema: 1,
    key: "",
    imageName: BASE_IMAGE,
    ref: reference,
    digest,
    source: "override",
    sourceRevision,
    imageId: resolution.imageId,
    os: "linux",
    architecture: "amd64",
    glibcVersion: resolution.glibcVersion,
    requireOpenshellSandboxAbi: true,
    minGlibcVersion: "2.39",
  };
  const expectedKey = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  if (resolution.key !== expectedKey) {
    throw new Error("Deep Agents Code managed image base resolution key is invalid");
  }
  return { reference, sourceRevision };
}

async function defaultResolvePublication(
  sourceRevision: string,
  token: string,
): Promise<PublicationRun> {
  return waitForBaseImagePublication({
    history: {
      expectedSha: sourceRevision,
      relevantSha: sourceRevision,
      relevantDistance: 0,
      distanceBySha: new Map([[sourceRevision, 0]]),
    },
    request: (apiPath) => githubRequest(apiPath, token),
    requireWorkflowSuccess: true,
    waitMs: 60_000,
    pollMs: 5_000,
  });
}

/** Resolve one trusted base publication for the source revision recorded by the exact PR managed image. */
export async function resolvePrDcodeBasePublication(
  input: {
    readonly candidateSha: string;
    readonly catalog: string;
    readonly token: string;
  },
  dependencies: PrDcodeBasePublicationDependencies = {},
): Promise<PrDcodeBasePublication> {
  const contract = parseCatalog(input.catalog, input.candidateSha);
  const inspection = (dependencies.inspectManagedImage ?? defaultInspectManagedImage)(
    contract.reference,
  );
  const resolution = readDcodeBaseResolution(inspection, contract, input.candidateSha);
  const run = await (
    dependencies.resolvePublication ??
    ((sourceRevision) => defaultResolvePublication(sourceRevision, input.token))
  )(resolution.sourceRevision);
  if (run.headSha !== resolution.sourceRevision) {
    throw new Error("trusted base-image publication does not match the managed image binding");
  }
  return { baseReference: resolution.reference, run };
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv.length !== 0) throw new Error("expected no arguments");
  const candidateSha = env.CANDIDATE_SHA ?? "";
  const workflowSha = env.GITHUB_SHA ?? "";
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.CANDIDATE_REPOSITORY !== REPOSITORY ||
    !SHA_PATTERN.test(candidateSha) ||
    !SHA_PATTERN.test(workflowSha) ||
    candidateSha === workflowSha
  ) {
    throw new Error(
      "Deep Agents Code base publication selection requires a trusted manual PR run for NVIDIA/NemoClaw",
    );
  }
  const token = env.GITHUB_TOKEN ?? "";
  if (!token || token.includes("\r") || token.includes("\n")) {
    throw new Error("GITHUB_TOKEN must be a non-empty single-line value");
  }
  const result = await resolvePrDcodeBasePublication({
    candidateSha,
    catalog: env.MANAGED_IMAGE_CATALOG ?? "",
    token,
  });
  const outputPath = env.GITHUB_OUTPUT ?? "";
  writePublicationRunOutputs(outputPath, result.run);
  appendFileSync(outputPath, `base_ref=${result.baseReference}\n`, "utf8");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "unknown PR Deep Agents Code base publication error",
    );
    process.exitCode = 1;
  });
}
