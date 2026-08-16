// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { NativeRuntimeQualificationProducerPlanRow } from "./native-runtime-qualification-producer-plan.mts";

const MAX_RECEIPT_BYTES = 65_536;
const MAX_RECEIPT_DIRECTORY_BYTES = 1_048_576;
const EXPECTED_INSTALLER_FILES = [
  "architecture.json",
  "candidate-source.json",
  "docker-absence.json",
  "installed-source.json",
  "installer.sh",
  "invocation.json",
] as const;

interface CaseExecutionReceipt {
  readonly schemaVersion: 1;
  readonly kind: "nemoclaw-native-runtime-qualification-execution-v1";
  readonly caseId: string;
  readonly candidateSha: string;
  readonly installerSha256: string;
  readonly architecture: string;
  readonly acceleration: string;
  readonly agent: string;
  readonly inference: string;
  readonly rootModes: readonly string[];
  readonly obligations: readonly string[];
  readonly focusedOperations: readonly string[];
  readonly evidenceKinds: readonly string[];
  readonly dockerUnavailable: {
    readonly beforeCandidate: true;
    readonly afterCandidate: true;
  };
  readonly credentialBoundary: {
    readonly githubCredentialsAbsent: true;
    readonly modelCredentialsAbsent: true;
    readonly isolatedUid: true;
  };
  readonly result: "passed";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields are invalid`);
  }
}

function exactStrings(actual: unknown, expected: readonly string[], label: string): void {
  if (
    !Array.isArray(actual) ||
    actual.some((entry) => typeof entry !== "string") ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new Error(`${label} does not match the trusted plan`);
  }
}

function readBoundedFile(file: string, maximum = MAX_RECEIPT_BYTES): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size < 1 || status.size > maximum) {
      throw new Error(`Native runtime qualification receipt is missing or invalid: ${file}`);
    }
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Native runtime qualification")) {
      throw error;
    }
    throw new Error(`Native runtime qualification receipt is missing or invalid: ${file}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readBoundedFile(file)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Native runtime qualification receipt is not valid JSON: ${file}`);
    }
    throw error;
  }
}

function validateDirectory(directory: string, expectedFiles: readonly string[]): void {
  const status = lstatSync(directory, { throwIfNoEntry: false });
  if (!status?.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`Native runtime qualification receipt directory is invalid: ${directory}`);
  }
  const files = readdirSync(directory).sort();
  if (JSON.stringify(files) !== JSON.stringify([...expectedFiles].sort())) {
    throw new Error(`Native runtime qualification receipt files are invalid: ${directory}`);
  }
  let total = 0;
  for (const file of files) {
    const child = path.join(directory, file);
    const childStatus = lstatSync(child);
    if (!childStatus.isFile() || childStatus.isSymbolicLink() || childStatus.size < 1) {
      throw new Error(`Native runtime qualification receipt file is invalid: ${child}`);
    }
    total += childStatus.size;
  }
  if (total > MAX_RECEIPT_DIRECTORY_BYTES) {
    throw new Error(`Native runtime qualification receipts exceed their size limit: ${directory}`);
  }
}

function validateInstallerReceipts(
  row: NativeRuntimeQualificationProducerPlanRow,
  directory: string,
) {
  validateDirectory(directory, EXPECTED_INSTALLER_FILES);
  const invocation = record(
    readJson(path.join(directory, "invocation.json")),
    "Installer invocation",
  );
  exactKeys(
    invocation,
    ["receiptVersion", "script", "scriptSha256", "candidateSha", "architecture"],
    "Installer invocation",
  );
  if (
    invocation.receiptVersion !== 1 ||
    invocation.script !== "scripts/install.sh" ||
    invocation.scriptSha256 !== row.installerSha256 ||
    invocation.candidateSha !== row.source.candidateSha ||
    invocation.architecture !== row.case.architecture
  ) {
    throw new Error("Native runtime qualification installer invocation is invalid");
  }
  const architecture = record(
    readJson(path.join(directory, "architecture.json")),
    "Installer architecture",
  );
  exactKeys(architecture, ["receiptVersion", "requested", "runner"], "Installer architecture");
  if (
    architecture.receiptVersion !== 1 ||
    architecture.requested !== row.case.architecture ||
    architecture.runner !== row.case.architecture
  ) {
    throw new Error("Native runtime qualification installer architecture is invalid");
  }
  const candidate = record(
    readJson(path.join(directory, "candidate-source.json")),
    "Installer candidate source",
  );
  const installed = record(
    readJson(path.join(directory, "installed-source.json")),
    "Installed source",
  );
  exactKeys(
    candidate,
    ["receiptVersion", "repository", "revision", "installerSha256"],
    "Installer candidate source",
  );
  exactKeys(
    installed,
    [
      "receiptVersion",
      "repository",
      "requestedRevision",
      "installedRevision",
      "installMode",
      "installerSha256",
    ],
    "Installed source",
  );
  const repository = "https://github.com/NVIDIA/NemoClaw.git";
  if (
    candidate.receiptVersion !== 1 ||
    candidate.repository !== repository ||
    candidate.revision !== row.source.candidateSha ||
    candidate.installerSha256 !== row.installerSha256 ||
    installed.receiptVersion !== 1 ||
    installed.repository !== repository ||
    installed.requestedRevision !== row.source.candidateSha ||
    installed.installedRevision !== row.source.candidateSha ||
    installed.installMode !== "managed" ||
    installed.installerSha256 !== row.installerSha256
  ) {
    throw new Error("Native runtime qualification installer source identity is invalid");
  }
  const docker = record(
    readJson(path.join(directory, "docker-absence.json")),
    "Installer Docker absence",
  );
  exactKeys(
    docker,
    ["receiptVersion", "preExecution", "postExecution"],
    "Installer Docker absence",
  );
  const requiredDockerKeys = [
    "dockerCommandGuarded",
    "dockerEnvironmentVariablesUnset",
    "dockerServiceInactive",
    "dockerSocketUnitInactive",
    "dockerdProcessNameAbsent",
    "defaultSocketPathsAbsent",
  ];
  for (const phase of ["preExecution", "postExecution"] as const) {
    const value = record(docker[phase], `Installer Docker absence ${phase}`);
    exactKeys(value, requiredDockerKeys, `Installer Docker absence ${phase}`);
    if (requiredDockerKeys.some((key) => value[key] !== true)) {
      throw new Error("Native runtime qualification installer Docker absence is invalid");
    }
  }
  if (docker.receiptVersion !== 1) {
    throw new Error("Native runtime qualification installer Docker absence is invalid");
  }
  const installer = readBoundedFile(path.join(directory, "installer.sh"), 524_288);
  if (
    !installer.startsWith("#!/") ||
    createHash("sha256").update(installer).digest("hex") !== row.installerSha256
  ) {
    throw new Error("Native runtime qualification installer receipt is invalid");
  }
}

function validateCaseExecution(
  row: NativeRuntimeQualificationProducerPlanRow,
  value: unknown,
): CaseExecutionReceipt {
  const receipt = record(value, "Native runtime qualification execution receipt");
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "kind",
      "caseId",
      "candidateSha",
      "installerSha256",
      "architecture",
      "acceleration",
      "agent",
      "inference",
      "rootModes",
      "obligations",
      "focusedOperations",
      "evidenceKinds",
      "dockerUnavailable",
      "credentialBoundary",
      "result",
    ],
    "Native runtime qualification execution receipt",
  );
  const docker = record(receipt.dockerUnavailable, "Docker-unavailable execution receipt");
  const credentials = record(receipt.credentialBoundary, "Credential-boundary execution receipt");
  exactKeys(docker, ["beforeCandidate", "afterCandidate"], "Docker-unavailable execution receipt");
  exactKeys(
    credentials,
    ["githubCredentialsAbsent", "modelCredentialsAbsent", "isolatedUid"],
    "Credential-boundary execution receipt",
  );
  exactStrings(receipt.rootModes, row.rootModes, "Native runtime qualification root modes");
  exactStrings(
    receipt.obligations,
    row.case.obligations,
    "Native runtime qualification obligations",
  );
  exactStrings(
    receipt.focusedOperations,
    row.focusedOperations,
    "Native runtime qualification focused operations",
  );
  exactStrings(
    receipt.evidenceKinds,
    row.case.evidenceKinds,
    "Native runtime qualification evidence kinds",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "nemoclaw-native-runtime-qualification-execution-v1" ||
    receipt.caseId !== row.id ||
    receipt.candidateSha !== row.source.candidateSha ||
    receipt.installerSha256 !== row.installerSha256 ||
    receipt.architecture !== row.case.architecture ||
    receipt.acceleration !== row.case.acceleration ||
    receipt.agent !== row.case.agent ||
    receipt.inference !== row.case.inference ||
    docker.beforeCandidate !== true ||
    docker.afterCandidate !== true ||
    credentials.githubCredentialsAbsent !== true ||
    credentials.modelCredentialsAbsent !== true ||
    credentials.isolatedUid !== true ||
    receipt.result !== "passed"
  ) {
    throw new Error("Native runtime qualification execution receipt identity is invalid");
  }
  return receipt as unknown as CaseExecutionReceipt;
}

export function writeNativeRuntimeQualificationProducerEvidence(
  row: NativeRuntimeQualificationProducerPlanRow,
  installerReceiptDirectory: string,
  executionReceiptPath: string,
  evidenceDirectory: string,
): void {
  validateInstallerReceipts(row, installerReceiptDirectory);
  validateCaseExecution(row, readJson(executionReceiptPath));
  if (lstatSync(evidenceDirectory, { throwIfNoEntry: false })) {
    throw new Error("Native runtime qualification evidence directory must not already exist");
  }
  const parent = path.dirname(evidenceDirectory);
  const parentStatus = lstatSync(parent, { throwIfNoEntry: false });
  if (
    !path.isAbsolute(evidenceDirectory) ||
    !parentStatus?.isDirectory() ||
    parentStatus.isSymbolicLink()
  ) {
    throw new Error("Native runtime qualification evidence parent is invalid");
  }
  mkdirSync(evidenceDirectory, { mode: 0o700 });
  writeFileSync(
    path.join(evidenceDirectory, "evidence.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "nemoclaw-native-runtime-qualification-case-evidence-v1",
      qualificationId: `${row.case.id.slice(0, row.case.id.indexOf("-"))}-protected-host-local-inference`,
      providerId: row.case.id.slice(0, row.case.id.indexOf("-")),
      source: row.source,
      case: row.case,
      result: "passed",
    })}\n`,
    { mode: 0o600 },
  );
}

if (process.argv[1]?.endsWith("native-runtime-qualification-producer-evidence.mts")) {
  try {
    if (process.argv.length !== 2) {
      throw new Error("Usage: native-runtime-qualification-producer-evidence.mts");
    }
    const row = JSON.parse(
      process.env.QUALIFICATION_ROW ?? "null",
    ) as NativeRuntimeQualificationProducerPlanRow;
    writeNativeRuntimeQualificationProducerEvidence(
      row,
      process.env.INSTALLER_RECEIPT_DIRECTORY ?? "",
      process.env.EXECUTION_RECEIPT_PATH ?? "",
      process.env.EVIDENCE_DIRECTORY ?? "",
    );
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
