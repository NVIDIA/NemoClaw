// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GrowthGuardrailDiff, PullRequestFile } from "./growth-guardrail-diff";

const BUDGET_FILE = "ci/test-file-size-budget.json";
const DOCKERFILE_GROWTH_EXCEPTIONS_FILE = "ci/dockerfile-growth-exceptions.json";
const FALLBACK_BUDGET = '{"defaultMaxLines":1500,"legacyMaxLines":{}}';
const JAVASCRIPT_FILE_RE = /\.(?:cjs|js|mjs)$/;
const TEST_FILE_RE = /^(?:test|src|nemoclaw\/src)\/.*\.(?:test|spec)\.(?:[cm]?[jt]s)$/;
const ONBOARD_ENTRY = "src/lib/onboard.ts";
const STOCK_DOCKERFILE = "Dockerfile";

type TestFileSizeBudget = {
  readonly defaultMaxLines: number;
  readonly legacyMaxLines: Readonly<Record<string, number>>;
};

type DockerfileGrowthException = {
  readonly pullRequest: number;
  readonly maxLines: number;
  readonly maxBytes: number;
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function countLines(text: string | null): number {
  if (text === null || text.length === 0) return 0;
  const newlineCount = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return newlineCount + (/(?:\r\n|\r|\n)$/.test(text) ? 0 : 1);
}

/** Keep the line and byte ratchets independent so same-line growth cannot bypass the budget. */
function dockerfileBudget(source: string | null): { bytes: number; lines: number } {
  return {
    bytes: source === null ? 0 : Buffer.byteLength(source, "utf8"),
    lines: countLines(source),
  };
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function parseBudget(source: string, label: string): TestFileSizeBudget {
  const parsed = JSON.parse(source) as {
    readonly defaultMaxLines?: unknown;
    readonly legacyMaxLines?: unknown;
  };
  if (
    parsed.legacyMaxLines !== undefined &&
    (typeof parsed.legacyMaxLines !== "object" ||
      parsed.legacyMaxLines === null ||
      Array.isArray(parsed.legacyMaxLines))
  ) {
    throw new Error(`${label}: legacyMaxLines must be an object when present`);
  }

  const legacyMaxLines: Record<string, number> = {};
  for (const [file, value] of Object.entries(parsed.legacyMaxLines ?? {})) {
    legacyMaxLines[file] = positiveInteger(value, `${label}: legacyMaxLines.${file}`);
  }
  return {
    defaultMaxLines: positiveInteger(parsed.defaultMaxLines, `${label}: defaultMaxLines`),
    legacyMaxLines,
  };
}

/** Parse trusted-base exceptions; malformed policy fails the guardrail closed. */
function parseDockerfileGrowthExceptions(source: string): readonly DockerfileGrowthException[] {
  const parsed = JSON.parse(source) as {
    readonly schemaVersion?: unknown;
    readonly exceptions?: unknown;
  };
  if (parsed.schemaVersion !== 1) {
    throw new Error(`${DOCKERFILE_GROWTH_EXCEPTIONS_FILE}: schemaVersion must be 1`);
  }
  if (!Array.isArray(parsed.exceptions)) {
    throw new Error(`${DOCKERFILE_GROWTH_EXCEPTIONS_FILE}: exceptions must be an array`);
  }

  const seenPullRequests = new Set<number>();
  return parsed.exceptions.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `${DOCKERFILE_GROWTH_EXCEPTIONS_FILE}: exceptions[${index}] must be an object`,
      );
    }
    const exception = value as Record<string, unknown>;
    const pullRequest = positiveInteger(
      exception.pullRequest,
      `${DOCKERFILE_GROWTH_EXCEPTIONS_FILE}: exceptions[${index}].pullRequest`,
    );
    if (seenPullRequests.has(pullRequest)) {
      throw new Error(
        `${DOCKERFILE_GROWTH_EXCEPTIONS_FILE}: duplicate exception for PR #${pullRequest}`,
      );
    }
    seenPullRequests.add(pullRequest);
    return {
      pullRequest,
      maxLines: positiveInteger(
        exception.maxLines,
        `${DOCKERFILE_GROWTH_EXCEPTIONS_FILE}: exceptions[${index}].maxLines`,
      ),
      maxBytes: positiveInteger(
        exception.maxBytes,
        `${DOCKERFILE_GROWTH_EXCEPTIONS_FILE}: exceptions[${index}].maxBytes`,
      ),
    };
  });
}

function formatList(heading: string, details: readonly string[], remediation: string): string {
  return [heading, ...details.map((detail) => `- ${detail}`), "", remediation].join("\n");
}

export function addedJavaScriptViolations(files: readonly PullRequestFile[]): string[] {
  return files
    .filter(
      ({ filename, previous_filename, status }) =>
        JAVASCRIPT_FILE_RE.test(filename) &&
        (status === "added" ||
          (status === "renamed" && !JAVASCRIPT_FILE_RE.test(previous_filename ?? ""))),
    )
    .map(({ filename }) => filename);
}

export async function onboardGrowthViolations(diff: GrowthGuardrailDiff): Promise<string[]> {
  const changed = diff.files.some(
    ({ filename, previous_filename }) =>
      filename === ONBOARD_ENTRY || previous_filename === ONBOARD_ENTRY,
  );
  if (!changed) return [];
  const [base, head] = await Promise.all([
    diff.readBase([ONBOARD_ENTRY]),
    diff.readHead([ONBOARD_ENTRY]),
  ]);
  const baseLines = countLines(base.get(ONBOARD_ENTRY) ?? null);
  const headLines = countLines(head.get(ONBOARD_ENTRY) ?? null);
  return headLines > baseLines ? [`${ONBOARD_ENTRY} grew by ${headLines - baseLines} line(s)`] : [];
}

/** Report root Dockerfile growth while its host-side stock onboarding fallback is deprecated. */
export async function dockerfileBudgetGrowthViolations(
  diff: GrowthGuardrailDiff,
): Promise<string[]> {
  const changed = diff.files.some(
    ({ filename, previous_filename }) =>
      filename === STOCK_DOCKERFILE || previous_filename === STOCK_DOCKERFILE,
  );
  if (!changed) return [];
  const [base, head] = await Promise.all([
    diff.readBase([STOCK_DOCKERFILE, DOCKERFILE_GROWTH_EXCEPTIONS_FILE]),
    diff.readHead([STOCK_DOCKERFILE]),
  ]);
  const baseBudget = dockerfileBudget(base.get(STOCK_DOCKERFILE) ?? null);
  const headBudget = dockerfileBudget(head.get(STOCK_DOCKERFILE) ?? null);
  const exceptionsSource = base.get(DOCKERFILE_GROWTH_EXCEPTIONS_FILE);
  const exception =
    diff.pullRequestNumber === null || exceptionsSource === null || exceptionsSource === undefined
      ? undefined
      : parseDockerfileGrowthExceptions(exceptionsSource).find(
          ({ pullRequest }) => pullRequest === diff.pullRequestNumber,
        );
  const maxLines = Math.max(baseBudget.lines, exception?.maxLines ?? baseBudget.lines);
  const maxBytes = Math.max(baseBudget.bytes, exception?.maxBytes ?? baseBudget.bytes);
  const violations: string[] = [];
  if (headBudget.lines > maxLines) {
    violations.push(
      exception
        ? `${STOCK_DOCKERFILE} line budget exceeded the PR #${exception.pullRequest} maximum of ${maxLines} with ${headBudget.lines}`
        : `${STOCK_DOCKERFILE} line budget increased from ${baseBudget.lines} to ${headBudget.lines}`,
    );
  }
  if (headBudget.bytes > maxBytes) {
    violations.push(
      exception
        ? `${STOCK_DOCKERFILE} byte budget exceeded the PR #${exception.pullRequest} maximum of ${maxBytes} with ${headBudget.bytes}`
        : `${STOCK_DOCKERFILE} byte budget increased from ${baseBudget.bytes} to ${headBudget.bytes}`,
    );
  }
  return violations;
}

export async function testSizeViolations(diff: GrowthGuardrailDiff): Promise<string[]> {
  const budgetChanged = diff.files.some(
    ({ filename, previous_filename }) =>
      filename === BUDGET_FILE || previous_filename === BUDGET_FILE,
  );
  const changedTests = diff.files
    .filter(({ filename, status }) => status !== "removed" && TEST_FILE_RE.test(filename))
    .map(({ filename }) => filename);
  const baseBudgetBlob = await diff.readBase([BUDGET_FILE]);
  const baseBudget = parseBudget(baseBudgetBlob.get(BUDGET_FILE) ?? FALLBACK_BUDGET, "base budget");
  const headBudgetBlob = budgetChanged ? await diff.readHead([BUDGET_FILE]) : null;
  const headBudget = budgetChanged
    ? parseBudget(
        headBudgetBlob?.get(BUDGET_FILE) ??
          (() => {
            throw new Error(`${BUDGET_FILE} must remain present`);
          })(),
        "head budget",
      )
    : baseBudget;
  const renames = new Map(
    diff.files.flatMap(({ filename, previous_filename }) =>
      previous_filename && previous_filename !== filename ? [[filename, previous_filename]] : [],
    ),
  );
  const headPaths = unique([
    ...Object.keys(headBudget.legacyMaxLines),
    ...Object.keys(baseBudget.legacyMaxLines).filter(
      (file) => headBudget.legacyMaxLines[file] === undefined,
    ),
    ...changedTests,
  ]);
  const head = await diff.readHead(headPaths);
  const violations: string[] = [];

  if (headBudget.defaultMaxLines > baseBudget.defaultMaxLines) {
    violations.push(
      `defaultMaxLines increased from ${baseBudget.defaultMaxLines} to ${headBudget.defaultMaxLines}`,
    );
  }
  for (const [file, headMax] of Object.entries(headBudget.legacyMaxLines)) {
    const baseMax = baseBudget.legacyMaxLines[renames.get(file) ?? file];
    if (baseMax === undefined && headMax > headBudget.defaultMaxLines) {
      violations.push(`${file} adds a legacy budget above the default`);
    }
    if (baseMax !== undefined && headMax > baseMax) {
      violations.push(`${file} legacy budget increased from ${baseMax} to ${headMax}`);
    }
    const source = head.get(file);
    if (source === null || source === undefined) {
      violations.push(`${file} no longer exists; remove its legacy budget ${headMax}`);
      continue;
    }
    const lines = countLines(source);
    if (lines > headMax) violations.push(`${file} has ${lines} lines, above its budget ${headMax}`);
    if (lines < headMax) violations.push(`${file} has ${lines} lines; lower its budget ${headMax}`);
  }
  for (const file of Object.keys(baseBudget.legacyMaxLines)) {
    const carried = [...renames.entries()].some(
      ([headPath, basePath]) =>
        basePath === file && headBudget.legacyMaxLines[headPath] !== undefined,
    );
    if (
      headBudget.legacyMaxLines[file] === undefined &&
      !carried &&
      countLines(head.get(file) ?? null) > headBudget.defaultMaxLines
    ) {
      violations.push(`${file} removed its legacy budget while still above the default`);
    }
  }
  for (const file of changedTests) {
    if (headBudget.legacyMaxLines[file] !== undefined) continue;
    const source = head.get(file);
    if (source === null || source === undefined) {
      violations.push(`${file} was not found at the latest PR commit`);
      continue;
    }
    const lines = countLines(source);
    const max = headBudget.legacyMaxLines[file] ?? headBudget.defaultMaxLines;
    if (lines > max) violations.push(`${file} has ${lines} lines, above its budget ${max}`);
  }
  return violations;
}

function dockerfileBudgetDiagnostic(details: readonly string[]): string {
  return formatList(
    "The root Dockerfile budget grew.",
    details,
    "Host-side stock Dockerfile onboarding is deprecated. Keep the root Dockerfile at or below its existing line and byte budgets. Move new onboarding behavior to the managed-image startup profile, bootstrap, or runtime-provider path, or record a maintainer decision before increasing this budget.",
  );
}

export const diagnostics = {
  javascript: (details: readonly string[]) =>
    formatList(
      "This change adds JavaScript files.",
      details,
      "Use TypeScript for new source, test, and script files.",
    ),
  onboard: (details: readonly string[]) =>
    formatList(
      "The onboarding entry point grew.",
      details,
      "Move new behavior into a focused module under src/lib/onboard/.",
    ),
  dockerfileBudget: dockerfileBudgetDiagnostic,
  size: (details: readonly string[]) =>
    formatList(
      "The test file size budget was exceeded or weakened.",
      details,
      "Split oversized tests, and lower legacy budgets when files shrink.",
    ),
};
