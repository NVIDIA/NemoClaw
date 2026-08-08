// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readValidatedArtifactZipEntry } from "../scorecard/read-artifact-zip.mts";
import {
  assertExactKeys,
  createQualificationReceipt,
  fail,
  isRecord,
  MAX_GITHUB_JSON_BYTES,
  QUALIFICATION_CONTRACT_PATH,
  QUALIFICATION_MAX_ARTIFACT_BYTES,
  QUALIFICATION_RECEIPT_FILE,
  type QualificationArtifactReader,
  type QualificationContract,
  type QualificationExecutionContext,
  type QualificationGitHubReader,
  type QualificationPhase,
  type QualificationReceiptExpectation,
  type QualificationReceiptTest,
  type QualificationRetirementEvidence,
  type QualificationRetirementTagMetadata,
  qualificationAuthorityPaths,
  qualificationReceiptContract,
  renderQualificationRetirementTagMessage,
  SAFE_TEXT_PATTERN,
  validateExecutionContext,
  validatePhase,
  validatePhaseExecutionContext,
  validateQualificationContract,
  validateQualificationReceipt,
  validateSha,
} from "./openshell-qualification-core.mts";
import {
  authenticateFinalQualificationReceipt,
  authenticateQualificationAuthorityPaths,
  produceQualificationReceipt,
} from "./openshell-qualification-github.mts";
import {
  loadQualificationContract,
  loadQualificationContractFromRoot,
  loadQualificationReceipt,
  parseBoundedJson,
  parseQualificationReceiptArchive,
  readBoundedRegularFile,
  readQualificationReceiptArchive,
} from "./openshell-qualification-io.mts";

export {
  activeQualificationTests,
  createQualificationReceipt,
  requireActiveQualificationTests,
  requiredQualificationTests,
  validateQualificationContract,
  validateQualificationLifecycleTransition,
  validateQualificationReceipt,
} from "./openshell-qualification-core.mts";
export {
  authenticateFinalQualificationReceipt,
  authenticateQualificationAuthorityPaths,
  authenticateQualificationReceiptSources,
  produceQualificationReceipt,
} from "./openshell-qualification-github.mts";
export {
  loadQualificationContract,
  loadQualificationContractFromRoot,
  loadQualificationReceipt,
  parseBoundedJson,
  parseQualificationReceiptArchive,
  readQualificationReceiptArchive,
} from "./openshell-qualification-io.mts";
export * from "./openshell-qualification-schema.mts";

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

function requireCliValues(values: Map<string, string>, allowed: readonly string[]): void {
  const expected = new Set(allowed);
  if (values.size !== expected.size || [...values.keys()].some((key) => !expected.has(key))) {
    fail(`CLI requires exactly: ${allowed.join(", ")}`);
  }
}

function expectationFromCli(values: Map<string, string>): QualificationReceiptExpectation {
  const phase = validatePhase(values.get("--phase"));
  const executionContext = validateExecutionContext(values.get("--execution-context"));
  validatePhaseExecutionContext(phase, executionContext);
  return {
    baseSha: values.get("--base-sha") ?? "",
    candidateSha: values.get("--candidate-sha") ?? "",
    executionContext,
    phase,
    ...(executionContext !== "release" ? { prNumber: Number(values.get("--pr-number")) } : {}),
    repository: values.get("--repository") ?? "",
  };
}

function receiptContractFromCli(
  values: Map<string, string>,
  phase: QualificationPhase,
  executionContext: QualificationExecutionContext,
): QualificationContract {
  const rooted = values.has("--contract-root") || values.has("--candidate-root");
  const baseContract = rooted
    ? loadQualificationContractFromRoot(values.get("--contract-root") ?? "")
    : loadQualificationContract(values.get("--contract") ?? "");
  return qualificationReceiptContract(
    baseContract,
    rooted
      ? loadQualificationContractFromRoot(values.get("--candidate-root") ?? "")
      : loadQualificationContract(values.get("--candidate-contract") ?? ""),
    phase,
    executionContext,
  );
}

function writeExclusiveJson(filePath: string, value: unknown): void {
  if (!SAFE_TEXT_PATTERN.test(filePath) || path.normalize(filePath) !== filePath) {
    fail("qualification receipt output path is invalid or non-canonical");
  }
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    fail(`qualification receipt output could not be created: ${String(error)}`);
  }
}

function createGitHubReader(token: string): QualificationGitHubReader {
  const request = async (apiPath: string): Promise<Response> => {
    if (!apiPath.startsWith("repos/")) fail("GitHub API path is outside the repository boundary");
    return fetch(`https://api.github.com/${apiPath}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "nemoclaw-openshell-qualification",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  };
  return {
    async getBytes(apiPath: string): Promise<Buffer> {
      const response = await request(apiPath);
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > QUALIFICATION_MAX_ARTIFACT_BYTES) {
        fail("GitHub artifact response is oversized");
      }
      const result = Buffer.from(await response.arrayBuffer());
      if (!response.ok) fail(`GitHub API request failed with HTTP ${response.status}`);
      if (result.length > QUALIFICATION_MAX_ARTIFACT_BYTES) {
        fail("GitHub artifact response is oversized");
      }
      return result;
    },
    async getJson(apiPath: string): Promise<unknown> {
      const response = await request(apiPath);
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_JSON_BYTES) {
        fail("GitHub JSON response is oversized");
      }
      const source = await response.text();
      if (Buffer.byteLength(source, "utf8") > MAX_GITHUB_JSON_BYTES) {
        fail("GitHub JSON response is oversized");
      }
      if (!response.ok) fail(`GitHub API request failed with HTTP ${response.status}`);
      try {
        return JSON.parse(source) as unknown;
      } catch {
        fail("GitHub API returned malformed JSON");
      }
    },
  };
}

function createGitHubCliReader(): QualificationArtifactReader {
  const invoke = (apiPath: string, maxBuffer: number): Buffer => {
    if (!apiPath.startsWith("repos/")) fail("GitHub API path is outside the repository boundary");
    try {
      return execFileSync("gh", ["api", "--hostname", "github.com", apiPath], {
        encoding: "buffer",
        maxBuffer,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      fail("authenticated GitHub API lookup failed");
    }
  };
  return {
    async getBytes(apiPath: string): Promise<Buffer> {
      const result = invoke(apiPath, QUALIFICATION_MAX_ARTIFACT_BYTES + 1);
      if (result.length > QUALIFICATION_MAX_ARTIFACT_BYTES) {
        fail("GitHub artifact response is oversized");
      }
      return result;
    },
    async getJson(apiPath: string): Promise<unknown> {
      const result = invoke(apiPath, MAX_GITHUB_JSON_BYTES + 1);
      if (result.length > MAX_GITHUB_JSON_BYTES) fail("GitHub JSON response is oversized");
      try {
        return JSON.parse(result.toString("utf8")) as unknown;
      } catch {
        fail("GitHub API returned malformed JSON");
      }
    },
  };
}

type RetirementAuthenticationOptions = {
  authoritySha: string;
  includeFinalContractInAuthority: boolean;
  repository: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function finalContractFromRetired(contract: QualificationContract): QualificationContract {
  if (contract.lifecycle !== "retired" || contract.retirementEvidence === null) {
    fail("live retirement authentication requires retired lifecycle evidence");
  }
  return validateQualificationContract({
    ...contract,
    lifecycle: "final",
    retirementEvidence: null,
  });
}

async function loadFinalContractAtReleaseCandidate(
  api: QualificationArtifactReader,
  contract: QualificationContract,
  evidence: QualificationRetirementEvidence,
): Promise<QualificationContract> {
  const value = await api.getJson(
    `repos/${contract.repository}/contents/${QUALIFICATION_CONTRACT_PATH}?ref=${evidence.releaseCandidateSha}`,
  );
  if (
    !isRecord(value) ||
    value.type !== "file" ||
    value.encoding !== "base64" ||
    typeof value.content !== "string" ||
    typeof value.sha !== "string" ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 1 ||
    (value.size as number) > QUALIFICATION_MAX_ARTIFACT_BYTES
  ) {
    fail("retirement release-candidate contract response is malformed or oversized");
  }
  validateSha(value.sha, "retirement release-candidate contract blob SHA");
  const encoded = value.content.replace(/\n/gu, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    fail("retirement release-candidate contract encoding is invalid");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== value.size || bytes.toString("base64") !== encoded) {
    fail("retirement release-candidate contract bytes are mismatched");
  }
  if (sha256(bytes) !== evidence.finalContractSha256) {
    fail("retirement final contract digest does not match the tagged release candidate");
  }
  const parsed = parseBoundedJson(bytes.toString("utf8"), "retirement final contract");
  const finalContract = validateQualificationContract(parsed);
  const expected = finalContractFromRetired(contract);
  if (JSON.stringify(finalContract) !== JSON.stringify(expected)) {
    fail("retirement tagged final contract does not match the retired contract authority");
  }
  return finalContract;
}

function validateRetirementTagRef(value: unknown, evidence: QualificationRetirementEvidence): void {
  if (
    !isRecord(value) ||
    value.ref !== `refs/tags/${evidence.releaseTag}` ||
    !isRecord(value.object) ||
    value.object.type !== "tag" ||
    value.object.sha !== evidence.releaseTagObjectSha
  ) {
    fail("retirement release tag ref is missing, moved, or not annotated");
  }
}

function validateRetirementTagSignedPayload(
  value: Record<string, unknown>,
  evidence: QualificationRetirementEvidence,
  expectedMessage: string,
): boolean {
  if (!isRecord(value.tagger) || !isRecord(value.verification)) return false;
  const signature = value.verification.signature;
  const payload = value.verification.payload;
  if (
    typeof value.message !== "string" ||
    typeof signature !== "string" ||
    typeof payload !== "string" ||
    signature.length === 0 ||
    Buffer.byteLength(value.message, "utf8") > QUALIFICATION_MAX_ARTIFACT_BYTES ||
    Buffer.byteLength(signature, "utf8") > QUALIFICATION_MAX_ARTIFACT_BYTES ||
    Buffer.byteLength(payload, "utf8") > QUALIFICATION_MAX_ARTIFACT_BYTES ||
    value.message !== `${expectedMessage}\n${signature}`
  ) {
    return false;
  }
  const separator = payload.indexOf("\n\n");
  if (separator < 1 || payload.slice(separator + 2) !== `${expectedMessage}\n`) return false;
  const headers = payload.slice(0, separator).split("\n");
  if (
    headers.length !== 4 ||
    headers[0] !== `object ${evidence.releaseCandidateSha}` ||
    headers[1] !== "type commit" ||
    headers[2] !== `tag ${evidence.releaseTag}`
  ) {
    return false;
  }
  const tagger = /^tagger (.+) <([^<>]*)> ([0-9]+) ([+-])([0-9]{2})([0-9]{2})$/u.exec(
    headers[3] ?? "",
  );
  if (!tagger) return false;
  const timestamp = Number(tagger[3]);
  const timezoneHour = Number(tagger[5]);
  const timezoneMinute = Number(tagger[6]);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timezoneHour > 23 ||
    timezoneMinute > 59 ||
    value.tagger.name !== tagger[1] ||
    value.tagger.email !== tagger[2] ||
    typeof value.tagger.date !== "string"
  ) {
    return false;
  }
  const date = new Date(timestamp * 1000);
  return (
    Number.isFinite(date.getTime()) &&
    value.tagger.date === date.toISOString().replace(/\.000Z$/u, "Z")
  );
}

function validateRetirementTagObject(
  value: unknown,
  evidence: QualificationRetirementEvidence,
): void {
  const { releaseTagObjectSha: _releaseTagObjectSha, ...metadata } = evidence;
  const expectedMessage = renderQualificationRetirementTagMessage(metadata);
  if (
    !isRecord(value) ||
    value.sha !== evidence.releaseTagObjectSha ||
    value.tag !== evidence.releaseTag ||
    !isRecord(value.object) ||
    value.object.type !== "commit" ||
    value.object.sha !== evidence.releaseCandidateSha ||
    !isRecord(value.verification) ||
    value.verification.verified !== true ||
    value.verification.reason !== "valid" ||
    !validateRetirementTagSignedPayload(value, evidence, expectedMessage)
  ) {
    fail("retirement release tag object is unverified or does not bind the final evidence");
  }
}

async function authenticateRetirementTag(
  api: QualificationArtifactReader,
  repository: string,
  evidence: QualificationRetirementEvidence,
): Promise<void> {
  validateRetirementTagRef(
    await api.getJson(`repos/${repository}/git/ref/tags/${evidence.releaseTag}`),
    evidence,
  );
  validateRetirementTagObject(
    await api.getJson(`repos/${repository}/git/tags/${evidence.releaseTagObjectSha}`),
    evidence,
  );
}

async function authenticateRetirementCommitAncestry(
  api: QualificationArtifactReader,
  repository: string,
  evidence: QualificationRetirementEvidence,
  authoritySha: string,
): Promise<void> {
  const releaseCommit = await api.getJson(
    `repos/${repository}/commits/${evidence.releaseCandidateSha}`,
  );
  if (
    !isRecord(releaseCommit) ||
    releaseCommit.sha !== evidence.releaseCandidateSha ||
    !Array.isArray(releaseCommit.parents) ||
    releaseCommit.parents.length < 1 ||
    !isRecord(releaseCommit.parents[0]) ||
    releaseCommit.parents[0].sha !== evidence.releaseBaseSha
  ) {
    fail("retirement release candidate first-parent identity is mismatched");
  }
  const comparison = await api.getJson(
    `repos/${repository}/compare/${evidence.releaseCandidateSha}...${authoritySha}`,
  );
  if (
    !isRecord(comparison) ||
    (comparison.status !== "ahead" && comparison.status !== "identical") ||
    !isRecord(comparison.base_commit) ||
    comparison.base_commit.sha !== evidence.releaseCandidateSha ||
    !isRecord(comparison.merge_base_commit) ||
    comparison.merge_base_commit.sha !== evidence.releaseCandidateSha ||
    !isRecord(comparison.head_commit) ||
    comparison.head_commit.sha !== authoritySha
  ) {
    fail("retirement release candidate is not an ancestor of the current authority commit");
  }
}

async function loadRetirementReceiptArchive(
  api: QualificationArtifactReader,
  contract: QualificationContract,
  evidence: QualificationRetirementEvidence,
): Promise<Buffer> {
  const value = await api.getJson(
    `repos/${contract.repository}/actions/runs/${evidence.trustedProducerRunId}/artifacts?per_page=100&page=1`,
  );
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    (value.total_count as number) > 100 ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== value.total_count
  ) {
    fail("retirement producer artifacts response is malformed or oversized");
  }
  const expectedName = `openshell-0.0.101-qualification-release-${evidence.trustedProducerRunId}-${evidence.trustedProducerRunAttempt}`;
  const matching = value.artifacts.filter(
    (artifact) => isRecord(artifact) && artifact.name === expectedName,
  );
  const artifact = matching[0];
  if (
    matching.length !== 1 ||
    !isRecord(artifact) ||
    !Number.isSafeInteger(artifact.id) ||
    (artifact.id as number) < 1 ||
    artifact.expired !== false ||
    typeof artifact.archive_download_url !== "string" ||
    !isRecord(artifact.workflow_run) ||
    String(artifact.workflow_run.id) !== evidence.trustedProducerRunId ||
    artifact.workflow_run.head_sha !== evidence.releaseCandidateSha
  ) {
    fail("retirement final receipt artifact is missing, duplicated, expired, or mismatched");
  }
  const archivePath = `repos/${artifact.archive_download_url.split("/repos/")[1] ?? ""}`;
  if (archivePath !== `repos/${contract.repository}/actions/artifacts/${artifact.id}/zip`) {
    fail("retirement final receipt artifact download URL is mismatched");
  }
  return api.getBytes(archivePath);
}

export async function authenticateQualificationRetirement(
  contractValue: QualificationContract | unknown,
  options: RetirementAuthenticationOptions,
  api: QualificationArtifactReader,
): Promise<QualificationRetirementEvidence> {
  const contract = validateQualificationContract(contractValue);
  if (contract.lifecycle !== "retired" || contract.retirementEvidence === null) {
    fail("live retirement authentication requires retired lifecycle evidence");
  }
  if (options.repository !== contract.repository) {
    fail("retirement authentication repository does not match the contract");
  }
  validateSha(options.authoritySha, "retirement authority SHA");
  const evidence = contract.retirementEvidence;
  const finalContract = await loadFinalContractAtReleaseCandidate(api, contract, evidence);
  await authenticateRetirementTag(api, contract.repository, evidence);
  await authenticateRetirementCommitAncestry(
    api,
    contract.repository,
    evidence,
    options.authoritySha,
  );
  await authenticateQualificationAuthorityPaths(
    api,
    contract.repository,
    evidence.releaseCandidateSha,
    options.authoritySha,
    qualificationAuthorityPaths(finalContract, options.includeFinalContractInAuthority),
  );
  const archive = await loadRetirementReceiptArchive(api, contract, evidence);
  const receiptSource = readValidatedArtifactZipEntry(archive, QUALIFICATION_RECEIPT_FILE, {
    maxBytes: QUALIFICATION_MAX_ARTIFACT_BYTES,
  });
  if (receiptSource === null || sha256(receiptSource) !== evidence.finalReceiptSha256) {
    fail("retirement final receipt digest does not match the authenticated artifact");
  }
  const expected: QualificationReceiptExpectation = {
    baseSha: evidence.releaseBaseSha,
    candidateSha: evidence.releaseCandidateSha,
    executionContext: "release",
    phase: "final",
    repository: contract.repository,
  };
  const receipt = validateQualificationReceipt(
    parseQualificationReceiptArchive(archive),
    finalContract,
    expected,
  );
  if (
    receipt.trustedProducerRunId !== evidence.trustedProducerRunId ||
    receipt.trustedProducerRunAttempt !== evidence.trustedProducerRunAttempt ||
    receipt.trustedProducerWorkflowSha !== evidence.trustedProducerWorkflowSha
  ) {
    fail("retirement evidence does not match the authenticated receipt producer");
  }
  await authenticateFinalQualificationReceipt(receipt, finalContract, expected, api, {
    historicalReleaseAuthoritySha: options.authoritySha,
  });
  await authenticateRetirementTag(api, contract.repository, evidence);
  return evidence;
}

function createRetirementTagMetadata(
  values: Map<string, string>,
): QualificationRetirementTagMetadata {
  const contractPath = values.get("--contract") ?? "";
  const receiptPath = values.get("--receipt") ?? "";
  const candidateSha = values.get("--candidate-sha") ?? "";
  const baseSha = values.get("--base-sha") ?? "";
  const contractSource = readBoundedRegularFile(contractPath, "qualification contract");
  const contract = validateQualificationContract(
    parseBoundedJson(contractSource, "qualification contract"),
  );
  if (contract.lifecycle !== "final") {
    fail("retirement tag metadata requires final lifecycle");
  }
  const receiptSource = readBoundedRegularFile(receiptPath, "qualification receipt");
  const receipt = validateQualificationReceipt(
    parseBoundedJson(receiptSource, "qualification receipt"),
    contract,
    {
      baseSha,
      candidateSha,
      executionContext: "release",
      phase: "final",
      repository: contract.repository,
    },
  );
  return {
    finalContractSha256: sha256(contractSource),
    finalReceiptSha256: sha256(receiptSource),
    releaseBaseSha: baseSha,
    releaseCandidateSha: candidateSha,
    releaseTag: values.get("--release-tag") ?? "",
    schemaVersion: 1,
    scope: contract.scope,
    trustedProducerRunAttempt: receipt.trustedProducerRunAttempt,
    trustedProducerRunId: receipt.trustedProducerRunId,
    trustedProducerWorkflowSha: receipt.trustedProducerWorkflowSha,
  };
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { command, values } = parseCli(argv);
  const common = [
    "--base-sha",
    "--candidate-sha",
    "--contract",
    "--execution-context",
    "--phase",
    "--repository",
  ] as const;
  const rootedCommon = [
    "--base-sha",
    "--candidate-sha",
    "--contract-root",
    "--execution-context",
    "--phase",
    "--repository",
  ] as const;
  if (command === "authority-paths") {
    requireCliValues(values, ["--contract", "--include-contract"]);
    const includeContract = values.get("--include-contract");
    if (includeContract !== "true" && includeContract !== "false") {
      fail("authority-paths include-contract must be true or false");
    }
    const contract = loadQualificationContract(values.get("--contract") ?? "");
    process.stdout.write(
      `${qualificationAuthorityPaths(contract, includeContract === "true").join("\n")}\n`,
    );
    return;
  }
  if (command === "retirement-tag-message") {
    requireCliValues(values, [
      "--base-sha",
      "--candidate-sha",
      "--contract",
      "--receipt",
      "--release-tag",
    ]);
    process.stdout.write(
      `${renderQualificationRetirementTagMessage(createRetirementTagMetadata(values))}\n`,
    );
    return;
  }
  if (command === "validate-retirement-live") {
    requireCliValues(values, ["--authority-sha", "--contract", "--repository"]);
    const evidence = await authenticateQualificationRetirement(
      loadQualificationContract(values.get("--contract") ?? ""),
      {
        authoritySha: values.get("--authority-sha") ?? "",
        includeFinalContractInAuthority: false,
        repository: values.get("--repository") ?? "",
      },
      createGitHubCliReader(),
    );
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    return;
  }
  if (command === "validate-live") {
    requireCliValues(values, [...common, "--receipt"]);
    const contract = loadQualificationContract(values.get("--contract") ?? "");
    const expected = expectationFromCli(values);
    const receiptSource = readBoundedRegularFile(
      values.get("--receipt") ?? "",
      "qualification receipt",
    );
    const receipt = validateQualificationReceipt(
      parseBoundedJson(receiptSource, "qualification receipt"),
      contract,
      expected,
    );
    const authenticated = await authenticateFinalQualificationReceipt(
      receipt,
      contract,
      expected,
      createGitHubCliReader(),
      { expectedReceiptBytes: Buffer.from(receiptSource, "utf8") },
    );
    process.stdout.write(`${JSON.stringify(authenticated)}\n`);
    return;
  }
  if (command === "validate") {
    const rooted = values.has("--contract-root") || values.has("--candidate-root");
    const validateKeys = rooted
      ? [...rootedCommon, "--candidate-root", "--receipt"]
      : [...common, "--candidate-contract", "--receipt"];
    const phase = validatePhase(values.get("--phase"));
    const executionContext = validateExecutionContext(values.get("--execution-context"));
    validatePhaseExecutionContext(phase, executionContext);
    if (executionContext !== "release") validateKeys.push("--pr-number");
    requireCliValues(values, validateKeys);
    const contract = receiptContractFromCli(values, phase, executionContext);
    const receipt = loadQualificationReceipt(
      values.get("--receipt") ?? "",
      contract,
      expectationFromCli(values),
    );
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  if (command === "validate-archive") {
    const validateKeys = [...common, "--archive", "--candidate-contract"];
    const phase = validatePhase(values.get("--phase"));
    const executionContext = validateExecutionContext(values.get("--execution-context"));
    validatePhaseExecutionContext(phase, executionContext);
    if (executionContext !== "release") validateKeys.push("--pr-number");
    requireCliValues(values, validateKeys);
    const contract = receiptContractFromCli(values, phase, executionContext);
    const archivePath = values.get("--archive") ?? "";
    const stats = fs.lstatSync(archivePath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size > QUALIFICATION_MAX_ARTIFACT_BYTES
    ) {
      fail("qualification artifact must be a bounded regular non-link file");
    }
    const receipt = readQualificationReceiptArchive(
      fs.readFileSync(archivePath),
      contract,
      expectationFromCli(values),
    );
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  if (command === "create") {
    const createKeys = [
      ...common,
      "--evidence",
      "--output",
      "--trusted-workflow-run-attempt",
      "--trusted-workflow-run-id",
      "--trusted-workflow-run-url",
      "--trusted-workflow-sha",
    ];
    const createPhase = validatePhase(values.get("--phase"));
    const createContext = validateExecutionContext(values.get("--execution-context"));
    validatePhaseExecutionContext(createPhase, createContext);
    if (createContext !== "release") createKeys.push("--pr-number");
    requireCliValues(values, createKeys);
    const contract = loadQualificationContract(values.get("--contract") ?? "");
    const evidence = parseBoundedJson(
      readBoundedRegularFile(values.get("--evidence") ?? "", "qualification evidence"),
      "qualification evidence",
    );
    if (!isRecord(evidence)) fail("qualification evidence is not an object");
    assertExactKeys(evidence, ["schemaVersion", "tests"], "qualification evidence");
    if (evidence.schemaVersion !== 1 || !Array.isArray(evidence.tests)) {
      fail("qualification evidence schema is unsupported");
    }
    const expected = expectationFromCli(values);
    const receipt = createQualificationReceipt(contract, {
      ...expected,
      tests: evidence.tests as QualificationReceiptTest[],
      trustedProducerRunAttempt: Number(values.get("--trusted-workflow-run-attempt")),
      trustedProducerRunId: values.get("--trusted-workflow-run-id") ?? "",
      trustedProducerRunUrl: values.get("--trusted-workflow-run-url") ?? "",
      trustedProducerWorkflowSha: values.get("--trusted-workflow-sha") ?? "",
    });
    writeExclusiveJson(values.get("--output") ?? "", receipt);
    return;
  }
  if (command === "produce") {
    const rooted = values.has("--contract-root") || values.has("--candidate-root");
    const produceKeys = [
      ...(rooted ? rootedCommon : common),
      ...(rooted ? ["--candidate-root"] : ["--candidate-contract"]),
      "--output",
      "--trusted-workflow-run-attempt",
      "--trusted-workflow-run-id",
      "--trusted-workflow-run-url",
      "--trusted-workflow-sha",
    ];
    const phase = validatePhase(values.get("--phase"));
    const executionContext = validateExecutionContext(values.get("--execution-context"));
    validatePhaseExecutionContext(phase, executionContext);
    if (executionContext !== "release") produceKeys.push("--pr-number");
    requireCliValues(values, produceKeys);
    const token = process.env.GITHUB_TOKEN;
    if (!token) fail("GITHUB_TOKEN is required to produce a qualification receipt");
    const contract = rooted
      ? loadQualificationContractFromRoot(values.get("--contract-root") ?? "")
      : loadQualificationContract(values.get("--contract") ?? "");
    const expected = expectationFromCli(values);
    const receipt = await produceQualificationReceipt(
      contract,
      {
        ...expected,
        candidateContract: rooted
          ? loadQualificationContractFromRoot(values.get("--candidate-root") ?? "")
          : loadQualificationContract(values.get("--candidate-contract") ?? ""),
        trustedProducerRunAttempt: Number(values.get("--trusted-workflow-run-attempt")),
        trustedProducerRunId: values.get("--trusted-workflow-run-id") ?? "",
        trustedProducerRunUrl: values.get("--trusted-workflow-run-url") ?? "",
        trustedProducerWorkflowSha: values.get("--trusted-workflow-sha") ?? "",
      },
      createGitHubReader(token),
    );
    writeExclusiveJson(values.get("--output") ?? "", receipt);
    return;
  }
  fail(
    "CLI command must be authority-paths, create, produce, retirement-tag-message, validate, validate-live, validate-retirement-live, or validate-archive",
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  fs.realpathSync(path.resolve(invokedPath)) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
