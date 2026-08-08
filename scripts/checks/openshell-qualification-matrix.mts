// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const TOKEN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]{1,2048}$/u;
const MAX_DOMAIN_VALUES = 128;
export const QUALIFICATION_MAX_MATRIX_CELLS = 4_096;
export const QUALIFICATION_MAX_AGGREGATE_MATRIX_CELLS = 2_048;
export const QUALIFICATION_MAX_AGGREGATE_CELL_BYTES = 1024 * 1024;

export type QualificationExpectedOutcome = "known-failure" | "pass";
export type QualificationObservedOutcome = QualificationExpectedOutcome | "not-applicable";

export type QualificationRuntimeVersion = {
  commitSha: string;
  version: string;
};

export type QualificationPlatform = {
  accelerator: string;
  architecture: string;
  id: string;
  operatingSystem: string;
};

export type QualificationMatrixLane = {
  agents: string[];
  artifactComponents: string[];
  behaviors: string[];
  expectedOutcome: QualificationExpectedOutcome;
  id: string;
  paths: string[];
  platforms: QualificationPlatform[];
  runtimes: string[];
  runtimeVersions: QualificationRuntimeVersion[];
};

export type QualificationMatrix = {
  lanes: QualificationMatrixLane[];
};

export type QualificationCellIdentity = {
  agent: string;
  behavior: string;
  laneId: string;
  path: string;
  platformId: string;
  runtime: string;
  runtimeVersion: string;
};

export type QualificationApprovedException = QualificationCellIdentity & {
  approvalUrl: string;
  approvedBy: string;
  reason: string;
};

export type QualificationCellResult = QualificationCellIdentity & {
  artifactComponents: string[];
  evidenceUrl: string;
  exception: QualificationApprovedException | null;
  observedOutcome: QualificationObservedOutcome;
  result: "skipped" | "success";
};

function fail(message: string): never {
  throw new Error(`OpenShell qualification contract failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has an unexpected schema`);
  }
}

function validateToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) fail(`${label} is invalid`);
  return value;
}

function validateSafeText(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_TEXT_PATTERN.test(value)) fail(`${label} is invalid`);
  return value;
}

function validateTokenArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_DOMAIN_VALUES) {
    fail(`${label} must be a bounded array`);
  }
  const entries = value.map((entry, index) => validateToken(entry, `${label}[${index}]`));
  if (new Set(entries).size !== entries.length) fail(`${label} contains duplicates`);
  return entries;
}

function validateRuntimeVersion(value: unknown, label: string): QualificationRuntimeVersion {
  if (!isRecord(value)) fail(`${label} is not an object`);
  assertExactKeys(value, ["commitSha", "version"], label);
  if (typeof value.commitSha !== "string" || !SHA_PATTERN.test(value.commitSha)) {
    fail(`${label} commitSha is invalid`);
  }
  if (typeof value.version !== "string" || !SEMVER_PATTERN.test(value.version)) {
    fail(`${label} version is invalid`);
  }
  return {
    commitSha: value.commitSha,
    version: value.version,
  };
}

function validatePlatform(value: unknown, label: string): QualificationPlatform {
  if (!isRecord(value)) fail(`${label} is not an object`);
  assertExactKeys(value, ["accelerator", "architecture", "id", "operatingSystem"], label);
  return {
    accelerator: validateToken(value.accelerator, `${label} accelerator`),
    architecture: validateToken(value.architecture, `${label} architecture`),
    id: validateToken(value.id, `${label} id`),
    operatingSystem: validateToken(value.operatingSystem, `${label} operatingSystem`),
  };
}

function validateMatrixLane(value: unknown, label: string): QualificationMatrixLane {
  if (!isRecord(value)) fail(`${label} is not an object`);
  assertExactKeys(
    value,
    [
      "agents",
      "artifactComponents",
      "behaviors",
      "expectedOutcome",
      "id",
      "paths",
      "platforms",
      "runtimes",
      "runtimeVersions",
    ],
    label,
  );
  if (!Array.isArray(value.platforms) || value.platforms.length > MAX_DOMAIN_VALUES) {
    fail(`${label} platforms must be a bounded array`);
  }
  if (!Array.isArray(value.runtimeVersions) || value.runtimeVersions.length > MAX_DOMAIN_VALUES) {
    fail(`${label} runtimeVersions must be a bounded array`);
  }
  const platforms = value.platforms.map((entry, index) =>
    validatePlatform(entry, `${label} platforms[${index}]`),
  );
  const runtimeVersions = value.runtimeVersions.map((entry, index) =>
    validateRuntimeVersion(entry, `${label} runtimeVersions[${index}]`),
  );
  if (new Set(platforms.map((entry) => entry.id)).size !== platforms.length) {
    fail(`${label} platform IDs are duplicated`);
  }
  if (new Set(runtimeVersions.map((entry) => entry.version)).size !== runtimeVersions.length) {
    fail(`${label} runtime versions are duplicated`);
  }
  if (value.expectedOutcome !== "pass" && value.expectedOutcome !== "known-failure") {
    fail(`${label} expectedOutcome is invalid`);
  }
  return {
    agents: validateTokenArray(value.agents, `${label} agents`),
    artifactComponents: validateTokenArray(value.artifactComponents, `${label} artifactComponents`),
    behaviors: validateTokenArray(value.behaviors, `${label} behaviors`),
    expectedOutcome: value.expectedOutcome,
    id: validateToken(value.id, `${label} id`),
    paths: validateTokenArray(value.paths, `${label} paths`),
    platforms,
    runtimes: validateTokenArray(value.runtimes, `${label} runtimes`),
    runtimeVersions,
  };
}

export function validateQualificationMatrix(value: unknown, testId: string): QualificationMatrix {
  const label = `qualification test ${testId} matrix`;
  if (!isRecord(value)) fail(`${label} is not an object`);
  assertExactKeys(value, ["lanes"], label);
  if (!Array.isArray(value.lanes) || value.lanes.length > MAX_DOMAIN_VALUES) {
    fail(`${label} lanes must be a bounded array`);
  }
  const lanes = value.lanes.map((entry, index) =>
    validateMatrixLane(entry, `${label} lanes[${index}]`),
  );
  if (new Set(lanes.map((lane) => lane.id)).size !== lanes.length) {
    fail(`${label} lane IDs are duplicated`);
  }
  return { lanes };
}

function cellKey(cell: QualificationCellIdentity): string {
  return [
    cell.laneId,
    cell.runtime,
    cell.path,
    cell.runtimeVersion,
    cell.agent,
    cell.behavior,
    cell.platformId,
  ].join("\u0000");
}

export function expandQualificationMatrix(
  matrix: QualificationMatrix,
  testId: string,
): QualificationCellIdentity[] {
  const cells: QualificationCellIdentity[] = [];
  for (const lane of matrix.lanes)
    for (const runtime of lane.runtimes)
      for (const path of lane.paths)
        for (const runtimeVersion of lane.runtimeVersions)
          for (const agent of lane.agents)
            for (const behavior of lane.behaviors)
              for (const platform of lane.platforms) {
                cells.push({
                  agent,
                  behavior,
                  laneId: lane.id,
                  path,
                  platformId: platform.id,
                  runtime,
                  runtimeVersion: runtimeVersion.version,
                });
                if (cells.length > QUALIFICATION_MAX_MATRIX_CELLS) {
                  fail(
                    `qualification test ${testId} matrix exceeds ${QUALIFICATION_MAX_MATRIX_CELLS} cells`,
                  );
                }
              }
  return cells;
}

export function requireCompleteQualificationMatrix(
  matrix: QualificationMatrix,
  testId: string,
): void {
  if (matrix.lanes.length === 0) fail(`qualification test ${testId} frozen matrix has no lanes`);
  for (const lane of matrix.lanes) {
    for (const [name, values] of Object.entries({
      agents: lane.agents,
      artifactComponents: lane.artifactComponents,
      behaviors: lane.behaviors,
      paths: lane.paths,
      platforms: lane.platforms,
      runtimes: lane.runtimes,
      runtimeVersions: lane.runtimeVersions,
    })) {
      if (values.length === 0) {
        fail(`qualification test ${testId} frozen matrix lane ${lane.id} has no ${name}`);
      }
    }
  }
  expandQualificationMatrix(matrix, testId);
}

function validateApprovalUrl(value: unknown, repository: string, label: string): string {
  const source = validateSafeText(value, label);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    fail(`${label} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    !/^#issuecomment-[1-9][0-9]*$/u.test(url.hash) ||
    !new RegExp(`^/${repository.replace("/", "\\/")}/(?:issues|pull)/[1-9][0-9]*$`, "u").test(
      url.pathname,
    )
  ) {
    fail(`${label} is not an exact repository approval comment URL`);
  }
  return source;
}

function validateCellIdentity(
  value: Record<string, unknown>,
  label: string,
): QualificationCellIdentity {
  return {
    agent: validateToken(value.agent, `${label} agent`),
    behavior: validateToken(value.behavior, `${label} behavior`),
    laneId: validateToken(value.laneId, `${label} laneId`),
    path: validateToken(value.path, `${label} path`),
    platformId: validateToken(value.platformId, `${label} platformId`),
    runtime: validateToken(value.runtime, `${label} runtime`),
    runtimeVersion: validateSafeText(value.runtimeVersion, `${label} runtimeVersion`),
  };
}

export function validateQualificationApprovedExceptions(
  value: unknown,
  matrix: QualificationMatrix,
  repository: string,
  testId: string,
): QualificationApprovedException[] {
  const label = `qualification test ${testId} approvedExceptions`;
  if (!Array.isArray(value) || value.length > QUALIFICATION_MAX_MATRIX_CELLS) {
    fail(`${label} must be a bounded array`);
  }
  const expectedCells = new Set(expandQualificationMatrix(matrix, testId).map(cellKey));
  const exceptions = value.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!isRecord(entry)) fail(`${entryLabel} is not an object`);
    assertExactKeys(
      entry,
      [
        "agent",
        "approvalUrl",
        "approvedBy",
        "behavior",
        "laneId",
        "path",
        "platformId",
        "reason",
        "runtime",
        "runtimeVersion",
      ],
      entryLabel,
    );
    const identity = validateCellIdentity(entry, entryLabel);
    if (!expectedCells.has(cellKey(identity))) fail(`${entryLabel} does not name a required cell`);
    const approvedBy = validateToken(entry.approvedBy, `${entryLabel} approvedBy`);
    const reason = validateSafeText(entry.reason, `${entryLabel} reason`);
    return {
      ...identity,
      approvalUrl: validateApprovalUrl(entry.approvalUrl, repository, `${entryLabel} approvalUrl`),
      approvedBy,
      reason,
    };
  });
  if (new Set(exceptions.map(cellKey)).size !== exceptions.length) {
    fail(`${label} contains duplicated cells`);
  }
  return exceptions;
}

function validateEvidenceUrl(value: unknown, repository: string, label: string): string {
  const source = validateSafeText(value, label);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    fail(`${label} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new RegExp(
      `^/${repository.replace("/", "\\/")}/actions/runs/[1-9][0-9]*/job/[1-9][0-9]*$`,
      "u",
    ).test(url.pathname)
  ) {
    fail(`${label} is not an exact source job URL`);
  }
  return source;
}

function validateCellException(
  value: unknown,
  expected: QualificationApprovedException,
  label: string,
): QualificationApprovedException {
  if (!isRecord(value)) fail(`${label} is not an object`);
  assertExactKeys(
    value,
    [
      "agent",
      "approvalUrl",
      "approvedBy",
      "behavior",
      "laneId",
      "path",
      "platformId",
      "reason",
      "runtime",
      "runtimeVersion",
    ],
    label,
  );
  const identity = validateCellIdentity(value, label);
  if (
    JSON.stringify(identity) !==
      JSON.stringify({
        agent: expected.agent,
        behavior: expected.behavior,
        laneId: expected.laneId,
        path: expected.path,
        platformId: expected.platformId,
        runtime: expected.runtime,
        runtimeVersion: expected.runtimeVersion,
      }) ||
    value.approvalUrl !== expected.approvalUrl ||
    value.approvedBy !== expected.approvedBy ||
    value.reason !== expected.reason
  ) {
    fail(`${label} is not the exact base-approved exception`);
  }
  return expected;
}

export function validateQualificationCellResults(
  value: unknown,
  matrix: QualificationMatrix,
  approvedExceptions: QualificationApprovedException[],
  repository: string,
  testId: string,
  jobUrls: ReadonlySet<string>,
): QualificationCellResult[] {
  const label = `qualification receipt test ${testId} cells`;
  if (!Array.isArray(value) || value.length > QUALIFICATION_MAX_MATRIX_CELLS) {
    fail(`${label} must be a bounded array`);
  }
  const expectedCells = expandQualificationMatrix(matrix, testId);
  const expectedByKey = new Map(expectedCells.map((cell) => [cellKey(cell), cell]));
  const exceptionsByKey = new Map(approvedExceptions.map((entry) => [cellKey(entry), entry]));
  const lanes = new Map(matrix.lanes.map((lane) => [lane.id, lane]));
  const results = value.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!isRecord(entry)) fail(`${entryLabel} is not an object`);
    assertExactKeys(
      entry,
      [
        "agent",
        "artifactComponents",
        "behavior",
        "evidenceUrl",
        "exception",
        "laneId",
        "observedOutcome",
        "path",
        "platformId",
        "result",
        "runtime",
        "runtimeVersion",
      ],
      entryLabel,
    );
    const identity = validateCellIdentity(entry, entryLabel);
    const key = cellKey(identity);
    if (!expectedByKey.has(key)) fail(`${entryLabel} does not name a required matrix cell`);
    const lane = lanes.get(identity.laneId);
    if (!lane) fail(`${entryLabel} names an unknown matrix lane`);
    const artifactComponents = validateTokenArray(
      entry.artifactComponents,
      `${entryLabel} artifactComponents`,
    );
    if (JSON.stringify(artifactComponents) !== JSON.stringify(lane.artifactComponents)) {
      fail(`${entryLabel} artifact provenance binding is mismatched`);
    }
    const approvedException = exceptionsByKey.get(key);
    if (approvedException) {
      if (
        entry.result !== "skipped" ||
        entry.observedOutcome !== "not-applicable" ||
        entry.evidenceUrl !== approvedException.approvalUrl
      ) {
        fail(`${entryLabel} does not match its approved not-applicable result`);
      }
      return {
        ...identity,
        artifactComponents,
        evidenceUrl: approvedException.approvalUrl,
        exception: validateCellException(
          entry.exception,
          approvedException,
          `${entryLabel} exception`,
        ),
        observedOutcome: "not-applicable" as const,
        result: "skipped" as const,
      };
    }
    const expectedOutcome = lane.expectedOutcome;
    if (
      entry.exception !== null ||
      entry.result !== "success" ||
      entry.observedOutcome !== expectedOutcome
    ) {
      fail(`${entryLabel} is not a successful expected matrix result`);
    }
    const evidenceUrl = validateEvidenceUrl(
      entry.evidenceUrl,
      repository,
      `${entryLabel} evidenceUrl`,
    );
    if (!jobUrls.has(evidenceUrl))
      fail(`${entryLabel} is not bound to an authenticated source job`);
    return {
      ...identity,
      artifactComponents,
      evidenceUrl,
      exception: null,
      observedOutcome: expectedOutcome,
      result: "success" as const,
    };
  });
  const resultKeys = results.map(cellKey);
  if (new Set(resultKeys).size !== resultKeys.length) fail(`${label} contains duplicated cells`);
  const expectedKeys = [...expectedByKey.keys()].sort();
  const actualKeys = [...resultKeys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    fail(`${label} is missing, extra, or mismatched`);
  }
  return results;
}

export function qualificationCellInventoryFootprint(
  matrix: QualificationMatrix,
  approvedExceptions: QualificationApprovedException[],
  repository: string,
  testId: string,
): { bytes: number; cells: number } {
  const exceptionsByKey = new Map(approvedExceptions.map((entry) => [cellKey(entry), entry]));
  const lanes = new Map(matrix.lanes.map((lane) => [lane.id, lane]));
  const projected = expandQualificationMatrix(matrix, testId).map((cell) => {
    const lane = lanes.get(cell.laneId);
    if (!lane) fail(`qualification test ${testId} matrix cell has an unknown lane`);
    const exception = exceptionsByKey.get(cellKey(cell));
    return {
      ...cell,
      artifactComponents: lane.artifactComponents,
      evidenceUrl:
        exception?.approvalUrl ??
        `https://github.com/${repository}/actions/runs/9007199254740991/job/9007199254740991`,
      exception: exception ?? null,
      observedOutcome: exception ? "not-applicable" : lane.expectedOutcome,
      result: exception ? "skipped" : "success",
    };
  });
  return {
    bytes: Buffer.byteLength(JSON.stringify(projected), "utf8"),
    cells: projected.length,
  };
}
