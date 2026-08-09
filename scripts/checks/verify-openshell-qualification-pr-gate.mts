// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  failQualificationGate as fail,
  validateBootstrapDraftTransition,
} from "./openshell-qualification-bootstrap-contract.mts";
import {
  loadBootstrapQualificationContractFromRoot,
  readBoundedRegularFileFromRoot,
} from "./openshell-qualification-io.mts";
import {
  classifyQualification,
  loadPullRequestFiles,
  type PullRequestReader,
} from "./openshell-qualification-paths.mts";

const QUALIFICATION_REPOSITORY = "NVIDIA/NemoClaw";
const MAX_GITHUB_JSON_BYTES = 16 * 1024 * 1024;
const MAX_BLUEPRINT_BYTES = 1024 * 1024;
const GITHUB_TIMEOUT_MILLISECONDS = 10_000;
const REVIEWED_BLUEPRINT_SHA256 =
  "a69e56022d7f5973f330e13dccfcef0c997f933f851da218a8f2f73cdcc9c20f";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;

type PullRequestIdentity = {
  baseRef: "main";
  baseSha: string;
  candidateRepository: string;
  candidateSha: string;
  number: number;
  repository: typeof QUALIFICATION_REPOSITORY;
  state: "open";
};

export type GateInputs = {
  baseSha: string;
  candidateSha: string;
  prNumber: number;
  repository: typeof QUALIFICATION_REPOSITORY;
};

type GateGitHubReader = PullRequestReader & {
  getPullRequest(repository: string, prNumber: number): Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNestedString(
  value: Record<string, unknown>,
  first: string,
  second: string,
  third?: string,
): string {
  const firstValue = value[first];
  if (!isRecord(firstValue)) fail("pull-request identity is malformed");
  const secondValue = firstValue[second];
  if (third === undefined) {
    if (typeof secondValue !== "string") fail("pull-request identity is malformed");
    return secondValue;
  }
  if (!isRecord(secondValue) || typeof secondValue[third] !== "string") {
    fail("pull-request identity is malformed");
  }
  return secondValue[third];
}

function validateSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    fail(`${label} must be a lowercase 40-character SHA`);
  }
  return value;
}

function validateRepository(value: unknown): typeof QUALIFICATION_REPOSITORY {
  if (value !== QUALIFICATION_REPOSITORY) {
    fail("repository identity is outside the qualification boundary");
  }
  return QUALIFICATION_REPOSITORY;
}

function validatePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(`${label} is invalid`);
  return value as number;
}

function validateInputs(inputs: GateInputs): GateInputs {
  return {
    baseSha: validateSha(inputs.baseSha, "base SHA"),
    candidateSha: validateSha(inputs.candidateSha, "candidate SHA"),
    prNumber: validatePositiveInteger(inputs.prNumber, "pull-request number"),
    repository: validateRepository(inputs.repository),
  };
}

function validatePullRequestIdentity(value: unknown, expected: GateInputs): PullRequestIdentity {
  if (!isRecord(value)) fail("pull-request response is not an object");
  if (value.state !== "open") fail("pull request is not open");
  const baseRef = readNestedString(value, "base", "ref");
  if (baseRef !== "main") fail("pull request no longer targets main");
  const identity: PullRequestIdentity = {
    baseRef,
    baseSha: validateSha(readNestedString(value, "base", "sha"), "live base SHA"),
    candidateRepository: readNestedString(value, "head", "repo", "full_name"),
    candidateSha: validateSha(readNestedString(value, "head", "sha"), "live candidate SHA"),
    number: validatePositiveInteger(value.number, "live pull-request number"),
    repository: validateRepository(readNestedString(value, "base", "repo", "full_name")),
    state: value.state,
  };
  if (
    identity.number !== expected.prNumber ||
    identity.baseSha !== expected.baseSha ||
    identity.candidateSha !== expected.candidateSha
  ) {
    fail("pull-request identity changed or does not match the workflow event");
  }
  return identity;
}

function parseContentLength(value: string | null, label: string): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) fail(`${label} content length is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} content length is invalid`);
  return parsed;
}

export async function readBoundedJsonResponse(
  response: Response,
  label: string,
  maximumBytes = MAX_GITHUB_JSON_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail(`${label} byte limit is invalid`);
  }
  const declared = parseContentLength(response.headers.get("content-length"), label);
  if (declared !== null && declared > maximumBytes) fail(`${label} response is oversized`);
  if (!response.ok) fail(`${label} request failed with HTTP ${response.status}`);
  if (response.body === null) fail(`${label} response has no body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        fail(`${label} response is oversized`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, total);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} response is not valid UTF-8`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    fail(`${label} response is not valid JSON`);
  }
}

export function createGitHubReader(token: string): GateGitHubReader {
  if (!token) fail("GITHUB_TOKEN is unavailable");
  const request = async (url: string, label: string): Promise<unknown> => {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "nemoclaw-openshell-qualification-pr-gate",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MILLISECONDS),
    });
    return readBoundedJsonResponse(response, label);
  };
  return {
    getPullRequest(repository: string, prNumber: number): Promise<unknown> {
      validateRepository(repository);
      validatePositiveInteger(prNumber, "pull-request number");
      return request(
        `https://api.github.com/repos/NVIDIA/NemoClaw/pulls/${prNumber}`,
        "pull-request",
      );
    },
    getPullRequestFilesPage(repository: string, prNumber: number, page: number): Promise<unknown> {
      validateRepository(repository);
      validatePositiveInteger(prNumber, "pull-request number");
      validatePositiveInteger(page, "pull-request files page");
      return request(
        `https://api.github.com/repos/NVIDIA/NemoClaw/pulls/${prNumber}/files?per_page=100&page=${page}`,
        "pull-request files",
      );
    },
  };
}

async function loadStablePullRequest(
  api: GateGitHubReader,
  inputs: GateInputs,
): Promise<{
  files: Awaited<ReturnType<typeof loadPullRequestFiles>>;
  identity: PullRequestIdentity;
}> {
  const expected = validateInputs(inputs);
  const before = validatePullRequestIdentity(
    await api.getPullRequest(expected.repository, expected.prNumber),
    expected,
  );
  const files = await loadPullRequestFiles(api, expected.repository, expected.prNumber);
  const after = validatePullRequestIdentity(
    await api.getPullRequest(expected.repository, expected.prNumber),
    expected,
  );
  if (before.candidateRepository !== after.candidateRepository) {
    fail("pull-request repository identity changed while the gate was running");
  }
  return { files, identity: after };
}

export async function classifyPullRequestGate(
  inputs: GateInputs,
  api: GateGitHubReader,
): Promise<{ required: boolean; sameRepository: boolean; sensitivePaths: string[] }> {
  const { files, identity } = await loadStablePullRequest(api, inputs);
  const classification = classifyQualification(files);
  return {
    ...classification,
    sameRepository: identity.candidateRepository === QUALIFICATION_REPOSITORY,
  };
}

function validateRoot(root: string, label: string): string {
  if (typeof root !== "string" || root.length === 0) fail(`${label} is invalid`);
  const absolute = path.resolve(root);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch {
    fail(`${label} is missing`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`${label} must be a real directory`);
  return fs.realpathSync(absolute);
}

export function readBlueprintVersion(root: string): string {
  const bytes = readBoundedRegularFileFromRoot(
    root,
    "nemoclaw-blueprint/blueprint.yaml",
    "OpenShell version blueprint",
    { maximumBytes: MAX_BLUEPRINT_BYTES, minimumBytes: 1 },
  );
  if (createHash("sha256").update(bytes).digest("hex") !== REVIEWED_BLUEPRINT_SHA256) {
    fail("trusted OpenShell version blueprint does not match the reviewed baseline");
  }
  return "0.0.99";
}

function validateBlueprintPair(baseRoot: string, candidateRoot: string): string {
  const baseBytes = readBoundedRegularFileFromRoot(
    baseRoot,
    "nemoclaw-blueprint/blueprint.yaml",
    "trusted OpenShell version blueprint",
    { maximumBytes: MAX_BLUEPRINT_BYTES, minimumBytes: 1 },
  );
  const candidateBytes = readBoundedRegularFileFromRoot(
    candidateRoot,
    "nemoclaw-blueprint/blueprint.yaml",
    "candidate OpenShell version blueprint",
    { maximumBytes: MAX_BLUEPRINT_BYTES, minimumBytes: 1 },
  );
  if (createHash("sha256").update(baseBytes).digest("hex") !== REVIEWED_BLUEPRINT_SHA256) {
    fail("trusted OpenShell version blueprint does not match the reviewed baseline");
  }
  if (!baseBytes.equals(candidateBytes)) {
    fail("candidate OpenShell version blueprint must remain byte-identical to the trusted base");
  }
  return "0.0.99";
}

export async function verifyDraftPullRequestGate(
  inputs: GateInputs & { baseRoot: string; candidateRoot: string },
  api: GateGitHubReader,
): Promise<void> {
  const { files, identity } = await loadStablePullRequest(api, inputs);
  if (identity.candidateRepository !== QUALIFICATION_REPOSITORY) {
    fail("sensitive qualification changes require a same-repository candidate");
  }
  if (!classifyQualification(files).required) {
    fail("draft verification was requested without a sensitive qualification change");
  }
  const baseRoot = validateRoot(inputs.baseRoot, "trusted base checkout");
  const candidateRoot = validateRoot(inputs.candidateRoot, "candidate data checkout");
  const blueprintVersion = validateBlueprintPair(baseRoot, candidateRoot);
  validateBootstrapDraftTransition(
    loadBootstrapQualificationContractFromRoot(baseRoot),
    loadBootstrapQualificationContractFromRoot(candidateRoot),
    {
      baseVersion: blueprintVersion,
      candidateVersion: blueprintVersion,
    },
  );
  const after = validatePullRequestIdentity(
    await api.getPullRequest(inputs.repository, inputs.prNumber),
    validateInputs(inputs),
  );
  if (after.candidateRepository !== identity.candidateRepository) {
    fail("pull-request repository identity changed while draft data was being verified");
  }
}

function parseCli(argv: readonly string[]): { command: string; values: Map<string, string> } {
  const command = argv[0] ?? "";
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      fail("CLI arguments are malformed or duplicated");
    }
    values.set(key, value);
  }
  return { command, values };
}

function requireCliValues(values: Map<string, string>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  if (values.size !== allowed.size || [...values.keys()].some((key) => !allowed.has(key))) {
    fail(`CLI requires exactly: ${expected.join(", ")}`);
  }
}

function requiredCliValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) fail(`CLI argument ${key} is missing`);
  return value;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!POSITIVE_INTEGER_PATTERN.test(value)) fail(`${label} is invalid`);
  return validatePositiveInteger(Number(value), label);
}

function cliInputs(values: Map<string, string>): GateInputs {
  return validateInputs({
    baseSha: requiredCliValue(values, "--base-sha"),
    candidateSha: requiredCliValue(values, "--candidate-sha"),
    prNumber: parsePositiveInteger(requiredCliValue(values, "--pr-number"), "pull-request number"),
    repository: validateRepository(requiredCliValue(values, "--repository")),
  });
}

function appendGitHubOutput(filePath: string, values: Record<string, string>): void {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow === 0 || path.normalize(filePath) !== filePath) {
    fail("GitHub output path is invalid");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow);
  } catch {
    fail("GitHub output file is unavailable");
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) fail("GitHub output destination is not a regular file");
    const source = Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join("");
    fs.writeSync(descriptor, source, null, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { command, values } = parseCli(argv);
  const api = createGitHubReader(environment.GITHUB_TOKEN ?? "");
  if (command === "classify") {
    requireCliValues(values, [
      "--base-sha",
      "--candidate-sha",
      "--output",
      "--pr-number",
      "--repository",
    ]);
    const result = await classifyPullRequestGate(cliInputs(values), api);
    appendGitHubOutput(requiredCliValue(values, "--output"), {
      required: String(result.required),
      "same-repository": String(result.sameRepository),
      "sensitive-paths": JSON.stringify(result.sensitivePaths),
    });
    return;
  }
  if (command === "verify-draft") {
    requireCliValues(values, [
      "--base-root",
      "--base-sha",
      "--candidate-root",
      "--candidate-sha",
      "--pr-number",
      "--repository",
    ]);
    await verifyDraftPullRequestGate(
      {
        ...cliInputs(values),
        baseRoot: requiredCliValue(values, "--base-root"),
        candidateRoot: requiredCliValue(values, "--candidate-root"),
      },
      api,
    );
    return;
  }
  fail("CLI command must be classify or verify-draft");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "OpenShell qualification PR gate failed";
    console.error(message);
    process.exitCode = 1;
  });
}
