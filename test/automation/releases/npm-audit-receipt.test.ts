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
  LEGACY_NPM_AUDIT_RECEIPT_DEADLINE,
  parseAndVerifyAuditReceipt,
  sha256,
} from "../../../scripts/lib/npm-audit-receipt.mts";

const NOW = new Date("2026-09-04T00:00:00.000Z");
const inputs = {
  graphId: "mcporter-runtime",
  npmVersion: "10.9.4",
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

  it("accepts a legacy npmjs receipt only through the explicit transition option", () => {
    const legacy = {
      ...receipt(),
      argv: ["audit", "--omit=dev", "--json"],
      registryOrigin: "https://registry.npmjs.org/",
    };
    expect(() => parseAndVerifyAuditReceipt(canonicalAuditReceipt(legacy), inputs)).toThrow(
      /registry/,
    );
    expect(
      parseAndVerifyAuditReceipt(canonicalAuditReceipt(legacy), {
        ...inputs,
        allowLegacyNpmjsReceipt: true,
      }).registryOrigin,
    ).toBe("https://registry.npmjs.org/");
    expect(() =>
      parseAndVerifyAuditReceipt(canonicalAuditReceipt(legacy), {
        ...inputs,
        allowLegacyNpmjsReceipt: true,
        now: new Date(LEGACY_NPM_AUDIT_RECEIPT_DEADLINE),
      }),
    ).toThrow(/allowed contract/);
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

  it.each([
    { legacy: false, registry: inputs.registryOrigin, unflaggedStatus: 0, unflaggedStderr: "" },
    {
      legacy: true,
      registry: "https://registry.npmjs.org/",
      unflaggedStatus: 1,
      unflaggedStderr: "receipt npm audit registry and arguments do not match an allowed contract",
    },
  ])(
    "provides a local CLI verifier for a BuildKit secret mount ($legacy)",
    ({ legacy, registry, unflaggedStatus, unflaggedStderr }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-cli-"));
      try {
        fs.writeFileSync(path.join(root, "package.json"), inputs.packageJson);
        fs.writeFileSync(path.join(root, "package-lock.json"), inputs.packageLock);
        fs.writeFileSync(path.join(root, "exceptions.json"), inputs.exceptionPolicy);
        fs.writeFileSync(path.join(root, "raw.json"), inputs.rawResponse);
        fs.writeFileSync(
          path.join(root, "reviewed-npm-audit.json"),
          JSON.stringify({ npmVersion: inputs.npmVersion }),
        );
        const auditReceipt = legacy
          ? {
              ...receipt(new Date()),
              argv: ["audit", "--omit=dev", "--json"],
              registryOrigin: registry,
            }
          : receipt(new Date());
        fs.writeFileSync(path.join(root, "receipt.json"), canonicalAuditReceipt(auditReceipt));
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
          registry,
          "--threshold",
          inputs.severityThreshold,
          ...(legacy ? ["--legacy-npmjs", "true"] : []),
        ];
        const result = spawnSync(process.execPath, verifierArgs, { encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("current policy verified");
        const unflaggedArgs = legacy ? verifierArgs.slice(0, -2) : verifierArgs;
        const withoutMigrationFlag = spawnSync(process.execPath, unflaggedArgs, {
          encoding: "utf8",
        });
        expect(withoutMigrationFlag.status).toBe(unflaggedStatus);
        expect(withoutMigrationFlag.stderr).toContain(unflaggedStderr);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      error: "",
      label: "the canonical npm version",
      npmVersion: inputs.npmVersion,
      policy: { graph: inputs.graphId, status: "clean" },
      rawCopy: inputs.rawResponse,
      status: 0,
    },
    {
      error: "receipt identity does not match expected graph and npm",
      label: "a mismatched npm version",
      npmVersion: "11.18.0",
      policy: undefined,
      rawCopy: undefined,
      status: 1,
    },
  ])(
    "executes the receipt producer-to-Docker-consumer contract for $label",
    ({ error, npmVersion, policy, rawCopy, status }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-docker-contract-"));
      const resultFile = path.join(root, "policy.json");
      const rawCopyFile = path.join(root, "copied-raw.json");
      try {
        fs.writeFileSync(path.join(root, "package.json"), inputs.packageJson);
        fs.writeFileSync(path.join(root, "package-lock.json"), inputs.packageLock);
        fs.writeFileSync(path.join(root, "exceptions.json"), inputs.exceptionPolicy);
        fs.writeFileSync(path.join(root, "raw.json"), inputs.rawResponse);
        fs.writeFileSync(
          path.join(root, "receipt.json"),
          canonicalAuditReceipt(receipt(new Date())),
        );
        fs.writeFileSync(
          path.join(root, "reviewed-npm-audit.json"),
          JSON.stringify({ npmVersion }),
        );

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
            "--raw-copy",
            rawCopyFile,
          ],
          { encoding: "utf8" },
        );

        expect(result.status, result.stderr).toBe(status);
        expect(fs.existsSync(resultFile)).toBe(status === 0);
        expect(fs.existsSync(rawCopyFile)).toBe(status === 0);
        const observedPolicy = fs.existsSync(resultFile)
          ? (JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<string, unknown>)
          : undefined;
        expect(
          observedPolicy === undefined
            ? undefined
            : { graph: observedPolicy.graph, status: observedPolicy.status },
        ).toEqual(policy);
        expect(fs.existsSync(rawCopyFile) ? fs.readFileSync(rawCopyFile, "utf8") : undefined).toBe(
          rawCopy,
        );
        expect(result.stderr).toContain(error);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
