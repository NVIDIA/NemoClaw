// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifySecretExit,
  parseSecretReport,
  redactSecretReport,
} from "../../../.github/scripts/security-scan-results.mts";

const scriptPath = fileURLToPath(
  new URL("../../../.github/scripts/security-scan-results.mts", import.meta.url),
);
const temporaryRoots: string[] = [];
function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-security-scan-"));
  temporaryRoots.push(root);
  return root;
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("security scan report handling", () => {
  it("redacts CLI reports and removes scanner scratch files", () => {
    const root = createTemporaryRoot();
    const rawPath = join(root, "raw.jsonl");
    const stderrPath = join(root, "scanner.stderr");
    const reportPath = join(root, "report.jsonl");
    writeFileSync(
      rawPath,
      JSON.stringify({ DetectorName: "Example", Raw: "secret", Verified: true }),
    );
    writeFileSync(stderrPath, "secret diagnostic");

    const result = spawnSync(
      process.execPath,
      [scriptPath, "redact-secrets", rawPath, stderrPath, reportPath],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual({
      Verified: true,
    });
    expect(() => readFileSync(rawPath)).toThrow();
    expect(() => readFileSync(stderrPath)).toThrow();
  });

  it.each([183, 1])("classifies scanner exit %i as blocking through the CLI", (exitCode) => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "classify-secret-exit", String(exitCode)],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("blocking\n");
  });
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
      DetectorType: 42,
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

  it.each(["secret-detector-id", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "omits invalid detector identifier %s",
    (DetectorType) => {
      expect(parseSecretReport(JSON.stringify({ DetectorType, Verified: true }))).toEqual([
        { Verified: true },
      ]);
    },
  );

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
    const root = createTemporaryRoot();
    const rawPath = join(root, "raw.jsonl");
    const stderrPath = join(root, "scanner.stderr");
    const reportPath = join(root, "report.jsonl");
    writeFileSync(
      rawPath,
      `${JSON.stringify({
        DetectorType: 42,
        DetectorName: "secret-detector",
        DecoderName: "secret-decoder",
        RawV2: "secret-raw",
        Redacted: "secret-unmasked",
        Verified: false,
        VerificationFromCache: "secret-invalid-boolean",
        SourceMetadata: {
          Data: {
            Filesystem: { file: "/secret-path", line: "secret-line" },
            Docker: {
              file: "/secret-file",
              image: "secret-image",
              tag: "secret-tag",
              layer: "secret-layer",
            },
            Git: { file: "/secret-git-path", commit: "secret-commit" },
          },
        },
      })}\n`,
      "utf8",
    );
    writeFileSync(stderrPath, "scanner diagnostic", "utf8");

    redactSecretReport(rawPath, stderrPath, reportPath);

    expect(readFileSync(reportPath, "utf8")).toBe(
      `${JSON.stringify({ DetectorType: 42, Verified: false })}\n`,
    );
    expect(() => readFileSync(rawPath)).toThrow();
    expect(() => readFileSync(stderrPath)).toThrow();
  });

  it("removes raw output and refuses a partial artifact when any result is malformed", () => {
    const root = createTemporaryRoot();
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
