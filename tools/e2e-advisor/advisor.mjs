#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "yaml";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const baseRef = args.base || process.env.GITHUB_BASE_REF || process.env.BASE_REF || "origin/main";
const headRef = args.head || process.env.GITHUB_HEAD_REF || process.env.HEAD_REF || "HEAD";
const manifestPath = args.manifest || "test/e2e/e2e-manifest.yaml";
const rulesPath = args.rules || "tools/e2e-advisor/rules.yaml";
const outDir = args.outDir || "artifacts/e2e-advisor";

fs.mkdirSync(outDir, { recursive: true });

const manifest = readYaml(manifestPath);
const policy = readYaml(rulesPath);
let changedFiles;
try {
  changedFiles = getChangedFiles(baseRef, headRef);
} catch (error) {
  console.error(`E2E Advisor could not compute changed files: ${error.message}`);
  process.exit(1);
}
const input = {
  version: 1,
  baseRef,
  headRef,
  changedFiles,
  manifestPath,
  rulesPath,
};

const testById = new Map((manifest.tests || []).map((test) => [test.id, test]));
const classifiedDomains = [];
const required = new Map();
const optional = new Map();
const gaps = new Map();

for (const rule of policy.rules || []) {
  const matchedFiles = changedFiles.filter((file) => matchesRule(rule, file));
  if (matchedFiles.length === 0) {
    continue;
  }

  classifiedDomains.push({
    domain: rule.domain,
    reason: rule.reason,
    confidence: rule.confidence || "medium",
    matchedFiles,
  });

  addRecommendations(required, rule.required_tests, rule.reason, testById);
  addRecommendations(optional, rule.optional_tests, rule.reason, testById);

  if (rule.gap_if_missing) {
    const gap = policy.gaps?.[rule.gap_if_missing];
    if (gap) {
      gaps.set(rule.gap_if_missing, {
        domain: gap.domain || rule.domain,
        reason: gap.reason,
        suggestedTest: gap.suggested_test,
        priority: gap.priority || "medium",
      });
    }
  }
}

for (const id of required.keys()) {
  optional.delete(id);
}

const onlyDocsOrTests = changedFiles.length > 0 && changedFiles.every((file) =>
  /^(docs\/|README\.md$|CHANGELOG\.md$|test\/|\.github\/workflows\/docs-|tools\/e2e-advisor\/|test\/e2e\/e2e-manifest\.yaml$)/.test(file),
);
const noE2eReason = required.size === 0
  ? (changedFiles.length === 0
      ? "No changed files were detected against the selected base."
      : onlyDocsOrTests
        ? "No production runtime paths changed; advisor found only docs/test/advisor metadata changes."
        : "No deterministic E2E rule matched this change. Review optional tests and consider unit/integration coverage.")
  : null;

const result = {
  version: 1,
  baseRef,
  headRef,
  changedFiles,
  classifiedDomains,
  requiredTests: [...required.values()],
  optionalTests: [...optional.values()],
  newE2eRecommendations: [...gaps.values()],
  noE2eReason,
  confidence: chooseConfidence(classifiedDomains, required.size),
};

if (result.requiredTests.some((test) => test.workflow === "nightly-e2e")) {
  const jobs = result.requiredTests
    .filter((test) => test.workflow === "nightly-e2e")
    .map((test) => test.job || test.id)
    .filter(Boolean);
  result.dispatchHint = {
    workflow: manifest.workflows?.["nightly-e2e"]?.path || ".github/workflows/nightly-e2e.yaml",
    jobsInput: [...new Set(jobs)].join(","),
  };
}

const markdown = renderMarkdown(result);
fs.writeFileSync(path.join(outDir, "e2e-advisor-input.json"), `${JSON.stringify(input, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "e2e-advisor-result.json"), `${JSON.stringify(result, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "e2e-advisor-summary.md"), markdown);

console.log(markdown);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      parsed[key] = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function readYaml(relativePath) {
  const fullPath = path.resolve(root, relativePath);
  return yaml.parse(fs.readFileSync(fullPath, "utf8"));
}

function getChangedFiles(base, head) {
  const candidates = [
    ["diff", "--name-only", `${base}...${head}`],
    ["diff", "--name-only", `${base}..${head}`],
  ];
  for (const command of candidates) {
    try {
      const stdout = execFileSync("git", command, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
      return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
    } catch {
      // Try next diff form. GitHub shallow checkouts may not have merge-base.
    }
  }
  throw new Error(`failed to diff ${base}..${head}; ensure both refs are fetched`);
}

function matchesRule(rule, file) {
  return [...(rule.any || [])].some((pattern) => new RegExp(pattern).test(file));
}

function addRecommendations(target, ids = [], reason, testByIdMap) {
  for (const id of ids || []) {
    const test = testByIdMap.get(id);
    if (!test) {
      target.set(id, { id, reason: `${reason} (manifest entry missing; verify inventory)` });
      continue;
    }
    target.set(id, {
      id,
      reason,
      workflow: test.workflow,
      job: test.job,
      script: test.script,
      cost: test.cost,
      runner: test.runner,
    });
  }
}

function chooseConfidence(domains, requiredCount) {
  if (domains.some((domain) => domain.confidence === "high") && requiredCount > 0) {
    return "high";
  }
  if (domains.length > 0) {
    return "medium";
  }
  return "low";
}

function renderMarkdown(result) {
  const lines = [];
  lines.push("# E2E Advisor");
  lines.push("");
  lines.push(`Base: \`${result.baseRef}\`  `);
  lines.push(`Head: \`${result.headRef}\`  `);
  lines.push(`Confidence: **${result.confidence}**`);
  lines.push("");

  lines.push("## Changed files");
  if (result.changedFiles.length === 0) {
    lines.push("- _None detected_");
  } else {
    for (const file of result.changedFiles) {
      lines.push(`- \`${file}\``);
    }
  }
  lines.push("");

  lines.push("## Classified risk domains");
  if (result.classifiedDomains.length === 0) {
    lines.push("- _No deterministic domains matched._");
  } else {
    for (const domain of result.classifiedDomains) {
      lines.push(`- **${domain.domain}** (${domain.confidence}): ${domain.reason}`);
      for (const file of domain.matchedFiles.slice(0, 8)) {
        lines.push(`  - \`${file}\``);
      }
      if (domain.matchedFiles.length > 8) {
        lines.push(`  - _${domain.matchedFiles.length - 8} more_`);
      }
    }
  }
  lines.push("");

  lines.push("## Required E2E");
  if (result.requiredTests.length === 0) {
    lines.push(`- _None._ ${result.noE2eReason || ""}`.trim());
  } else {
    for (const test of result.requiredTests) {
      lines.push(`- **${test.id}**${test.cost ? ` (${test.cost})` : ""}: ${test.reason}`);
      if (test.workflow || test.job || test.script) {
        lines.push(`  - workflow: \`${test.workflow || "n/a"}\`, job: \`${test.job || "n/a"}\`, script: \`${test.script || "n/a"}\``);
      }
    }
  }
  lines.push("");

  lines.push("## Optional E2E");
  if (result.optionalTests.length === 0) {
    lines.push("- _None._");
  } else {
    for (const test of result.optionalTests) {
      lines.push(`- **${test.id}**${test.cost ? ` (${test.cost})` : ""}: ${test.reason}`);
    }
  }
  lines.push("");

  lines.push("## New E2E recommendations");
  if (result.newE2eRecommendations.length === 0) {
    lines.push("- _No new coverage gaps detected by deterministic rules._");
  } else {
    for (const gap of result.newE2eRecommendations) {
      lines.push(`- **${gap.domain}** (${gap.priority || "medium"}): ${gap.reason}`);
      lines.push(`  - Suggested test: ${gap.suggestedTest}`);
    }
  }
  lines.push("");

  if (result.dispatchHint) {
    lines.push("## Dispatch hint");
    lines.push(`- Workflow: \`${result.dispatchHint.workflow}\``);
    lines.push(`- \`jobs\` input: \`${result.dispatchHint.jobsInput}\``);
    lines.push("");
  }

  lines.push("_Safety note: this workflow performs static analysis only. It reads diffs and metadata but does not execute PR-provided code._");
  lines.push("");
  return `${lines.join("\n")}\n`;
}
