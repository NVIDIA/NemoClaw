#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Temporary NemoClaw compatibility shim for OpenClaw 2026.6.10 TUI error output.
 * Remove this when upstream OpenClaw reports structured unreachable-inference
 * diagnostics for sandbox fetch failures and inference timeouts.
 */

const fs = require("node:fs");
const path = require("node:path");

const AUDIT_FLAG = "--audit";
const EXIT_APPLY_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_AUDIT_FAILURE = 3;
const LEGACY_PATCH_MARKER = "nemoclaw: #4434 structured unreachable-inference diagnostic";
const PATCH_MARKER = `${LEGACY_PATCH_MARKER} (timeout-shape-v2)`;

type DirentLike = {
  isFile(): boolean;
  name: string;
};

type PatchStatus = "already-applied" | "would-apply" | "no-match" | "selector-failed";

type PatchResult = {
  nextSource: string;
  status: Exclude<PatchStatus, "selector-failed">;
  error?: string;
};

const args = process.argv.slice(2);
const auditMode = args.includes(AUDIT_FLAG);
const positional = args.filter((value) => value !== AUDIT_FLAG);
const distDir = positional[0];

if (!distDir || positional.length > 1) {
  console.error("Usage: patch-openclaw-issue-4434-diagnostics.ts [--audit] <openclaw-dist-dir>");
  process.exit(EXIT_USAGE);
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(EXIT_APPLY_FAILURE);
}

function listJsFiles(dir: string): string[] {
  return (fs.readdirSync(dir, { withFileTypes: true }) as DirentLike[])
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(dir, entry.name));
}

const helperSource = [
  "const NEMOCLAW_ISSUE_4434_HTTP_STATUS_OR_CAUSE_RE = /\\b(?:HTTP\\s+\\d{3}|status(?:\\s+code)?\\s*[:=]\\s*\\d{3}|cause\\s*[:=]\\s*\\S+)/i;",
  "const NEMOCLAW_ISSUE_4434_REPORTING_LAYER_RE = /\\b(?:gateway proxy|gateway layer|reported by gateway|upstream API|from upstream)\\b/i;",
  "const NEMOCLAW_ISSUE_4434_RECOVERY_HINT_RE = /\\b(?:recovery hint|hint\\s*[:=]|check (?:egress|network|provider)|retry)\\b/i;",
  "function formatNemoClawIssue4434UnreachableInference(raw) {",
  '  const trimmed = (raw ?? "").trim();',
  "  if (!trimmed) return null;",
  '  if (typeof process === "undefined" || process.env?.OPENSHELL_SANDBOX !== "1") return null;',
  "  const isFetchFailure = /\\b(?:TypeError:\\s*)?fetch failed\\b/i.test(trimmed);",
  "  const isInferenceTimeout = /^LLM request timed out\\.$/i.test(trimmed);",
  "  if (!isFetchFailure && !isInferenceTimeout) return null;",
  "  const lines = [trimmed];",
  '  if (!NEMOCLAW_ISSUE_4434_HTTP_STATUS_OR_CAUSE_RE.test(trimmed)) lines.push(isInferenceTimeout ? "Cause: timed out while reaching the upstream API." : "Cause: fetch failed while reaching the upstream API.");',
  '  if (!NEMOCLAW_ISSUE_4434_REPORTING_LAYER_RE.test(trimmed)) lines.push("Reporting layer: gateway proxy / upstream API.");',
  '  if (!NEMOCLAW_ISSUE_4434_RECOVERY_HINT_RE.test(trimmed)) lines.push("Recovery hint: check sandbox egress and provider reachability, then retry.");',
  '  return lines.length > 1 ? lines.join("\\n") : null;',
  "}",
].join("\n");

function patchAssistantErrorFormat(source: string, file: string): PatchResult {
  if (source.includes(PATCH_MARKER)) {
    return { nextSource: source, status: "already-applied" };
  }
  if (source.includes(LEGACY_PATCH_MARKER)) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw assistant error formatter in ${file} contains the legacy fetch-only #4434 patch`,
    };
  }

  const pattern =
    /function formatRawAssistantErrorForUi\(raw\) \{\n(\s*)const trimmed = \(raw \?\? ""\)\.trim\(\);\n\1if \(!trimmed\) return "LLM request failed with an unknown error\.";/;
  const nextSource = source.replace(pattern, (_match: string, indent: string) => {
    return [
      helperSource,
      "function formatRawAssistantErrorForUi(raw) {",
      `${indent}const trimmed = (raw ?? "").trim();`,
      `${indent}if (!trimmed) return "LLM request failed with an unknown error.";`,
      `${indent}const nemoclawIssue4434Diagnostic = formatNemoClawIssue4434UnreachableInference(trimmed);`,
      `${indent}if (nemoclawIssue4434Diagnostic) return nemoclawIssue4434Diagnostic; // ${PATCH_MARKER}`,
    ].join("\n");
  });

  if (nextSource === source) {
    return {
      nextSource: source,
      status: "no-match",
      error: `OpenClaw assistant error formatter shape not recognized in ${file}`,
    };
  }
  return { nextSource, status: "would-apply" };
}

const FILE_SPEC = {
  id: "assistant-error-format",
  label: "assistant error formatter",
  selector(source: string) {
    return (
      source.includes("function formatRawAssistantErrorForUi(raw)") &&
      source.includes("MALFORMED_STREAMING_FRAGMENT_USER_MESSAGE") &&
      source.includes("parseApiErrorInfo")
    );
  },
  recognizer: {
    id: "issue-4434-diagnostics",
    marker: PATCH_MARKER,
    postVerifyError: "OpenClaw #4434 diagnostic formatter patch did not apply",
    patch: patchAssistantErrorFormat,
  },
};

function resolveFile({ dryRun }: { dryRun: boolean }): { file: string | null; error?: string } {
  const candidates = listJsFiles(distDir).filter((file) =>
    FILE_SPEC.selector(fs.readFileSync(file, "utf8")),
  );
  if (candidates.length !== 1) {
    const error = `expected exactly one OpenClaw ${FILE_SPEC.label} file, found ${candidates.length}`;
    if (!dryRun) fail(error);
    return { file: null, error };
  }
  return { file: candidates[0] };
}

function processFile(file: string, { dryRun }: { dryRun: boolean }): PatchResult {
  const source = fs.readFileSync(file, "utf8");
  const result = FILE_SPEC.recognizer.patch(source, file);
  if (result.status === "no-match") {
    if (!dryRun) fail(result.error ?? FILE_SPEC.recognizer.postVerifyError);
    return result;
  }

  if (!dryRun && result.nextSource !== source) {
    fs.writeFileSync(file, result.nextSource);
  }

  if (!dryRun) {
    const written = fs.readFileSync(file, "utf8");
    if (!written.includes(FILE_SPEC.recognizer.marker)) {
      fail(FILE_SPEC.recognizer.postVerifyError);
    }
  }

  return result;
}

function statusBadge(status: PatchStatus): string {
  switch (status) {
    case "already-applied":
    case "would-apply":
      return "[OK]  ";
    case "no-match":
    case "selector-failed":
      return "[MISS]";
    default:
      return "[?]   ";
  }
}

function runApplyMode() {
  const { file, error } = resolveFile({ dryRun: false });
  if (!file) fail(error ?? `expected exactly one OpenClaw ${FILE_SPEC.label} file`);
  processFile(file, { dryRun: false });
  console.log(`INFO: patched OpenClaw #4434 diagnostics in ${path.basename(file)}`);
}

function runAuditMode() {
  console.log(`patch-openclaw-issue-4434-diagnostics audit: ${distDir}`);
  const { file, error: selectorError } = resolveFile({ dryRun: true });
  let missingRecognizers = 0;
  let selectorFailures = 0;

  console.log("");
  if (!file) {
    selectorFailures += 1;
    missingRecognizers += 1;
    console.log(`${FILE_SPEC.label}: NOT FOUND`);
    console.log(`  ${statusBadge("selector-failed")} ${selectorError}`);
    console.log(`  ${statusBadge("no-match")} ${FILE_SPEC.recognizer.id}: file unresolved`);
  } else {
    const result = processFile(file, { dryRun: true });
    console.log(`${FILE_SPEC.label}: ${path.basename(file)}`);
    if (result.status === "no-match") {
      missingRecognizers += 1;
      console.log(`  ${statusBadge(result.status)} ${FILE_SPEC.recognizer.id}: ${result.error}`);
    } else {
      console.log(`  ${statusBadge(result.status)} ${FILE_SPEC.recognizer.id}: ${result.status}`);
    }
  }

  console.log("");
  console.log(
    `Summary: 1 recognizer · ${missingRecognizers === 0 ? 1 : 0} OK · ${missingRecognizers} missing` +
      (selectorFailures > 0 ? ` · ${selectorFailures} file(s) NOT FOUND` : ""),
  );

  if (missingRecognizers > 0 || selectorFailures > 0) {
    process.exit(EXIT_AUDIT_FAILURE);
  }
}

if (auditMode) {
  runAuditMode();
} else {
  runApplyMode();
}
