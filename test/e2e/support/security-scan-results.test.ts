// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifySecretExit,
  parseSecretReport,
  redactSecretReport,
} from "../../../.github/scripts/security-scan-results.mts";

describe("security scan report handling", () => {
  it("retains only reviewed secret finding metadata", () => {
    const [result] = parseSecretReport(
      `${JSON.stringify({
        DetectorName: "ExampleDetector",
        DetectorType: 42,
        DecoderName: "PLAIN",
        Verified: true,
        VerificationFromCache: false,
        Redacted: "sec********ret",
        Raw: "secret-raw",
        RawV2: "secret-raw-v2",
        ExtraData: { token: "secret-extra" },
        StructuredData: { password: "secret-structured" },
        FutureSecretField: "secret-future",
        SourceMetadata: {
          Data: {
            Filesystem: { file: "/opt/app/config.ts", line: 7, content: "secret-content" },
            Git: {
              file: "src/config.ts",
              repository: "https://user:secret-password@example.com/repo.git",
            },
            Unknown: { secret: "secret-source" },
          },
        },
      })}\n`,
    );

    expect(result).toEqual({
      DecoderName: "PLAIN",
      DetectorName: "ExampleDetector",
      DetectorType: 42,
      Redacted: "sec********ret",
      SourceMetadata: {
        Data: {
          Filesystem: { file: "/opt/app/config.ts", line: 7 },
          Git: { file: "src/config.ts" },
        },
      },
      VerificationFromCache: false,
      Verified: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-raw");
    expect(JSON.stringify(result)).not.toContain("secret-extra");
    expect(JSON.stringify(result)).not.toContain("secret-structured");
    expect(JSON.stringify(result)).not.toContain("secret-future");
    expect(JSON.stringify(result)).not.toContain("secret-source");
    expect(JSON.stringify(result)).not.toContain("secret-password");
  });

  it.each([
    [0, "accepted"],
    [189, "accepted"],
    [185, "advisory"],
    [183, "blocking"],
    [1, "blocking"],
  ])("classifies secret scanner exit code %i as %s", (exitCode, expected) => {
    expect(classifySecretExit(exitCode)).toBe(expected);
  });

  it("publishes only sanitized fields and removes successful scanner scratch files", () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-security-scan-"));
    const rawPath = join(root, "raw.jsonl");
    const stderrPath = join(root, "scanner.stderr");
    const reportPath = join(root, "report.jsonl");
    writeFileSync(
      rawPath,
      `${JSON.stringify({ DetectorName: "ExampleDetector", RawV2: "secret", Verified: false })}\n`,
      "utf8",
    );
    writeFileSync(stderrPath, "scanner diagnostic", "utf8");

    redactSecretReport(rawPath, stderrPath, reportPath);

    expect(readFileSync(reportPath, "utf8")).toBe(
      `${JSON.stringify({ DetectorName: "ExampleDetector", Verified: false })}\n`,
    );
    expect(() => readFileSync(rawPath)).toThrow();
    expect(() => readFileSync(stderrPath)).toThrow();
  });

  it("removes raw output and refuses a partial artifact when any result is malformed", () => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-security-scan-"));
    const rawPath = join(root, "raw.jsonl");
    const stderrPath = join(root, "scanner.stderr");
    const reportPath = join(root, "report.jsonl");
    writeFileSync(rawPath, '{"DetectorName":"valid"}\nnot-json\n', "utf8");
    writeFileSync(stderrPath, "scanner diagnostic", "utf8");
    writeFileSync(reportPath, "stale artifact", "utf8");

    expect(() => redactSecretReport(rawPath, stderrPath, reportPath)).toThrow();
    expect(() => readFileSync(rawPath)).toThrow();
    expect(() => readFileSync(stderrPath)).toThrow();
    expect(() => readFileSync(reportPath)).toThrow();
  });
});
