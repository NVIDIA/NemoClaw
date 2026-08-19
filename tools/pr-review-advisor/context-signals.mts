// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { gitOutput } from "../advisors/git.mts";

export type SimplificationSignal = {
  file: string | null;
  line: number | null;
  kind: "new_dependency";
  evidence: string;
  reviewRule: string;
};

export type LocalizedPatchSignal = {
  file: string | null;
  line: number | null;
  kind: string;
  evidence: string;
  reviewRule: string;
};

export type DriftEvidence = {
  file: string;
  recentHistory: string[];
  renameHints: string[];
};

export function detectRiskyAreas(changedFiles: string[]): string[] {
  const areas = new Set<string>();
  for (const file of changedFiles) {
    if (/^(install|setup|brev-setup)\.sh$/.test(file) || /^scripts\/.*\.sh$/.test(file))
      areas.add("installer/bootstrap shell");
    if (file === "src/lib/onboard.ts" || file === "bin/nemoclaw.js" || file.startsWith("scripts/"))
      areas.add("onboarding/host glue");
    if (file.startsWith("nemoclaw/src/blueprint/") || file.startsWith("nemoclaw-blueprint/"))
      areas.add("sandbox/policy/SSRF");
    if (file.startsWith(".github/workflows/") || file.includes("prek") || file.includes("dco"))
      areas.add("workflow/enforcement");
    if (/credential|inference|network|approval|provider/i.test(file))
      areas.add("credentials/inference/network");
  }
  return [...areas].sort();
}

export function detectWorkflowSignals(changedFiles: string[], diff: string): string[] {
  if (!changedFiles.some((file) => file.startsWith(".github/workflows/"))) return [];
  const signals: string[] = [
    "Workflow files changed; review trusted-code boundary, permissions, and pinning.",
  ];
  if (/secrets\./.test(diff) || /GITHUB_TOKEN|GH_TOKEN/.test(diff))
    signals.push("Secrets or GitHub tokens appear in workflow diff.");
  if (/pull_request_target/.test(diff))
    signals.push("pull_request_target appears in workflow diff.");
  if (/permissions:\s*[\s\S]*write/.test(diff))
    signals.push("Workflow requests write-scoped permissions.");
  if (/npm install|pip install|curl .*\|.*sh|uv tool install/.test(diff))
    signals.push(
      "Workflow installs runtime dependencies; verify pins and disabled lifecycle hooks.",
    );
  if (/github\.event\.pull_request\.(title|body|head\.ref)/.test(diff))
    signals.push(
      "PR-controlled text may be interpolated into workflow expressions; verify shell safety.",
    );
  return signals;
}

export function detectSimplificationSignals(diff: string): SimplificationSignal[] {
  const signals: SimplificationSignal[] = [];
  let file: string | null = null;
  let nextLine: number | null = null;
  for (const rawLine of diff.split("\n")) {
    const fileMatch = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      file = fileMatch[2] || fileMatch[1] || null;
      nextLine = null;
      continue;
    }
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      nextLine = Number.parseInt(hunkMatch[1] || "", 10);
      if (!Number.isFinite(nextLine)) nextLine = null;
      continue;
    }
    if (rawLine === "+++" || rawLine.startsWith("+++ ")) continue;
    if (rawLine.startsWith("+")) {
      const line = rawLine.slice(1).trim();
      if (
        line &&
        /^(import|const|let|var)\b.*(?:\bfrom\s+["']|\brequire\(["'])(?:lodash|moment|date-fns|axios|uuid|chalk|commander|yargs)/.test(
          line,
        )
      ) {
        signals.push({
          file,
          line: nextLine,
          kind: "new_dependency",
          evidence: line.slice(0, 220),
          reviewRule:
            "Ask whether Node.js, TypeScript, browser, shell, or an already-installed dependency covers this before accepting another dependency.",
        });
      }
      if (nextLine !== null) nextLine += 1;
      if (signals.length >= 60) break;
      continue;
    }
    if (rawLine.startsWith(" ") && nextLine !== null) nextLine += 1;
  }
  return signals.slice(0, 60);
}

export function detectLocalizedPatchSignals(diff: string): LocalizedPatchSignal[] {
  const patterns: Array<{ kind: string; regex: RegExp }> = [
    {
      kind: "fallback/recovery/tolerance path",
      regex:
        /\b(?:fallback\w*|recover|recovery|best[- ]?effort|workaround|tolerant|repair|self[- ]?heal|degraded)\b/i,
    },
    {
      kind: "runtime interception or monkeypatch",
      regex:
        /\b(?:NODE_OPTIONS|uncaughtException|unhandledRejection|process\.emit|require\.cache|prototype|monkey[- ]?patch|http\.request|https\.request|networkInterfaces)\b/i,
    },
  ];
  const signals: LocalizedPatchSignal[] = [];
  let file: string | null = null;
  let nextLine: number | null = null;
  for (const rawLine of diff.split("\n")) {
    const fileMatch = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      file = fileMatch[2] || fileMatch[1] || null;
      nextLine = null;
      continue;
    }
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      nextLine = Number.parseInt(hunkMatch[1] || "", 10);
      if (!Number.isFinite(nextLine)) nextLine = null;
      continue;
    }
    if (rawLine === "+++" || rawLine.startsWith("+++ ")) continue;
    if (rawLine.startsWith("+")) {
      const content = rawLine.slice(1).trim();
      if (content) {
        const pattern = patterns.find((candidate) => candidate.regex.test(content));
        if (pattern)
          signals.push({
            file,
            line: nextLine,
            kind: pattern.kind,
            evidence: content.slice(0, 220),
            reviewRule:
              "If this is a localized patch, identify the invalid state, its source boundary, why the source cannot be fixed here, the regression test, and the removal condition.",
          });
      }
      if (nextLine !== null) nextLine += 1;
      if (signals.length >= 40) break;
      continue;
    }
    if (rawLine.startsWith(" ") && nextLine !== null) nextLine += 1;
  }
  return signals;
}

export function collectDriftEvidence(baseRef: string, changedFiles: string[]): DriftEvidence[] {
  const renameHistory = (
    gitOutput(
      [["log", "--oneline", "--name-status", "--find-renames", "-40", baseRef, "--"]],
      120000,
    ) || ""
  )
    .split("\n")
    .map((line) => line.trim());
  return changedFiles.slice(0, 50).map((file) => {
    const recentHistory = (
      gitOutput([["log", "--oneline", "--follow", "-20", baseRef, "--", file]], 20000) || ""
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const normalizedFile = file.replace(/^\.\//, "").replace(/\\/g, "/");
    const renameHints = renameHistory
      .filter((line) => {
        const [status, ...paths] = line.replace(/\\/g, "/").split("\t");
        if (!/^(R\d+|A|D|M)$/.test(status || "")) return false;
        return paths.some((changedPath) => changedPath.replace(/^\.\//, "") === normalizedFile);
      })
      .slice(0, 20);
    return { file, recentHistory, renameHints };
  });
}
