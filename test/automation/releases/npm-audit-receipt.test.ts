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
const NPM_INTEGRITY =
  "sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9QlixX+zdaSNHsd0qUXsbDLr50xzY6Sw7cJVr0uzHKDOle0swmPW/p5Qw==";
const inputs = {
  graphId: "mcporter-runtime",
  npmIntegrity: NPM_INTEGRITY,
  npmVersion: "12.0.2",
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
    npmIntegrity: inputs.npmIntegrity,
    npmVersion: inputs.npmVersion,
    packageJson: inputs.packageJson,
    packageLock: inputs.packageLock,
    rawResponse:
      '{"vulnerabilities":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}',
    registryOrigin: inputs.registryOrigin,
    severityThreshold: "high",
  });
}

describe("reviewed npm audit receipt", () => {
  it("canonically binds all receipt inputs and verifies a fresh passing result", () => {
    const parsed = parseAndVerifyAuditReceipt(canonicalAuditReceipt(receipt()), inputs);
    expect(parsed.acceptedAdvisoryIds).toEqual(["GHSA-a", "GHSA-b"]);
    expect(parsed.argv).toEqual([
      "audit",
      "--registry=https://registry.yarnpkg.com",
      "--omit=dev",
      "--json",
    ]);
    expect(new Date(parsed.expiresAt).getTime() - NOW.getTime()).toBeLessThan(12 * 60 * 60 * 1000);
  });

  it("rejects a legacy npmjs receipt", () => {
    const legacy = {
      ...receipt(),
      argv: ["audit", "--omit=dev", "--json"],
      registryOrigin: "https://registry.npmjs.org/",
    };
    expect(() => parseAndVerifyAuditReceipt(canonicalAuditReceipt(legacy), inputs)).toThrow(
      /registry/,
    );
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
    [
      "different npm integrity",
      (value: any) => {
        value.npmIntegrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
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
        JSON.stringify({ npmIntegrity: inputs.npmIntegrity, npmVersion: inputs.npmVersion }),
      );
      fs.writeFileSync(path.join(root, "receipt.json"), canonicalAuditReceipt(receipt(new Date())));
      const verifierArgs = [
        "--experimental-strip-types",
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
        JSON.stringify({ npmIntegrity: inputs.npmIntegrity, npmVersion: "11.18.0" }),
      );
      fs.writeFileSync(path.join(root, "receipt.json"), canonicalAuditReceipt(receipt(new Date())));

      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
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
        "receipt identity does not match expected graph and npm artifact",
      );
      expect(fs.existsSync(resultFile)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["--raw-copy", "copied-raw.json"],
    ["--legacy-npmjs", "true"],
  ])("rejects the removed %s option before writing output", (option, optionValue) => {
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
        JSON.stringify({ npmIntegrity: inputs.npmIntegrity, npmVersion: inputs.npmVersion }),
      );
      fs.writeFileSync(path.join(root, "receipt.json"), canonicalAuditReceipt(receipt(new Date())));

      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
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
          option,
          option === "--raw-copy" ? rawCopyFile : optionValue,
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
});
