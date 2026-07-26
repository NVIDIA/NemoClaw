// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEXT_REDACTOR = path.resolve(HERE, "e2e/lib/redact-text.py");
const REDACTED = "[REDACTED]";

function runTextRedactor(input: string): { rc: number; stdout: string; stderr: string } {
  const result = spawnSync("python3", [TEXT_REDACTOR], {
    input,
    encoding: "utf-8",
    timeout: 20_000,
  });
  return {
    rc: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("scope-upgrade diagnostic text redactor", () => {
  it("scrubs token-shaped substrings from raw gateway and auto-pair log excerpts", () => {
    const input = [
      "Authorization: Bearer nvapi-abc.def_ghi-jkl-mnopqrstu",
      "Cookie: session=eyJabcdefg.payload.signature123",
      "github-token=ghp_aaaaaaaaaaaaaaaaaa11",
      "X-API-Key: sk-projXYZ1234567890abcd",
      "request: token=github_pat_abcdefghijklmnopqrstu",
      "huggingface key hf_aaaaaaaaaaaaaaaaaa logged",
      "aws AKIAABCDEFGHIJKLMNOP",
      "slack xoxb-1111-2222-aaaaa",
      "plain gateway connect: ok",
      "",
    ].join("\n");

    const result = runTextRedactor(input);
    expect(result.rc).toBe(0);
    expect(result.stdout).not.toContain("nvapi-abc.def_ghi");
    expect(result.stdout).not.toContain("eyJabcdefg.payload");
    expect(result.stdout).not.toContain("ghp_aaaaa");
    expect(result.stdout).not.toContain("sk-projXYZ");
    expect(result.stdout).not.toContain("github_pat_abcdefg");
    expect(result.stdout).not.toContain("hf_aaaaa");
    expect(result.stdout).not.toContain("AKIAABCDEFG");
    expect(result.stdout).not.toContain("xoxb-1111");
    expect(result.stdout).toContain("plain gateway connect: ok");
    expect(result.stdout).toContain(REDACTED);
  });

  it("preserves structural prefixes while substituting only the secret value", () => {
    const result = runTextRedactor("Authorization: Bearer raw-bearer-token\n");
    expect(result.rc).toBe(0);
    expect(result.stdout).toContain("Authorization:");
    expect(result.stdout).toContain("Bearer ");
    expect(result.stdout).not.toContain("raw-bearer-token");
    expect(result.stdout).toContain(REDACTED);
  });

  it("passes through input free of token-shaped substrings unchanged", () => {
    const input = "ls -la /tmp/auto-pair.log\nslow-mode keepalive transition observed\n";
    const result = runTextRedactor(input);
    expect(result.rc).toBe(0);
    expect(result.stdout).toBe(input);
  });

  it("preserves ordinary hyphenated diagnostic text containing sk-", () => {
    const input = "task-management-system-deployment completed without fallback\n";
    const result = runTextRedactor(input);
    expect(result.rc).toBe(0);
    expect(result.stdout).toBe(input);
  });

  it("returns success on empty input", () => {
    const result = runTextRedactor("");
    expect(result.rc).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("handles input without a trailing newline", () => {
    const result = runTextRedactor("plain text without newline");
    expect(result.rc).toBe(0);
    expect(result.stdout).toBe("plain text without newline");
  });

  it("redacts multiple shapes on the same line", () => {
    const result = runTextRedactor(
      "trace: Bearer nvapi-abc.def_ghi-jkl-mnopqrstu while X-API-Key=sk-projXYZ1234567890abcd\n",
    );
    expect(result.rc).toBe(0);
    expect(result.stdout).not.toContain("nvapi-abc.def_ghi");
    expect(result.stdout).not.toContain("sk-projXYZ");
    expect(result.stdout).toContain("Bearer ");
    expect(result.stdout).toContain("X-API-Key");
    const redactedCount = (result.stdout.match(/\[REDACTED\]/g) ?? []).length;
    expect(redactedCount).toBeGreaterThanOrEqual(2);
  });

  it("preserves newline structure across long multi-line input", () => {
    const lines = Array.from({ length: 64 }, (_, i) =>
      i % 8 === 0 ? `line ${i} nvapi-secret-value-${i}-padded-12345` : `line ${i} plain diagnostic`,
    );
    const input = `${lines.join("\n")}\n`;
    const result = runTextRedactor(input);
    expect(result.rc).toBe(0);
    expect(result.stdout.split("\n").length).toBe(lines.length + 1);
    expect(result.stdout).not.toMatch(/nvapi-secret-value-\d+-padded/);
    expect(result.stdout).toMatch(/line 1 plain diagnostic/);
  });
});
