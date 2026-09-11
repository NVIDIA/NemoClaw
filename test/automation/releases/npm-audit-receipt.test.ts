// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalAuditReceipt,
  createAuditReceipt,
  parseAndVerifyAuditReceipt,
  sha256,
} from "../../../scripts/lib/npm-audit-receipt.mts";

const NOW = new Date("2026-09-04T00:00:00.000Z");
const reviewedNpmIdentity = {
  npmArchiveSha256: "5dbb86c71d07a1957f2e90734092dd6a58bdcd9ebc2d8d41ca1c6e6a21d364e1",
  npmIntegrity:
    "sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9QlixX+zdaSNHsd0qUXsbDLr50xzY6Sw7cJVr0uzHKDOle0swmPW/p5Qw==",
  npmVersion: "12.0.2",
};
const inputs = {
  graphId: "mcporter-runtime",
  reviewedNpmIdentity,
  exceptionPolicy: '{"schemaVersion":1,"exceptions":[]}\n',
  severityThreshold: "high",
  packageJson: "package",
  packageLock: "lock",
  rawResponse:
    '{"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}',
  registryOrigin: "https://registry.yarnpkg.com",
  now: NOW,
} as const;
function receipt(createdAt = NOW) {
  return createAuditReceipt({
    acceptedAdvisoryIds: ["GHSA-b", "GHSA-a"],
    blockingAdvisoryIds: [],
    createdAt,
    exceptionPolicySha256: sha256(inputs.exceptionPolicy),
    graphId: inputs.graphId,
    reviewedNpmIdentity,
    packageJson: inputs.packageJson,
    packageLock: inputs.packageLock,
    rawResponse:
      '{"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}',
    registryOrigin: inputs.registryOrigin,
    severityThreshold: "high",
  });
}

describe("npm audit receipt", () => {
  it("canonically binds all receipt inputs and verifies a fresh passing result", () => {
    const parsed = parseAndVerifyAuditReceipt(canonicalAuditReceipt(receipt()), inputs);
    expect(parsed.acceptedAdvisoryIds).toEqual(["GHSA-a", "GHSA-b"]);
    expect(parsed.argv).toEqual([
      "audit",
      "--registry=https://registry.yarnpkg.com",
      "--omit=dev",
      "--json",
    ]);
    expect(parsed).toMatchObject(reviewedNpmIdentity);
    expect(new Date(parsed.expiresAt).getTime() - NOW.getTime()).toBeLessThan(12 * 60 * 60 * 1000);
  });

  it("rejects a receipt that omits the reviewed npm archive identity", () => {
    const {
      npmArchiveSha256: _npmArchiveSha256,
      npmIntegrity: _npmIntegrity,
      ...versionOnly
    } = receipt();
    const incomplete = {
      ...versionOnly,
      argv: ["audit", "--omit=dev", "--json"],
      registryOrigin: "https://registry.npmjs.org/",
      schemaVersion: 1,
    } as const;
    expect(() => parseAndVerifyAuditReceipt(JSON.stringify(incomplete), inputs)).toThrow(
      /unexpected or missing keys/,
    );
  });

  it.each([
    [
      "SHA-512 SRI",
      { ...reviewedNpmIdentity, npmIntegrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` },
    ],
    ["archive SHA-256", { ...reviewedNpmIdentity, npmArchiveSha256: "1".repeat(64) }],
  ] as const)("rejects a receipt when the expected npm %s changes", (_field, changedIdentity) => {
    expect(() =>
      parseAndVerifyAuditReceipt(canonicalAuditReceipt(receipt()), {
        ...inputs,
        reviewedNpmIdentity: changedIdentity,
      }),
    ).toThrow(/receipt identity/);
  });

  it("rejects a receipt whose registry identity differs from its audit command", () => {
    expect(() =>
      parseAndVerifyAuditReceipt(canonicalAuditReceipt(receipt()), {
        ...inputs,
        registryOrigin: "https://registry.npmjs.org/",
      }),
    ).toThrow(/registry/);
  });

  it.each([
    [
      "extra key",
      (value: any) => {
        value.extra = true;
      },
    ],
    [
      "changed command",
      (value: any) => {
        value.argv = ["audit", "--json"];
      },
    ],
    [
      "blocking result",
      (value: any) => {
        value.blockingAdvisoryIds = ["GHSA-x"];
      },
    ],
    [
      "long lifetime",
      (value: any) => {
        value.expiresAt = new Date(NOW.getTime() + 12 * 60 * 60 * 1000).toISOString();
      },
    ],
    [
      "weaker threshold",
      (value: any) => {
        value.severityThreshold = "critical";
      },
    ],
    [
      "different exception policy",
      (value: any) => {
        value.exceptionPolicySha256 = "a".repeat(64);
      },
    ],
  ])("fails closed for %s", (_label, mutate) => {
    const value: any = receipt();
    mutate(value);
    expect(() => parseAndVerifyAuditReceipt(JSON.stringify(value), inputs)).toThrow();
  });

  it("rejects expiry, excessive future skew, and graph bytes that differ", () => {
    expect(() =>
      parseAndVerifyAuditReceipt(
        canonicalAuditReceipt(receipt(new Date(NOW.getTime() - 12 * 60 * 60 * 1000))),
        inputs,
      ),
    ).toThrow(/expired/);
    expect(() =>
      parseAndVerifyAuditReceipt(
        canonicalAuditReceipt(receipt(new Date(NOW.getTime() + 5 * 60 * 1000 + 1))),
        inputs,
      ),
    ).toThrow(/future/);
    expect(() =>
      parseAndVerifyAuditReceipt(canonicalAuditReceipt(receipt()), {
        ...inputs,
        packageLock: "changed",
      }),
    ).toThrow(/packageLockSha256/);
  });

  it("provides a local CLI verifier for a BuildKit secret mount", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-cli-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), inputs.packageJson);
      fs.writeFileSync(path.join(root, "package-lock.json"), inputs.packageLock);
      fs.writeFileSync(path.join(root, "exceptions.json"), inputs.exceptionPolicy);
      fs.writeFileSync(path.join(root, "raw.json"), inputs.rawResponse);
      fs.writeFileSync(
        path.join(root, "reviewed-npm-audit.json"),
        JSON.stringify(reviewedNpmIdentity),
      );
      fs.writeFileSync(path.join(root, "receipt.json"), canonicalAuditReceipt(receipt(new Date())));
      const verifierArgs = [
        path.join(import.meta.dirname, "../../../scripts/lib/npm-audit-receipt.mts"),
        "--receipt",
        path.join(root, "receipt.json"),
        "--package-json",
        path.join(root, "package.json"),
        "--package-lock",
        path.join(root, "package-lock.json"),
        "--raw-report",
        path.join(root, "raw.json"),
        "--exceptions",
        path.join(root, "exceptions.json"),
        "--graph",
        inputs.graphId,
        "--audit-config",
        path.join(root, "reviewed-npm-audit.json"),
        "--registry",
        inputs.registryOrigin,
        "--threshold",
        inputs.severityThreshold,
      ];
      const result = spawnSync(process.execPath, verifierArgs, { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("current policy verified");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects the removed raw-copy option before writing either output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-removed-option-"));
    const resultFile = path.join(root, "policy.json");
    const rawCopyFile = path.join(root, "copied-raw.json");
    try {
      fs.writeFileSync(path.join(root, "package.json"), inputs.packageJson);
      fs.writeFileSync(path.join(root, "package-lock.json"), inputs.packageLock);
      fs.writeFileSync(path.join(root, "exceptions.json"), inputs.exceptionPolicy);
      fs.writeFileSync(path.join(root, "raw.json"), inputs.rawResponse);
      fs.writeFileSync(
        path.join(root, "reviewed-npm-audit.json"),
        JSON.stringify(reviewedNpmIdentity),
      );
      fs.writeFileSync(path.join(root, "receipt.json"), canonicalAuditReceipt(receipt(new Date())));

      const result = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "../../../scripts/lib/npm-audit-receipt.mts"),
          "--receipt",
          path.join(root, "receipt.json"),
          "--package-json",
          path.join(root, "package.json"),
          "--package-lock",
          path.join(root, "package-lock.json"),
          "--raw-report",
          path.join(root, "raw.json"),
          "--exceptions",
          path.join(root, "exceptions.json"),
          "--graph",
          inputs.graphId,
          "--audit-config",
          path.join(root, "reviewed-npm-audit.json"),
          "--registry",
          inputs.registryOrigin,
          "--threshold",
          inputs.severityThreshold,
          "--result",
          resultFile,
          "--raw-copy",
          rawCopyFile,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unexpected or missing keys");
      expect(fs.existsSync(resultFile)).toBe(false);
      expect(fs.existsSync(rawCopyFile)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects a receipt produced by a different npm artifact before writing a result", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-npm-identity-"));
    const resultFile = path.join(root, "policy.json");
    try {
      fs.writeFileSync(path.join(root, "package.json"), inputs.packageJson);
      fs.writeFileSync(path.join(root, "package-lock.json"), inputs.packageLock);
      fs.writeFileSync(path.join(root, "exceptions.json"), inputs.exceptionPolicy);
      fs.writeFileSync(path.join(root, "raw.json"), inputs.rawResponse);
      fs.writeFileSync(
        path.join(root, "reviewed-npm-audit.json"),
        JSON.stringify({ ...reviewedNpmIdentity, npmVersion: "11.18.0" }),
      );
      fs.writeFileSync(path.join(root, "receipt.json"), canonicalAuditReceipt(receipt(new Date())));

      const result = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "../../../scripts/lib/npm-audit-receipt.mts"),
          "--receipt",
          path.join(root, "receipt.json"),
          "--package-json",
          path.join(root, "package.json"),
          "--package-lock",
          path.join(root, "package-lock.json"),
          "--raw-report",
          path.join(root, "raw.json"),
          "--exceptions",
          path.join(root, "exceptions.json"),
          "--graph",
          inputs.graphId,
          "--audit-config",
          path.join(root, "reviewed-npm-audit.json"),
          "--registry",
          inputs.registryOrigin,
          "--threshold",
          inputs.severityThreshold,
          "--result",
          resultFile,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "receipt identity does not match expected graph and reviewed npm",
      );
      expect(fs.existsSync(resultFile)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
