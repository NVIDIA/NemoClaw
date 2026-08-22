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

import type {
  NativeRuntimeQualificationObligation,
  NativeRuntimeQualificationArtifactReceipt,
} from "../../test/e2e/registry/native-runtime-qualification.ts";
import {
  nativeRuntimeQualificationOperationFile,
  NATIVE_RUNTIME_QUALIFICATION_ID,
  NATIVE_RUNTIME_QUALIFICATION_PROVIDER_ID,
  type NativeRuntimeQualificationProducerPlanRow,
} from "./native-runtime-qualification-producer-plan.mts";

const MAX_RECEIPT_BYTES = 65_536;
const MAX_INSTALLER_BYTES = 524_288;
const MAX_RECEIPT_DIRECTORY_BYTES = 1_048_576;
const EXPECTED_INSTALLER_FILES = [
  "architecture.json",
  "candidate-source.json",
  "docker-absence.json",
  "installed-source.json",
  "installer.sh",
  "invocation.json",
] as const;
const DETAIL_FILE = "case-evidence.json";
const EXECUTION_FILE = "execution.json";
const RUNTIME_FILE = "runtime-result.json";
const CDI_FILE = "nvidia-cdi.json";
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ENGINE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,127}$/u;
const FORBIDDEN_RECEIPT_TEXT =
  /(?:github_pat_|gh[pousr]_[A-Za-z0-9]{20}|nvapi-[A-Za-z0-9_-]{12}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;

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

interface CandidateCaseDetails {
  readonly schemaVersion: 1;
  readonly kind: "nemoclaw-native-runtime-qualification-case-details-v1";
  readonly caseId: string;
  readonly runtime: {
    readonly engineName: string;
    readonly engineVersion: string;
    readonly managedImages: readonly {
      readonly role: string;
      readonly digest: string;
    }[];
    readonly resultFile: typeof RUNTIME_FILE;
  };
  readonly operations: readonly {
    readonly id: NativeRuntimeQualificationObligation;
    readonly file: string;
  }[];
  readonly nvidiaCdi?: {
    readonly device: "nvidia.com/gpu=all";
    readonly file: typeof CDI_FILE;
  };
}

export interface NativeRuntimeQualificationCaseFragment {
  readonly schemaVersion: 1;
  readonly kind: "nemoclaw-native-runtime-qualification-case-fragment-v1";
  readonly qualificationId: string;
  readonly providerId: string;
  readonly source: NativeRuntimeQualificationProducerPlanRow["source"];
  readonly case: NativeRuntimeQualificationProducerPlanRow["case"];
  readonly installer: {
    readonly providerId: string;
    readonly architecture: string;
    readonly dockerAvailability: "unavailable";
    readonly exitCode: 0;
    readonly invocation: NativeRuntimeQualificationArtifactReceipt;
    readonly script: NativeRuntimeQualificationArtifactReceipt;
  };
  readonly runtime: {
    readonly providerId: string;
    readonly agent: string;
    readonly inference: string;
    readonly architecture: string;
    readonly acceleration: string;
    readonly rootMode: "rootless";
    readonly engineName: string;
    readonly engineVersion: string;
    readonly managedImages: readonly {
      readonly role: string;
      readonly digest: string;
    }[];
    readonly result: NativeRuntimeQualificationArtifactReceipt;
  };
  readonly operations: readonly {
    readonly id: NativeRuntimeQualificationObligation;
    readonly artifact: NativeRuntimeQualificationArtifactReceipt;
  }[];
  readonly nvidiaCdi?: {
    readonly device: "nvidia.com/gpu=all";
    readonly artifact: NativeRuntimeQualificationArtifactReceipt;
  };
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, keys: readonly string[], label: string): void {
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

function readBoundedBytes(file: string, maximum = MAX_RECEIPT_BYTES): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size < 1 || status.size > maximum) {
      throw new Error(`Native runtime qualification receipt is missing or invalid: ${file}`);
    }
    const bytes = readFileSync(descriptor);
    if (FORBIDDEN_RECEIPT_TEXT.test(bytes.toString("utf8"))) {
      throw new Error(`Native runtime qualification receipt contains credential material: ${file}`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Native runtime qualification")) {
      throw error;
    }
    throw new Error(`Native runtime qualification receipt is missing or invalid: ${file}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJsonBytes(bytes: Buffer, file: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
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
): Readonly<Record<(typeof EXPECTED_INSTALLER_FILES)[number], Buffer>> {
  validateDirectory(directory, EXPECTED_INSTALLER_FILES);
  const receipts = Object.fromEntries(
    EXPECTED_INSTALLER_FILES.map((file) => [
      file,
      readBoundedBytes(
        path.join(directory, file),
        file === "installer.sh" ? MAX_INSTALLER_BYTES : MAX_RECEIPT_BYTES,
      ),
    ]),
  ) as Record<(typeof EXPECTED_INSTALLER_FILES)[number], Buffer>;
  const invocation = record(
    parseJsonBytes(receipts["invocation.json"], "invocation.json"),
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
    parseJsonBytes(receipts["architecture.json"], "architecture.json"),
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
    parseJsonBytes(receipts["candidate-source.json"], "candidate-source.json"),
    "Installer candidate source",
  );
  const installed = record(
    parseJsonBytes(receipts["installed-source.json"], "installed-source.json"),
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
    parseJsonBytes(receipts["docker-absence.json"], "docker-absence.json"),
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
  const installer = receipts["installer.sh"];
  if (
    !installer.toString("utf8").startsWith("#!/") ||
    createHash("sha256").update(installer).digest("hex") !== row.installerSha256
  ) {
    throw new Error("Native runtime qualification installer receipt is invalid");
  }
  return Object.freeze(receipts);
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

function expectedCaseFiles(row: NativeRuntimeQualificationProducerPlanRow): string[] {
  return [
    DETAIL_FILE,
    EXECUTION_FILE,
    RUNTIME_FILE,
    ...row.case.obligations.map(nativeRuntimeQualificationOperationFile),
    ...(row.case.acceleration === "nvidia-gpu" ? [CDI_FILE] : []),
  ];
}

function validateEvidencePayload(
  bytes: Buffer,
  file: string,
  expected: {
    readonly caseId: string;
    readonly kind: string;
    readonly operationId?: string;
  },
): void {
  const value = record(parseJsonBytes(bytes, file), `Candidate evidence '${path.basename(file)}'`);
  exactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "caseId",
      ...(expected.operationId ? ["operationId"] : []),
      "result",
      "details",
    ],
    `Candidate evidence '${path.basename(file)}'`,
  );
  record(value.details, `Candidate evidence '${path.basename(file)}' details`);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== expected.kind ||
    value.caseId !== expected.caseId ||
    value.result !== "passed" ||
    (expected.operationId !== undefined && value.operationId !== expected.operationId)
  ) {
    throw new Error(`Native runtime qualification candidate evidence is invalid: ${file}`);
  }
}

function validateCandidateDetails(
  row: NativeRuntimeQualificationProducerPlanRow,
  directory: string,
): {
  readonly details: CandidateCaseDetails;
  readonly receipts: Readonly<Record<string, Buffer>>;
} {
  const expectedFiles = expectedCaseFiles(row);
  validateDirectory(directory, expectedFiles);
  const receipts = Object.fromEntries(
    expectedFiles.map((file) => [file, readBoundedBytes(path.join(directory, file))]),
  ) as Record<string, Buffer>;
  const details = record(
    parseJsonBytes(receipts[DETAIL_FILE]!, DETAIL_FILE),
    "Candidate case details",
  );
  exactKeys(
    details,
    [
      "schemaVersion",
      "kind",
      "caseId",
      "runtime",
      "operations",
      ...(row.case.acceleration === "nvidia-gpu" ? ["nvidiaCdi"] : []),
    ],
    "Candidate case details",
  );
  const runtime = record(details.runtime, "Candidate runtime details");
  exactKeys(
    runtime,
    ["engineName", "engineVersion", "managedImages", "resultFile"],
    "Candidate runtime details",
  );
  if (
    details.schemaVersion !== 1 ||
    details.kind !== "nemoclaw-native-runtime-qualification-case-details-v1" ||
    details.caseId !== row.id ||
    typeof runtime.engineName !== "string" ||
    !SAFE_ENGINE.test(runtime.engineName) ||
    typeof runtime.engineVersion !== "string" ||
    !SAFE_ENGINE.test(runtime.engineVersion) ||
    runtime.resultFile !== RUNTIME_FILE ||
    !Array.isArray(runtime.managedImages) ||
    runtime.managedImages.length < 2 ||
    runtime.managedImages.length > 8
  ) {
    throw new Error("Native runtime qualification candidate runtime details are invalid");
  }
  const roles = new Set<string>();
  for (const entry of runtime.managedImages) {
    const image = record(entry, "Candidate managed image");
    exactKeys(image, ["role", "digest"], "Candidate managed image");
    if (
      typeof image.role !== "string" ||
      !/^[a-z][a-z0-9-]{0,62}$/u.test(image.role) ||
      roles.has(image.role) ||
      typeof image.digest !== "string" ||
      !IMAGE_DIGEST.test(image.digest)
    ) {
      throw new Error("Native runtime qualification candidate managed image is invalid");
    }
    roles.add(image.role);
  }
  if (
    !Array.isArray(details.operations) ||
    details.operations.length !== row.case.obligations.length
  ) {
    throw new Error("Native runtime qualification candidate operations are incomplete");
  }
  const expectedOperations = row.case.obligations.map((id) => ({
    id,
    file: nativeRuntimeQualificationOperationFile(id),
  }));
  for (const [index, entry] of details.operations.entries()) {
    const operation = record(entry, "Candidate operation detail");
    exactKeys(operation, ["id", "file"], "Candidate operation detail");
    if (
      operation.id !== expectedOperations[index]?.id ||
      operation.file !== expectedOperations[index]?.file
    ) {
      throw new Error(
        "Native runtime qualification candidate operations do not match the trusted plan",
      );
    }
    const file = String(operation.file);
    validateEvidencePayload(receipts[file]!, file, {
      caseId: row.id,
      kind: "nemoclaw-native-runtime-qualification-operation-v1",
      operationId: String(operation.id),
    });
  }
  validateEvidencePayload(receipts[RUNTIME_FILE]!, RUNTIME_FILE, {
    caseId: row.id,
    kind: "nemoclaw-native-runtime-qualification-runtime-v1",
  });
  if (row.case.acceleration === "nvidia-gpu") {
    const cdi = record(details.nvidiaCdi, "Candidate NVIDIA CDI details");
    exactKeys(cdi, ["device", "file"], "Candidate NVIDIA CDI details");
    if (cdi.device !== "nvidia.com/gpu=all" || cdi.file !== CDI_FILE) {
      throw new Error("Native runtime qualification candidate NVIDIA CDI details are invalid");
    }
    validateEvidencePayload(receipts[CDI_FILE]!, CDI_FILE, {
      caseId: row.id,
      kind: "nemoclaw-native-runtime-qualification-nvidia-cdi-v1",
    });
  }
  return Object.freeze({
    details: details as unknown as CandidateCaseDetails,
    receipts: Object.freeze(receipts),
  });
}

function receiptPath(caseId: string, category: string, file: string): string {
  return `receipts/${caseId}/${category}/${file}`;
}

function copyReceipt(
  bytes: Buffer,
  outputRoot: string,
  relativePath: string,
): NativeRuntimeQualificationArtifactReceipt {
  const target = path.join(outputRoot, relativePath);
  const parent = path.dirname(target);
  mkdirSync(parent, { mode: 0o700, recursive: true });
  writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
  return Object.freeze({
    path: relativePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

export function writeNativeRuntimeQualificationProducerEvidence(
  row: NativeRuntimeQualificationProducerPlanRow,
  installerReceiptDirectory: string,
  executionReceiptPath: string,
  evidenceDirectory: string,
): void {
  const installerBytes = validateInstallerReceipts(row, installerReceiptDirectory);
  const executionDirectory = path.dirname(executionReceiptPath);
  if (path.basename(executionReceiptPath) !== EXECUTION_FILE) {
    throw new Error("Native runtime qualification execution receipt path is invalid");
  }
  const candidate = validateCandidateDetails(row, executionDirectory);
  validateCaseExecution(row, parseJsonBytes(candidate.receipts[EXECUTION_FILE]!, EXECUTION_FILE));
  const { details } = candidate;
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

  const installerReceipts = Object.fromEntries(
    EXPECTED_INSTALLER_FILES.map((file) => [
      file,
      copyReceipt(installerBytes[file], evidenceDirectory, receiptPath(row.id, "installer", file)),
    ]),
  ) as Record<(typeof EXPECTED_INSTALLER_FILES)[number], NativeRuntimeQualificationArtifactReceipt>;
  const runtimeReceipt = copyReceipt(
    candidate.receipts[RUNTIME_FILE]!,
    evidenceDirectory,
    receiptPath(row.id, "runtime", RUNTIME_FILE),
  );
  const operations = row.case.obligations.map((id) => {
    const file = nativeRuntimeQualificationOperationFile(id);
    return Object.freeze({
      id,
      artifact: copyReceipt(
        candidate.receipts[file]!,
        evidenceDirectory,
        receiptPath(row.id, "operations", file),
      ),
    });
  });
  const cdiReceipt =
    row.case.acceleration === "nvidia-gpu"
      ? copyReceipt(
          candidate.receipts[CDI_FILE]!,
          evidenceDirectory,
          receiptPath(row.id, "runtime", CDI_FILE),
        )
      : undefined;
  const providerId = NATIVE_RUNTIME_QUALIFICATION_PROVIDER_ID;
  const fragment: NativeRuntimeQualificationCaseFragment = Object.freeze({
    schemaVersion: 1,
    kind: "nemoclaw-native-runtime-qualification-case-fragment-v1",
    qualificationId: NATIVE_RUNTIME_QUALIFICATION_ID,
    providerId,
    source: row.source,
    case: row.case,
    installer: Object.freeze({
      providerId,
      architecture: row.case.architecture,
      dockerAvailability: "unavailable",
      exitCode: 0,
      invocation: installerReceipts["invocation.json"],
      script: installerReceipts["installer.sh"],
    }),
    runtime: Object.freeze({
      providerId,
      agent: row.case.agent,
      inference: row.case.inference,
      architecture: row.case.architecture,
      acceleration: row.case.acceleration,
      rootMode: "rootless",
      engineName: details.runtime.engineName,
      engineVersion: details.runtime.engineVersion,
      managedImages: Object.freeze(
        details.runtime.managedImages.map((entry) => Object.freeze({ ...entry })),
      ),
      result: runtimeReceipt,
    }),
    operations: Object.freeze(operations),
    ...(cdiReceipt
      ? {
          nvidiaCdi: Object.freeze({
            device: "nvidia.com/gpu=all" as const,
            artifact: cdiReceipt,
          }),
        }
      : {}),
  });
  writeFileSync(
    path.join(evidenceDirectory, "case-fragment.json"),
    `${JSON.stringify(fragment)}\n`,
    {
      mode: 0o600,
      flag: "wx",
    },
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
