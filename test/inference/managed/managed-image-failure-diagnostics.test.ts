// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  exportManagedImageFailureDiagnostics,
  MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS,
} from "../../../scripts/checks/export-managed-image-failure-diagnostics.ts";

const temporaryRoots: string[] = [];

function fixture(): { outputRoot: string; sourceRoot: string; temporaryRoot: string } {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-managed-image-diagnostics-"),
  );
  temporaryRoots.push(temporaryRoot);
  const sourceRoot = path.join(temporaryRoot, "onboard-failures");
  const outputRoot = path.join(temporaryRoot, "sanitized");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(outputRoot);
  return { outputRoot, sourceRoot, temporaryRoot };
}

function bundle(sourceRoot: string, name = "2026-07-29T01-02-03-000Z-agent"): string {
  const directory = path.join(sourceRoot, name);
  fs.mkdirSync(directory);
  return directory;
}

function outputText(outputRoot: string): string {
  return fs
    .readdirSync(outputRoot)
    .flatMap((directory) =>
      fs
        .readdirSync(path.join(outputRoot, directory))
        .map((name) => fs.readFileSync(path.join(outputRoot, directory, name), "utf8")),
    )
    .join("\n");
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe("managed-image failure diagnostic export", () => {
  it.each([
    { scenario: "opaque canary" },
    { scenario: "Docker canary" },
    { scenario: "known token pattern" },
    { scenario: "Bearer token" },
  ])(
    "fully redacts known patterns and opaque credential values before export [$scenario]",
    ({ scenario }) => {
      const { outputRoot, sourceRoot } = fixture();
      const diagnosticBundle = bundle(sourceRoot);
      const opaqueCanary = "opaque-managed-image-secret-canary-928374";
      const dockerCanary = "opaque-docker-password-canary-019283";
      const knownCanary = "ghp_known_pattern_canary_abcdef012345";
      fs.writeFileSync(
        path.join(diagnosticBundle, "summary.txt"),
        [
          `arbitrary opaque output ${opaqueCanary}`,
          `another opaque value ${dockerCanary}`,
          `known token ${knownCanary}`,
          "Authorization: Bearer bearer-known-canary-123456",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(diagnosticBundle, "openshell-gateway-relevant.log"),
        `gateway reconnect failed for ${opaqueCanary}\n`,
      );
      fs.writeFileSync(
        path.join(diagnosticBundle, "rootfs-console.log"),
        "managed startup exited before the supervisor reconnected\n",
      );
      fs.writeFileSync(
        path.join(diagnosticBundle, "unrelated.raw"),
        "this raw file must never enter the artifact\n",
      );

      const result = exportManagedImageFailureDiagnostics({
        env: {
          DOCKERHUB_TOKEN: dockerCanary,
          NEMOCLAW_PROVIDER_KEY: opaqueCanary,
        },
        outputRoot,
        sourceRoot,
      });

      expect(result).toMatchObject({ bundles: 1, files: 3 });
      const exported = outputText(outputRoot);
      expect(exported).toContain("<REDACTED>");
      expect(exported).toContain("managed startup exited before the supervisor reconnected");
      const secret = (
        {
          "opaque canary": opaqueCanary,
          "Docker canary": dockerCanary,
          "known token pattern": knownCanary,
          "Bearer token": "bearer-known-canary-123456",
        } as const
      )[scenario]!;
      expect(exported).not.toContain(secret);

      expect(exported).not.toContain("this raw file must never enter the artifact");
      expect(fs.existsSync(path.join(outputRoot, "bundle-01", "unrelated.raw"))).toBe(false);
    },
  );

  it("fails closed on symlinks without writing a partial artifact", () => {
    const { outputRoot, sourceRoot, temporaryRoot } = fixture();
    const diagnosticBundle = bundle(sourceRoot);
    const target = path.join(temporaryRoot, "outside.txt");
    fs.writeFileSync(target, "raw secret outside the diagnostic root\n");
    fs.symlinkSync(target, path.join(diagnosticBundle, "summary.txt"));

    expect(() => exportManagedImageFailureDiagnostics({ outputRoot, sourceRoot })).toThrow(
      /not a regular file/,
    );
    expect(fs.readdirSync(outputRoot)).toEqual([]);
  });

  it("skips an empty diagnostic file without dropping later evidence", () => {
    const { outputRoot, sourceRoot } = fixture();
    const diagnosticBundle = bundle(sourceRoot);
    fs.writeFileSync(path.join(diagnosticBundle, "openshell-gateway-relevant.log"), "");
    fs.writeFileSync(path.join(diagnosticBundle, "rootfs-console.log"), "console evidence\n");
    fs.writeFileSync(path.join(diagnosticBundle, "summary.txt"), "summary evidence\n");

    expect(exportManagedImageFailureDiagnostics({ outputRoot, sourceRoot })).toMatchObject({
      bundles: 1,
      files: 2,
    });
    expect(
      fs.existsSync(path.join(outputRoot, "bundle-01", "openshell-gateway-relevant.log")),
    ).toBe(false);
    expect(outputText(outputRoot)).toContain("console evidence");
    expect(outputText(outputRoot)).toContain("summary evidence");
  });

  it("fails closed on non-file diagnostic entries", () => {
    const { outputRoot, sourceRoot } = fixture();
    const diagnosticBundle = bundle(sourceRoot);
    fs.mkdirSync(path.join(diagnosticBundle, "rootfs-console.log"));

    expect(() => exportManagedImageFailureDiagnostics({ outputRoot, sourceRoot })).toThrow(
      /not a regular file/,
    );
    expect(fs.readdirSync(outputRoot)).toEqual([]);
  });

  it("bounds bundle count, file count, individual files, and total exported bytes", () => {
    const { outputRoot, sourceRoot } = fixture();
    const largeButReadable = "safe reconnect € evidence\n".repeat(2_500);
    const tooLarge = `raw-oversized-canary\n${"x".repeat(
      MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxSourceFileBytes,
    )}`;
    for (let index = 0; index < MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxBundles + 2; index++) {
      const diagnosticBundle = bundle(
        sourceRoot,
        `2026-07-29T01-02-${String(index).padStart(2, "0")}-000Z-agent`,
      );
      [
        "openshell-gateway-relevant.log",
        "openshell-gateway-tail.log",
        "summary.txt",
      ].forEach((name) => {
        fs.writeFileSync(path.join(diagnosticBundle, name), largeButReadable);
      });
      fs.writeFileSync(path.join(diagnosticBundle, "rootfs-console.log"), tooLarge);
    }

    const result = exportManagedImageFailureDiagnostics({ outputRoot, sourceRoot });
    const outputFiles = fs
      .readdirSync(outputRoot)
      .flatMap((directory) =>
        fs
          .readdirSync(path.join(outputRoot, directory))
          .map((name) => path.join(outputRoot, directory, name)),
      );
    const outputBytes = outputFiles.reduce(
      (total, filePath) => total + fs.statSync(filePath).size,
      0,
    );

    expect(fs.readdirSync(outputRoot).length).toBeLessThanOrEqual(
      MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxBundles,
    );
    expect(fs.readdirSync(outputRoot)).toHaveLength(result.bundles);
    expect(outputFiles.length).toBeLessThanOrEqual(MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxFiles);
    expect(outputFiles.every((filePath) => fs.statSync(filePath).isFile())).toBe(true);
    expect(
      outputFiles.every(
        (filePath) =>
          fs.statSync(filePath).size <= MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxOutputFileBytes,
      ),
    ).toBe(true);
    expect(outputBytes).toBeLessThanOrEqual(
      MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxTotalOutputBytes,
    );
    expect(result.bytes).toBe(outputBytes);
    const exported = outputText(outputRoot);
    expect(exported).toContain("[omitted: source exceeded");
    expect(exported).not.toContain("raw-oversized-canary");
  });
});
