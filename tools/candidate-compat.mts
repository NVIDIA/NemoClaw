// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPONENTS = ["openshell"] as const;
export type CandidateComponent = (typeof COMPONENTS)[number];

export type Artifact = {
  digest: string;
  digestAlgorithm: "sha256";
  kind: "archive";
  name: string;
  role: "cli" | "gateway" | "sandbox";
  url: string;
};

export type CandidateReceipt = {
  artifacts: Artifact[];
  component: CandidateComponent;
  nemoclawSha: string;
  officialSource: string;
  requestedCandidate: string;
  resolutionId: string;
  resolvedCandidate: string;
  schemaVersion: 1;
};

export type CandidatePlan = {
  component: CandidateComponent;
  deterministic: Array<{
    id: DeterministicLane;
    reason: string;
    status: "selected" | "skipped";
  }>;
  live: Array<{
    id: string;
    reason: string;
    selector: "job" | "target";
    status: "selected" | "skipped";
  }>;
  schemaVersion: 1;
};

type LaneResult = {
  conclusion: "failure" | "success";
  lane: string;
  observedOutput?: string;
  observedVersion?: string;
  resolutionId: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type DeterministicLane =
  | "source-unit"
  | "integration"
  | "installer"
  | "package-contract"
  | "plugin"
  | "e2e-support";

const FULL_SHA = /^[a-f0-9]{40}$/;
const VERSION = /^[0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z.-]+)?$/;
const DIGEST = /^[a-f0-9]+$/;
const OFFICIAL_HOSTS = new Set(["api.github.com", "codeload.github.com", "github.com"]);
const DOWNLOAD_HOSTS = new Set([...OFFICIAL_HOSTS, "release-assets.githubusercontent.com"]);
const MAX_DOWNLOAD_REDIRECTS = 5;
const ALL_LANES: DeterministicLane[] = [
  "source-unit",
  "integration",
  "installer",
  "package-contract",
  "plugin",
  "e2e-support",
];

const SELECTED_LANES: Record<CandidateComponent, ReadonlySet<DeterministicLane>> = {
  openshell: new Set(["installer"]),
};

const LIVE_SELECTORS: Record<
  CandidateComponent,
  ReadonlyArray<{ id: string; selector: "job" | "target" }>
> = {
  openshell: [{ id: "openshell-gateway-auth-contract", selector: "job" }],
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertComponent(value: string): asserts value is CandidateComponent {
  if (!COMPONENTS.includes(value as CandidateComponent)) {
    throw new Error(`component must be one of: ${COMPONENTS.join(", ")}`);
  }
}

function assertCandidate(component: CandidateComponent, candidate: string): void {
  if (candidate.length > 128 || candidate.includes("/") || /[\x00-\x20\x7f]/u.test(candidate)) {
    throw new Error("candidate contains unsafe characters");
  }
  const normalized = candidate.replace(/^v/u, "");
  if (!VERSION.test(normalized)) {
    throw new Error(`${component} candidate must be an exact version`);
  }
}

function assertOfficialUrl(raw: string, expectedPathPrefix: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !OFFICIAL_HOSTS.has(url.hostname)) {
    throw new Error(`candidate artifact is not on an approved official HTTPS host: ${raw}`);
  }
  if (!url.pathname.startsWith(expectedPathPrefix)) {
    throw new Error(`candidate artifact has unexpected official-source path: ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `candidate artifact URL must not contain credentials, query, or fragment: ${raw}`,
    );
  }
  return url;
}

async function fetchJson(fetcher: FetchLike, url: string, token?: string): Promise<unknown> {
  const response = await fetcher(url, {
    headers: {
      Accept: "application/vnd.github+json, application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`official metadata request failed (${response.status}): ${url}`);
  return response.json();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return field;
}

function artifact(input: Artifact, expectedPathPrefix: string): Artifact {
  const url = assertOfficialUrl(input.url, expectedPathPrefix);
  if (!DIGEST.test(input.digest)) throw new Error(`${input.name} has an invalid digest`);
  const expectedLength = 64;
  if (input.digest.length !== expectedLength) {
    throw new Error(`${input.name} has an invalid ${input.digestAlgorithm} digest`);
  }
  return { ...input, url: url.href };
}

async function resolveOpenShell(
  candidate: string,
  fetcher: FetchLike,
  token?: string,
): Promise<Omit<CandidateReceipt, "nemoclawSha" | "resolutionId" | "schemaVersion">> {
  const version = candidate.replace(/^v/u, "");
  const tag = `v${version}`;
  const metadata = record(
    await fetchJson(
      fetcher,
      `https://api.github.com/repos/NVIDIA/OpenShell/releases/tags/${tag}`,
      token,
    ),
    "OpenShell release",
  );
  if (metadata.draft === true) throw new Error("OpenShell candidate release is a draft");
  if (stringField(metadata, "tag_name", "OpenShell release") !== tag) {
    throw new Error("OpenShell release tag does not match the requested candidate");
  }
  if (!Array.isArray(metadata.assets)) throw new Error("OpenShell release assets must be an array");
  const requiredAssets = [
    {
      name: "openshell-x86_64-unknown-linux-musl.tar.gz",
      role: "cli" as const,
    },
    {
      name: "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
      role: "gateway" as const,
    },
    {
      name: "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz",
      role: "sandbox" as const,
    },
  ];
  const releaseAssets = metadata.assets.map((item) => record(item, "OpenShell asset"));
  const artifacts = requiredAssets.map(({ name, role }) => {
    const assetMetadata = releaseAssets.find((item) => item.name === name);
    if (!assetMetadata) throw new Error(`OpenShell release is missing ${name}`);
    const digest = stringField(assetMetadata, "digest", `OpenShell asset ${name}`);
    if (!digest.startsWith("sha256:")) {
      throw new Error(`OpenShell asset ${name} is missing SHA-256 provenance`);
    }
    return artifact(
      {
        digest: digest.slice("sha256:".length),
        digestAlgorithm: "sha256",
        kind: "archive",
        name,
        role,
        url: stringField(assetMetadata, "browser_download_url", `OpenShell asset ${name}`),
      },
      `/NVIDIA/OpenShell/releases/download/${tag}/`,
    );
  });
  return {
    artifacts,
    component: "openshell",
    officialSource: `github:NVIDIA/OpenShell:release:${String(metadata.id)}`,
    requestedCandidate: candidate,
    resolvedCandidate: version,
  };
}

export async function resolveCandidate(input: {
  candidate: string;
  component: string;
  fetcher?: FetchLike;
  githubToken?: string;
  nemoclawSha: string;
}): Promise<CandidateReceipt> {
  assertComponent(input.component);
  if (!FULL_SHA.test(input.nemoclawSha)) throw new Error("NemoClaw ref must resolve to a full SHA");
  assertCandidate(input.component, input.candidate);
  const fetcher = input.fetcher ?? fetch;
  const resolved = await resolveOpenShell(input.candidate, fetcher, input.githubToken);
  const receiptWithoutId = {
    ...resolved,
    nemoclawSha: input.nemoclawSha,
    schemaVersion: 1 as const,
  };
  return {
    ...receiptWithoutId,
    resolutionId: sha256(stableJson(receiptWithoutId)),
  };
}

function parseArtifact(value: unknown, resolvedCandidate: string, index: number): Artifact {
  const input = record(value, `candidate artifact ${index}`);
  const digestAlgorithm = stringField(input, "digestAlgorithm", `candidate artifact ${index}`);
  if (digestAlgorithm !== "sha256") {
    throw new Error(`candidate artifact ${index} has an invalid digest algorithm`);
  }
  const kind = stringField(input, "kind", `candidate artifact ${index}`);
  if (kind !== "archive") {
    throw new Error(`candidate artifact ${index} has an invalid kind`);
  }
  const name = stringField(input, "name", `candidate artifact ${index}`);
  if (name !== basename(name) || name.length > 255) {
    throw new Error(`candidate artifact ${index} has an unsafe name`);
  }

  const expected = [
    {
      name: "openshell-x86_64-unknown-linux-musl.tar.gz",
      role: "cli" as const,
    },
    {
      name: "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
      role: "gateway" as const,
    },
    {
      name: "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz",
      role: "sandbox" as const,
    },
  ][index];
  if (!expected || name !== expected.name || input.role !== expected.role) {
    throw new Error(`candidate artifact ${index} does not match the resolved component`);
  }
  return artifact(
    {
      digest: stringField(input, "digest", `candidate artifact ${index}`),
      digestAlgorithm,
      kind,
      name,
      role: expected.role,
      url: stringField(input, "url", `candidate artifact ${index}`),
    },
    `/NVIDIA/OpenShell/releases/download/v${resolvedCandidate}/`,
  );
}

/** Parse an uploaded resolver receipt and bind it to the trusted resolve-job output. */
export function parseCandidateReceipt(
  value: unknown,
  expectedResolutionId: string,
): CandidateReceipt {
  if (!/^[a-f0-9]{64}$/u.test(expectedResolutionId)) {
    throw new Error("expected candidate resolution id is invalid");
  }
  const input = record(value, "candidate receipt");
  if (input.schemaVersion !== 1) throw new Error("candidate receipt schema version must be 1");
  const component = stringField(input, "component", "candidate receipt");
  assertComponent(component);
  const requestedCandidate = stringField(input, "requestedCandidate", "candidate receipt");
  assertCandidate(component, requestedCandidate);
  const resolvedCandidate = stringField(input, "resolvedCandidate", "candidate receipt");
  if (!VERSION.test(resolvedCandidate)) {
    throw new Error("candidate receipt has an invalid resolved version");
  }
  if (requestedCandidate.replace(/^v/u, "") !== resolvedCandidate) {
    throw new Error("candidate receipt resolved version does not match the request");
  }
  const nemoclawSha = stringField(input, "nemoclawSha", "candidate receipt");
  if (!FULL_SHA.test(nemoclawSha)) throw new Error("candidate receipt has an invalid NemoClaw SHA");
  if (!Array.isArray(input.artifacts))
    throw new Error("candidate receipt artifacts must be an array");
  const expectedArtifactCount = 3;
  if (input.artifacts.length !== expectedArtifactCount) {
    throw new Error(`candidate receipt for ${component} has an invalid artifact count`);
  }
  const artifacts = input.artifacts.map((item, index) =>
    parseArtifact(item, resolvedCandidate, index),
  );
  const officialSource = stringField(input, "officialSource", "candidate receipt");
  const sourcePattern = /^github:NVIDIA\/OpenShell:release:[1-9][0-9]*$/u;
  if (!sourcePattern.test(officialSource)) {
    throw new Error("candidate receipt has an invalid official source");
  }
  if (input.resolvedCommit !== undefined) {
    throw new Error("candidate receipt has an invalid resolved commit");
  }
  const receiptWithoutId = {
    artifacts,
    component,
    nemoclawSha,
    officialSource,
    requestedCandidate,
    resolvedCandidate,
    schemaVersion: 1 as const,
  };
  const resolutionId = sha256(stableJson(receiptWithoutId));
  if (
    stringField(input, "resolutionId", "candidate receipt") !== resolutionId ||
    resolutionId !== expectedResolutionId
  ) {
    throw new Error("candidate receipt does not match the trusted resolution id");
  }
  return { ...receiptWithoutId, resolutionId };
}

export function buildCandidatePlan(
  component: CandidateComponent,
  e2eSources: string,
): CandidatePlan {
  const selected = SELECTED_LANES[component];
  const live = LIVE_SELECTORS[component].map((entry) => {
    const marker = entry.selector === "job" ? `  ${entry.id}:\n` : `id: "${entry.id}"`;
    if (!e2eSources.includes(marker)) {
      throw new Error(`E2E source of truth does not declare ${entry.selector} ${entry.id}`);
    }
    return {
      ...entry,
      reason: "the selected live job executes the digest-bound OpenShell gateway candidate",
      status: "selected" as const,
    };
  });
  return {
    component,
    deterministic: ALL_LANES.map((id) => ({
      id,
      reason: selected.has(id)
        ? `the ${id} lane exercises ${component}-owned source or integration boundaries`
        : `the ${id} lane does not exercise an ${component}-owned boundary`,
      status: selected.has(id) ? "selected" : "skipped",
    })),
    live,
    schemaVersion: 1,
  };
}

/** Validate a persisted plan before it can select compatibility evidence. */
export function parseCandidatePlan(
  value: unknown,
  expectedComponent: CandidateComponent,
): CandidatePlan {
  const input = record(value, "candidate plan");
  if (input.schemaVersion !== 1) throw new Error("candidate plan schema version must be 1");
  const component = stringField(input, "component", "candidate plan");
  assertComponent(component);
  if (component !== expectedComponent) {
    throw new Error("candidate plan component does not match the receipt");
  }
  if (!Array.isArray(input.deterministic)) {
    throw new Error("candidate plan deterministic lanes must be an array");
  }
  const deterministic = input.deterministic.map((value, index) => {
    const lane = record(value, `candidate plan deterministic lane ${index}`);
    const id = stringField(lane, "id", `candidate plan deterministic lane ${index}`);
    if (!ALL_LANES.includes(id as DeterministicLane)) {
      throw new Error(`candidate plan has an unsupported deterministic lane: ${id}`);
    }
    const statusValue = stringField(lane, "status", `candidate plan deterministic lane ${index}`);
    if (statusValue !== "selected" && statusValue !== "skipped") {
      throw new Error(`candidate plan deterministic lane ${id} has an invalid status`);
    }
    const status: "selected" | "skipped" = statusValue;
    return {
      id: id as DeterministicLane,
      reason: stringField(lane, "reason", `candidate plan deterministic lane ${index}`),
      status,
    };
  });
  if (
    deterministic.length !== ALL_LANES.length ||
    new Set(deterministic.map(({ id }) => id)).size !== ALL_LANES.length
  ) {
    throw new Error("candidate plan must account for every deterministic lane exactly once");
  }
  for (const lane of deterministic) {
    const expectedStatus = SELECTED_LANES[component].has(lane.id) ? "selected" : "skipped";
    if (lane.status !== expectedStatus) {
      throw new Error(`candidate plan has an invalid selection for ${lane.id}`);
    }
  }
  if (!Array.isArray(input.live)) {
    throw new Error("candidate plan live lanes must be an array");
  }
  const expectedLive = LIVE_SELECTORS[component];
  const live = input.live.map((value, index) => {
    const lane = record(value, `candidate plan live lane ${index}`);
    const id = stringField(lane, "id", `candidate plan live lane ${index}`);
    const selector = stringField(lane, "selector", `candidate plan live lane ${index}`);
    const expected = expectedLive.find((candidate) => candidate.id === id);
    if (!expected || selector !== expected.selector) {
      throw new Error(`candidate plan has an unsupported live lane: ${id}`);
    }
    if (lane.status !== "selected") {
      throw new Error(`candidate plan live lane ${id} must be selected`);
    }
    return {
      id,
      reason: stringField(lane, "reason", `candidate plan live lane ${index}`),
      selector: expected.selector,
      status: "selected" as const,
    };
  });
  if (
    live.length !== expectedLive.length ||
    new Set(live.map(({ id }) => id)).size !== expectedLive.length
  ) {
    throw new Error("candidate plan must account for every live lane exactly once");
  }
  return { component, deterministic, live, schemaVersion: 1 };
}

export function verifyDigest(bytes: Uint8Array, artifactValue: Artifact): void {
  const actual = createHash(artifactValue.digestAlgorithm).update(bytes).digest("hex");
  if (actual !== artifactValue.digest) {
    throw new Error(`${artifactValue.name} ${artifactValue.digestAlgorithm} mismatch`);
  }
}

export function verifyObservedVersion(receipt: CandidateReceipt, output: string): string {
  const escaped = receipt.resolvedCandidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`(^|[^0-9A-Za-z.])v?${escaped}([^0-9A-Za-z.]|$)`, "u").test(output.trim())) {
    throw new Error(
      `observed ${receipt.component} version does not match ${receipt.resolvedCandidate}: ${output.trim()}`,
    );
  }
  return receipt.resolvedCandidate;
}

export function finalizeEvidence(input: {
  attempt: string;
  plan: CandidatePlan;
  receipt: CandidateReceipt;
  results: LaneResult[];
  runId: string;
}): Record<string, unknown> {
  if (!/^[1-9][0-9]*$/u.test(input.runId) || !/^[1-9][0-9]*$/u.test(input.attempt)) {
    throw new Error("run id and attempt must be positive integers");
  }
  const selected = [
    ...input.plan.deterministic.filter((lane) => lane.status === "selected").map((lane) => lane.id),
    ...input.plan.live
      .filter((lane) => lane.status === "selected")
      .map((lane) => `live:${lane.id}`),
  ].sort();
  const actual = input.results.map((result) => result.lane).sort();
  if (new Set(actual).size !== actual.length || stableJson(actual) !== stableJson(selected)) {
    throw new Error(
      "lane results do not account for every selected compatibility lane exactly once",
    );
  }
  for (const result of input.results) {
    if (result.resolutionId !== input.receipt.resolutionId) {
      throw new Error(`lane ${result.lane} used a different candidate resolution`);
    }
    if (result.conclusion !== "success" && result.conclusion !== "failure") {
      throw new Error(`lane ${result.lane} has an invalid conclusion`);
    }
    if (
      result.conclusion === "success" &&
      (result.observedVersion !== input.receipt.resolvedCandidate || !result.observedOutput)
    ) {
      throw new Error(`lane ${result.lane} has no matching observed candidate version`);
    }
  }
  return {
    execution: { attempt: input.attempt, runId: input.runId },
    overall: input.results.every((result) => result.conclusion === "success")
      ? "success"
      : "failure",
    plan: input.plan,
    receipt: input.receipt,
    results: [...input.results].sort((left, right) =>
      left.lane < right.lane ? -1 : left.lane > right.lane ? 1 : 0,
    ),
    schemaVersion: 1,
  };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function assertDownloadUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    !DOWNLOAD_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.length > 4096
  ) {
    throw new Error(`candidate download URL is not approved: ${raw}`);
  }
  return url;
}

async function fetchDownload(fetcher: FetchLike, rawUrl: string): Promise<Response> {
  let current = assertDownloadUrl(rawUrl);
  for (let redirectCount = 0; redirectCount <= MAX_DOWNLOAD_REDIRECTS; redirectCount += 1) {
    const response = await fetcher(current.href, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirectCount === MAX_DOWNLOAD_REDIRECTS) {
      throw new Error("candidate download exceeded the redirect limit");
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("candidate download redirect has no location");
    current = assertDownloadUrl(new URL(location, current).href);
  }
  throw new Error("candidate download redirect handling failed");
}

export async function downloadCandidateArtifact(
  artifactValue: Artifact,
  directory: string,
  index: number,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const response = await fetchDownload(fetcher, artifactValue.url);
  if (!response.ok) throw new Error(`candidate download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  verifyDigest(bytes, artifactValue);
  const target = join(directory, `candidate-${index}.tar.gz`);
  await writeFile(target, bytes, { mode: 0o600 });
  return target;
}

const ROLE_BINARY: Record<Artifact["role"], string> = {
  cli: "openshell",
  gateway: "openshell-gateway",
  sandbox: "openshell-sandbox",
};

const INSTALLER_FEATURE_MARKERS = [
  "request-body-credential-rewrite",
  "websocket-credential-rewrite",
  "allow_all_known_mcp_methods",
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function binaryContains(binary: string, marker: string): boolean {
  const result = spawnSync("grep", ["-aFq", "--", marker, binary], {
    stdio: "ignore",
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`failed to inspect ${basename(binary)} for installer feature markers`);
}

function extractCandidateBinary(
  archive: string,
  artifactValue: Artifact,
  runtimeDirectory: string,
): string {
  const binaryName = ROLE_BINARY[artifactValue.role];
  const members = run("tar", ["-tzf", archive]);
  if (members !== binaryName) {
    throw new Error(`${artifactValue.name} must contain exactly one ${binaryName} binary`);
  }
  const listing = run("tar", ["-tvzf", archive]);
  if (listing.includes("\n") || !listing.startsWith("-") || !listing.endsWith(` ${binaryName}`)) {
    throw new Error(`${artifactValue.name} must contain one regular ${binaryName} binary`);
  }
  run("tar", ["-xzf", archive, "-C", runtimeDirectory, binaryName]);
  return join(runtimeDirectory, binaryName);
}

export function verifyCandidateInvocations(input: {
  invocationLog: string;
  lane: string;
  receipt: CandidateReceipt;
}): LaneResult {
  const entries = input.invocationLog
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length !== 3 || !fields[0] || !fields[1])
        throw new Error("candidate invocation log contains a malformed entry");
      return {
        args: fields[2] ?? "",
        context: fields[1],
        role: fields[0],
      };
    });
  const requiredRoles = input.lane === "installer" ? ["cli", "gateway", "sandbox"] : ["gateway"];
  if (input.lane !== "installer" && input.lane !== "live:openshell-gateway-auth-contract") {
    throw new Error(`unsupported candidate-aware lane: ${input.lane}`);
  }
  const expectedContext = `${input.lane}:${input.receipt.resolutionId}`;
  for (const role of requiredRoles) {
    if (
      !entries.some(
        (entry) =>
          entry.role === role && entry.context === expectedContext && entry.args === "--version",
      )
    ) {
      throw new Error(`lane ${input.lane} did not invoke receipt-bound ${role} --version`);
    }
  }
  if (
    input.lane === "live:openshell-gateway-auth-contract" &&
    !entries.some(
      (entry) =>
        entry.role === "gateway" && entry.context === expectedContext && entry.args !== "--version",
    )
  ) {
    throw new Error("live gateway lane did not start the candidate runtime");
  }
  return {
    conclusion: "success",
    lane: input.lane,
    observedOutput: entries
      .map((entry) => `${entry.role} ${entry.context} ${entry.args}`)
      .join("\n"),
    observedVersion: input.receipt.resolvedCandidate,
    resolutionId: input.receipt.resolutionId,
  };
}

export async function materializeCandidate(
  receipt: CandidateReceipt,
  directory: string,
  fetcher: FetchLike = fetch,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runtimeDirectory = join(directory, "runtime");
  const binDirectory = join(directory, "bin");
  await mkdir(runtimeDirectory, { mode: 0o700 });
  await mkdir(binDirectory, { mode: 0o700 });
  const archives = await Promise.all(
    receipt.artifacts.map((candidateArtifact, index) =>
      downloadCandidateArtifact(candidateArtifact, directory, index, fetcher),
    ),
  );
  const observed: Record<string, { output: string; path: string; version: string }> = {};
  for (const [index, artifactValue] of receipt.artifacts.entries()) {
    const archive = archives[index];
    if (!archive) throw new Error(`candidate artifact ${index} was not downloaded`);
    const binary = extractCandidateBinary(archive, artifactValue, runtimeDirectory);
    await chmod(binary, 0o700);
    const output = run(binary, ["--version"]);
    const version = verifyObservedVersion(receipt, output);
    const wrapper = join(binDirectory, ROLE_BINARY[artifactValue.role]);
    const installerFeatureMarkers = INSTALLER_FEATURE_MARKERS.filter((marker) =>
      binaryContains(binary, marker),
    );
    await writeFile(
      wrapper,
      [
        "#!/bin/sh",
        "set -eu",
        ...installerFeatureMarkers.map((marker) => `# receipt-bound feature: ${marker}`),
        ': "${NEMOCLAW_CANDIDATE_INVOCATION_LOG:?candidate invocation log is required}"',
        ': "${NEMOCLAW_CANDIDATE_INVOCATION_CONTEXT:?candidate invocation context is required}"',
        `printf '%s\\t%s\\t%s\\n' ${shellQuote(artifactValue.role)} "$NEMOCLAW_CANDIDATE_INVOCATION_CONTEXT" "$*" >> "$NEMOCLAW_CANDIDATE_INVOCATION_LOG"`,
        `exec ${shellQuote(binary)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o500 },
    );
    observed[artifactValue.role] = { output, path: binary, version };
  }
  return {
    binDirectory,
    component: receipt.component,
    observed,
    resolutionId: receipt.resolutionId,
    schemaVersion: 1 as const,
  };
}

function parseArgs(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error(`invalid argument: ${key ?? ""}`);
    if (values.has(key)) throw new Error(`duplicate argument: ${key}`);
    values.set(key, value);
  }
  return values;
}

function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "resolve") {
    const receipt = await resolveCandidate({
      candidate: required(args, "--candidate"),
      component: required(args, "--component"),
      githubToken: process.env.GITHUB_TOKEN,
      nemoclawSha: required(args, "--nemoclaw-sha"),
    });
    await writeFile(required(args, "--output"), `${stableJson(receipt)}\n`, {
      mode: 0o600,
    });
    return;
  }
  if (command === "plan") {
    const component = required(args, "--component");
    assertComponent(component);
    const sources = await Promise.all([
      readFile(required(args, "--e2e-workflow"), "utf8"),
      readFile(required(args, "--e2e-registry"), "utf8"),
    ]);
    const plan = buildCandidatePlan(component, sources.join("\n"));
    await writeFile(required(args, "--output"), `${stableJson(plan)}\n`, {
      mode: 0o600,
    });
    return;
  }
  if (command === "materialize") {
    const receipt = parseCandidateReceipt(
      JSON.parse(await readFile(required(args, "--receipt"), "utf8")),
      required(args, "--resolution-id"),
    );
    const observed = await materializeCandidate(receipt, required(args, "--directory"));
    await writeFile(required(args, "--output"), `${stableJson(observed)}\n`, {
      mode: 0o600,
    });
    const githubEnv = args.get("--github-env");
    if (githubEnv) {
      const invocationLog = join(required(args, "--directory"), "candidate-invocations.log");
      await writeFile(
        githubEnv,
        [
          `PATH=${observed.binDirectory}:${process.env.PATH ?? ""}`,
          `NEMOCLAW_CANDIDATE_COMPONENT=${receipt.component}`,
          `NEMOCLAW_CANDIDATE_INVOCATION_LOG=${invocationLog}`,
          `NEMOCLAW_CANDIDATE_RECEIPT=${resolve(required(args, "--receipt"))}`,
          `NEMOCLAW_CANDIDATE_RESOLUTION_ID=${receipt.resolutionId}`,
          `NEMOCLAW_CANDIDATE_VERSION=${receipt.resolvedCandidate}`,
          `NEMOCLAW_OPENSHELL_SANDBOX_BIN=${join(observed.binDirectory, "openshell-sandbox")}`,
          `OPENSHELL_BIN=${join(observed.binDirectory, "openshell")}`,
          `OPENSHELL_GATEWAY_BIN=${join(observed.binDirectory, "openshell-gateway")}`,
          "",
        ].join("\n"),
        { flag: "a" },
      );
    }
    return;
  }
  if (command === "verify-invocations") {
    const receipt = parseCandidateReceipt(
      JSON.parse(await readFile(required(args, "--receipt"), "utf8")),
      required(args, "--resolution-id"),
    );
    const result = verifyCandidateInvocations({
      invocationLog: await readFile(required(args, "--log"), "utf8"),
      lane: required(args, "--lane"),
      receipt,
    });
    await writeFile(required(args, "--output"), `${stableJson(result)}\n`, {
      mode: 0o600,
    });
    return;
  }
  if (command === "finalize") {
    const receipt = parseCandidateReceipt(
      JSON.parse(await readFile(required(args, "--receipt"), "utf8")),
      required(args, "--resolution-id"),
    );
    const plan = parseCandidatePlan(
      JSON.parse(await readFile(required(args, "--plan"), "utf8")),
      receipt.component,
    );
    const resultDirectory = required(args, "--results");
    const resultFiles = (await readdir(resultDirectory, { recursive: true })).filter((path) =>
      path.endsWith(".json"),
    );
    const results = await Promise.all(
      resultFiles.map(async (path) =>
        JSON.parse(await readFile(join(resultDirectory, path), "utf8")),
      ),
    );
    const evidence = finalizeEvidence({
      attempt: required(args, "--attempt"),
      plan,
      receipt,
      results,
      runId: required(args, "--run-id"),
    });
    await writeFile(required(args, "--output"), `${stableJson(evidence)}\n`, {
      mode: 0o600,
    });
    return;
  }
  throw new Error("command must be resolve, plan, materialize, verify-invocations, or finalize");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`candidate-compat: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
