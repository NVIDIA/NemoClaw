// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const PATCH_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "patch-openclaw-issue-4434-diagnostics.ts",
);

type Formatter = (raw: unknown) => string;

function writeAssistantErrorFormatFixture(dist: string): string {
  const fixture = path.join(dist, "assistant-error-format-fixture.js");
  fs.writeFileSync(
    fixture,
    [
      "const HTTP_STATUS_PREFIX_RE = /^$/;",
      'const MALFORMED_STREAMING_FRAGMENT_USER_MESSAGE = "LLM streaming response contained a malformed fragment. Please try again.";',
      'const GENERIC_PROVIDER_INTERNAL_ERROR_USER_MESSAGE = "The AI service returned an internal error. Please try again in a moment.";',
      "function extractLeadingHttpStatus(raw) { return null; }",
      "function isCloudflareOrHtmlErrorPage(raw) { return false; }",
      "function isGenericProviderInternalError(raw) { return false; }",
      "function parseApiErrorInfo(raw) { return null; }",
      "function formatRawAssistantErrorForUi(raw) {",
      '  const trimmed = (raw ?? "").trim();',
      '  if (!trimmed) return "LLM request failed with an unknown error.";',
      '  if (trimmed === "OpenClaw transport error: malformed_streaming_fragment") return MALFORMED_STREAMING_FRAGMENT_USER_MESSAGE;',
      "  if (isGenericProviderInternalError(trimmed)) return GENERIC_PROVIDER_INTERNAL_ERROR_USER_MESSAGE;",
      "  const leadingStatus = extractLeadingHttpStatus(trimmed);",
      "  const isHtmlChallenge = isCloudflareOrHtmlErrorPage(trimmed);",
      "  if (leadingStatus && isHtmlChallenge) return `The AI service is temporarily unavailable (HTTP ${leadingStatus.code}). Please try again in a moment.`;",
      '  if (isHtmlChallenge) return "The provider returned an HTML error page instead of an API response. This usually means a CDN or gateway (e.g. Cloudflare) blocked the request. Retry in a moment or check provider status.";',
      "  const httpMatch = trimmed.match(HTTP_STATUS_PREFIX_RE);",
      "  if (httpMatch) {",
      "    const rest = httpMatch[2].trim();",
      '    if (!rest.startsWith("{")) return `HTTP ${httpMatch[1]}: ${rest}`;',
      "  }",
      "  const info = parseApiErrorInfo(trimmed);",
      '  if (info?.message) return `${info.httpCode ? `HTTP ${info.httpCode}` : "LLM error"}${info.type ? ` ${info.type}` : ""}: ${info.message}`;',
      "  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}...` : trimmed;",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

function writeUnrecognizedAssistantFormatterFixture(dist: string): string {
  const fixture = path.join(dist, "assistant-error-format-fixture.js");
  fs.writeFileSync(
    fixture,
    [
      'const MALFORMED_STREAMING_FRAGMENT_USER_MESSAGE = "fixture";',
      "function parseApiErrorInfo(raw) { return null; }",
      "function formatRawAssistantErrorForUi(raw) {",
      "  const message = String(raw ?? '').trim();",
      "  return message;",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

function writeRenamedArrowAssistantFormatterFixture(dist: string): string {
  const fixture = path.join(dist, "assistant-error-format-fixture.js");
  fs.writeFileSync(
    fixture,
    [
      'const MALFORMED_STREAMING_FRAGMENT_USER_MESSAGE = "fixture";',
      "function parseApiErrorInfo(raw) { return null; }",
      "const formatRawAssistantErrorForUi_v2 = (raw) => {",
      '  const trimmed = (raw ?? "").trim();',
      '  if (!trimmed) return "LLM request failed with an unknown error.";',
      "  return trimmed;",
      "};",
      "",
    ].join("\n"),
  );
  return fixture;
}

function runPatch(dist: string, args: string[] = []) {
  return spawnSync(process.execPath, ["--experimental-strip-types", PATCH_SCRIPT, ...args, dist], {
    encoding: "utf-8",
    timeout: 10000,
  });
}

function runPatchAudit(dist: string) {
  return runPatch(dist, ["--audit"]);
}

function loadFormatter(source: string, env?: Record<string, string>): Formatter {
  const context: Record<string, unknown> = env ? { process: { env } } : {};
  return vm.runInNewContext(`${source}\nformatRawAssistantErrorForUi;`, context) as Formatter;
}

describe("OpenClaw diagnostics compatibility patch (#4434)", () => {
  it("enriches sandbox fetch failures and timeouts with structured diagnostics", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-4434-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    const fixture = writeAssistantErrorFormatFixture(dist);

    try {
      const patch = runPatch(dist);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("patched OpenClaw #4434 diagnostics");

      const patched = fs.readFileSync(fixture, "utf-8");
      expect(patched).toContain("nemoclaw: #4434 structured unreachable-inference diagnostic");
      const sandboxFormatter = loadFormatter(patched, { OPENSHELL_SANDBOX: "1" });
      const hostFormatter = loadFormatter(patched, {});
      const noProcessFormatter = loadFormatter(patched);

      expect(sandboxFormatter("TypeError: fetch failed")).toBe(
        [
          "TypeError: fetch failed",
          "Cause: fetch failed while reaching the upstream API.",
          "Reporting layer: gateway proxy / upstream API.",
          "Recovery hint: check sandbox egress and provider reachability, then retry.",
        ].join("\n"),
      );
      expect(sandboxFormatter("LLM request timed out.")).toBe(
        [
          "LLM request timed out.",
          "Cause: timed out while reaching the upstream API.",
          "Reporting layer: gateway proxy / upstream API.",
          "Recovery hint: check sandbox egress and provider reachability, then retry.",
        ].join("\n"),
      );
      expect(hostFormatter("TypeError: fetch failed")).toBe("TypeError: fetch failed");
      expect(hostFormatter("LLM request timed out.")).toBe("LLM request timed out.");
      expect(noProcessFormatter("TypeError: fetch failed")).toBe("TypeError: fetch failed");
      expect(noProcessFormatter("LLM request timed out.")).toBe("LLM request timed out.");
      expect(sandboxFormatter("Authentication refresh timed out after 30 seconds.")).toBe(
        "Authentication refresh timed out after 30 seconds.",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("completes partial upstream diagnostics without duplicating fields", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-4434-partial-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    const fixture = writeAssistantErrorFormatFixture(dist);

    try {
      const patch = runPatch(dist);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      const formatter = loadFormatter(fs.readFileSync(fixture, "utf-8"), {
        OPENSHELL_SANDBOX: "1",
      });
      const partial = "TypeError: fetch failed\nCause: connect ETIMEDOUT";
      const full = [
        "TypeError: fetch failed",
        "Cause: connect ETIMEDOUT",
        "Reporting layer: gateway proxy / upstream API.",
        "Recovery hint: check sandbox egress and provider reachability, then retry.",
      ].join("\n");

      expect(formatter(partial)).toBe(full);
      expect(formatter(full)).toBe(full);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("audits fresh and already-applied shapes, and fails closed on unknown shapes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-4434-audit-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeAssistantErrorFormatFixture(dist);

    try {
      const freshAudit = runPatchAudit(dist);
      expect(freshAudit.status, `${freshAudit.stdout}${freshAudit.stderr}`).toBe(0);
      expect(freshAudit.stdout).toContain("assistant error formatter:");
      expect(freshAudit.stdout).toContain("would-apply");

      const patch = runPatch(dist);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);

      const appliedAudit = runPatchAudit(dist);
      expect(appliedAudit.status, `${appliedAudit.stdout}${appliedAudit.stderr}`).toBe(0);
      expect(appliedAudit.stdout).toContain("already-applied");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    const legacyTmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-4434-legacy-"));
    const legacyDist = path.join(legacyTmp, "dist");
    fs.mkdirSync(legacyDist);
    const legacyFixture = writeAssistantErrorFormatFixture(legacyDist);
    fs.appendFileSync(
      legacyFixture,
      "// nemoclaw: #4434 structured unreachable-inference diagnostic\n",
    );
    try {
      const audit = runPatchAudit(legacyDist);
      expect(audit.status, `${audit.stdout}${audit.stderr}`).toBe(3);
      expect(audit.stdout).toContain("legacy fetch-only #4434 patch");
    } finally {
      fs.rmSync(legacyTmp, { recursive: true, force: true });
    }

    const missingTmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-4434-missing-"));
    const missingDist = path.join(missingTmp, "dist");
    fs.mkdirSync(missingDist);
    fs.writeFileSync(path.join(missingDist, "other.js"), "console.log('fixture');\n");
    try {
      const audit = runPatchAudit(missingDist);
      expect(audit.status, `${audit.stdout}${audit.stderr}`).toBe(3);
      expect(audit.stdout).toContain(
        "expected exactly one OpenClaw assistant error formatter file, found 0",
      );
    } finally {
      fs.rmSync(missingTmp, { recursive: true, force: true });
    }

    const signatureDriftTmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-openclaw-4434-signature-drift-"),
    );
    const signatureDriftDist = path.join(signatureDriftTmp, "dist");
    fs.mkdirSync(signatureDriftDist);
    const signatureDriftFixture = writeAssistantErrorFormatFixture(signatureDriftDist);
    const recognizedSource = fs.readFileSync(signatureDriftFixture, "utf8");
    fs.writeFileSync(
      signatureDriftFixture,
      recognizedSource.replace(
        "function formatRawAssistantErrorForUi(raw) {",
        "function formatRawAssistantErrorForUi(raw, options) {",
      ),
    );
    try {
      const audit = runPatchAudit(signatureDriftDist);
      expect(audit.status, `${audit.stdout}${audit.stderr}`).toBe(3);
      expect(audit.stdout).toContain("assistant error formatter: NOT FOUND");
      expect(audit.stdout).toContain("1 file(s) NOT FOUND");
    } finally {
      fs.rmSync(signatureDriftTmp, { recursive: true, force: true });
    }

    const renamedArrowTmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-openclaw-4434-renamed-arrow-"),
    );
    const renamedArrowDist = path.join(renamedArrowTmp, "dist");
    fs.mkdirSync(renamedArrowDist);
    writeRenamedArrowAssistantFormatterFixture(renamedArrowDist);
    try {
      const audit = runPatchAudit(renamedArrowDist);
      expect(audit.status, `${audit.stdout}${audit.stderr}`).toBe(3);
      expect(audit.stdout).toContain("assistant error formatter: NOT FOUND");
      expect(audit.stdout).toContain(
        "[MISS] expected exactly one OpenClaw assistant error formatter file, found 0",
      );
      expect(audit.stdout).toContain("[MISS] issue-4434-diagnostics: file unresolved");
    } finally {
      fs.rmSync(renamedArrowTmp, { recursive: true, force: true });
    }

    const unknownTmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-4434-unknown-"));
    const unknownDist = path.join(unknownTmp, "dist");
    fs.mkdirSync(unknownDist);
    writeUnrecognizedAssistantFormatterFixture(unknownDist);
    try {
      const patch = runPatch(unknownDist);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(1);
      expect(patch.stderr).toContain("OpenClaw assistant error formatter shape not recognized");
    } finally {
      fs.rmSync(unknownTmp, { recursive: true, force: true });
    }
  });

  it("rejects malformed command lines", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-4434-usage-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", PATCH_SCRIPT, tmp, tmp],
        {
          encoding: "utf-8",
          timeout: 10000,
        },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(2);
      expect(result.stderr).toContain("Usage: patch-openclaw-issue-4434-diagnostics.ts");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
