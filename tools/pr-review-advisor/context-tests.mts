// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildRiskPlan, type RiskPlan } from "../advisors/risk-plan.mts";

export type TestDepth = {
  verdict: "unknown" | "unit_sufficient" | "mocks_recommended" | "runtime_validation_recommended";
  rationale: string;
  suggestedTests: string[];
};

export type StaticTestInventory = {
  changedTestFiles: string[];
  nearbyTestNames: string[];
  candidateExistingCoverage: string[];
};

export function classifyTestDepth(
  changedFiles: string[],
  riskPlan: RiskPlan = buildRiskPlan({ headSha: "test-depth", changedFiles }),
  diff = "",
): TestDepth {
  const sourceFiles = changedFiles.filter((file) => !isTestFile(file));
  if (changedFiles.length === 0)
    return { verdict: "unknown", rationale: "No changed files were detected.", suggestedTests: [] };
  if (sourceFiles.length === 0 || sourceFiles.every(isDocsOrTestOnly)) {
    return {
      verdict: "unit_sufficient",
      rationale:
        "Changes are limited to tests, documentation, or metadata that cannot affect runtime behavior directly.",
      suggestedTests: ["Unit or documentation validation candidate for the touched files."],
    };
  }
  if (riskPlan.requiredJobs.length > 0 || riskPlan.requiredTargets.length > 0) {
    return {
      verdict: "runtime_validation_recommended",
      rationale: `Deterministic regression risks require live validation: ${riskPlan.families.map((family) => family.id).join(", ")}.`,
      suggestedTests: [
        ...riskPlan.requiredJobs.map(
          (job) =>
            `Existing \`${job.id}\` E2E job validation candidate for ${job.reasons.join("; ")} Matched files: ${job.matchedFiles
              .slice(0, 5)
              .map((file) => `\`${file}\``)
              .join(", ")}.`,
        ),
        ...riskPlan.requiredTargets.map(
          (target) =>
            `Existing \`${target.id}\` typed E2E target validation candidate for ${target.reasons.join("; ")} Matched files: ${target.matchedFiles
              .slice(0, 5)
              .map((file) => `\`${file}\``)
              .join(", ")}.`,
        ),
      ],
    };
  }
  const e2eSignals = sourceFiles.filter(
    (file) =>
      file === "Dockerfile" ||
      file.endsWith("Dockerfile") ||
      /(^|\/)(install|setup|brev-setup|nemoclaw-start)\.sh$/.test(file) ||
      file.startsWith("nemoclaw-blueprint/policies/") ||
      (file.startsWith("src/lib/messaging/channels/") && file.includes("/policy/")) ||
      file.startsWith("nemoclaw/src/blueprint/") ||
      file.startsWith("test/e2e/") ||
      file.includes("sandbox") ||
      file.includes("gateway") ||
      file.includes("rebuild") ||
      file.includes("snapshot"),
  );
  if (e2eSignals.length > 0) {
    return {
      verdict: "runtime_validation_recommended",
      rationale: `Runtime/sandbox/infrastructure paths need behavioral runtime validation: ${e2eSignals.slice(0, 8).join(", ")}.`,
      suggestedTests: [
        "Runtime or integration validation candidate for the changed behavior; external E2E job results are outside this context.",
      ],
    };
  }
  const runtimeBoundaryFiles = detectAddedRuntimeBoundaries(sourceFiles, diff);
  if (runtimeBoundaryFiles.length > 0) {
    return {
      verdict: "runtime_validation_recommended",
      rationale: `Changed runtime code adds a process or container boundary: ${runtimeBoundaryFiles.join(", ")}.`,
      suggestedTests: [
        "Integration validation candidate for the changed process or container behavior.",
      ],
    };
  }
  const mockSignals = sourceFiles.filter((file) =>
    /credential|session|state|config|inference|provider|http|probe|onboard/i.test(file),
  );
  if (mockSignals.length > 0) {
    return {
      verdict: "mocks_recommended",
      rationale: `Changed code has I/O, state, credentials, provider, or config behavior that should be covered with behavioral mocks: ${mockSignals.slice(0, 8).join(", ")}.`,
      suggestedTests: [
        "Behavioral validation candidate with mocked filesystem, network, or process boundaries.",
      ],
    };
  }
  return {
    verdict: "unit_sufficient",
    rationale: "Changed files look like deterministic logic that can be covered with unit tests.",
    suggestedTests: ["Targeted unit validation candidate for the changed modules."],
  };
}

export function collectStaticTestInventory(
  changedFiles: string[],
  repositoryRoot = process.cwd(),
): StaticTestInventory {
  const changedTestFiles = changedFiles.filter(isTestFile).slice(0, 40);
  const nearbyTestNames: string[] = [];
  const candidateExistingCoverage: string[] = [];
  for (const file of changedTestFiles) {
    const text = readChangedRegularFilePrefix(repositoryRoot, file, 200000);
    if (text === null) {
      candidateExistingCoverage.push(
        `${file} changed but was skipped because it is not a regular in-repository file.`,
      );
      continue;
    }
    const names = extractTestNames(text).slice(0, 20);
    nearbyTestNames.push(...names.map((name) => `${file}: ${name}`));
    candidateExistingCoverage.push(
      names.length > 0
        ? `${file} changed with ${names.length} named test block(s).`
        : `${file} changed but no describe/it/test names were detected statically.`,
    );
  }
  const sourceFiles = changedFiles.filter((file) => !isTestFile(file) && !isDocsOrTestOnly(file));
  if (sourceFiles.length > 0 && changedTestFiles.length > 0)
    candidateExistingCoverage.push(
      `Changed source files (${sourceFiles.slice(0, 8).join(", ")}) are paired with changed test files (${changedTestFiles.slice(0, 8).join(", ")}).`,
    );
  if (sourceFiles.length > 0 && changedTestFiles.length === 0)
    candidateExistingCoverage.push(
      `No changed test files were detected for changed source files: ${sourceFiles.slice(0, 8).join(", ")}.`,
    );
  return {
    changedTestFiles,
    nearbyTestNames: [...new Set(nearbyTestNames)].slice(0, 60),
    candidateExistingCoverage: [...new Set(candidateExistingCoverage)].slice(0, 40),
  };
}

function detectAddedRuntimeBoundaries(changedFiles: string[], diff: string): string[] {
  const runtimeFiles = new Set(changedFiles.filter((file) => !isDocsOrTestOnly(file)));
  const matches = new Set<string>();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      file = fileMatch[2] || null;
      continue;
    }
    if (!file || !runtimeFiles.has(file) || !line.startsWith("+") || line.startsWith("+++"))
      continue;
    if (
      /\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(|\b(?:node:)?child_process\b|\b(?:docker|openshell)\s+(?:build|create|exec|run)\b/i.test(
        line.slice(1),
      )
    )
      matches.add(file);
  }
  return [...matches].slice(0, 8);
}

function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(file) || /\.(test|spec)\.[cm]?[jt]s$/.test(file);
}

function isDocsOrTestOnly(file: string): boolean {
  return (
    isTestFile(file) ||
    /\.(md|mdx|txt)$/.test(file) ||
    file.startsWith("docs/") ||
    file.startsWith("fern/")
  );
}

function readChangedRegularFilePrefix(root: string, file: string, maxBytes: number): string | null {
  const absolutePath = path.resolve(root, file);
  if (!isPathInside(root, absolutePath)) return null;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const realPath = fs.realpathSync(absolutePath);
  if (!isPathInside(root, realPath)) return null;
  const fd = fs.openSync(realPath, "r");
  try {
    const size = Math.min(Math.max(0, maxBytes), stat.size);
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function extractTestNames(text: string): string[] {
  const names: string[] = [];
  const pattern = /\b(?:describe|it|test)\s*(?:\.\w+)?\s*\(\s*(["'\x60])([^"'\x60]{1,180})\1/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[2]?.replace(/\s+/g, " ").trim();
    if (name) names.push(name);
  }
  return names;
}
