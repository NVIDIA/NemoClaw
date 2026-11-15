// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { readApprovedOpenShellSdkConfig } from "../../../scripts/checks/candidate-openshell-sdk.mts";
import {
  candidateSdkCheckout,
  candidateSdkFixture,
  sdkCandidateIdentity,
} from "../../support/candidate-openshell-sdk.ts";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");

describe("reviewed npm audit entry point", () => {
  it.each([
    {
      stage: "configuration",
      category: "rejected",
      operation: "readFileSync",
      suffix: "ci/reviewed-npm-audit.json",
    },
    {
      stage: "exception-registry",
      category: "ENOENT",
      operation: "readFileSync",
      suffix: "ci/npm-audit-exceptions.json",
    },
    {
      stage: "exception-registry",
      category: "invalid-json",
      operation: "readFileSync",
      suffix: "ci/npm-audit-exceptions.json",
    },
    { stage: "report-directory", category: "EACCES", operation: "mkdirSync", suffix: "reports" },
    { stage: "artifact-path", category: "rejected", operation: null, suffix: "" },
  ])(
    "classifies $stage failures without exposing paths or credentials (#11673)",
    ({ stage, category, operation, suffix }) => {
      const canary = "OPENAI_API_KEY=audit-preflight-secret-canary";
      const entrypoint = path.join(REPO_ROOT, "scripts/audit-reviewed-npm-graph.mts");
      const { nodeVersion } = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, "ci/reviewed-npm-audit.json"), "utf8"),
      );
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-preflight-"));
      try {
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            [
              'import fs from "node:fs";',
              'import { syncBuiltinESMExports } from "node:module";',
              `const operation = ${JSON.stringify(operation)};`,
              "if (operation) { const original = fs[operation]; fs[operation] = function (filename, ...args) {",
              `if (String(filename).endsWith(${JSON.stringify(suffix)})) {`,
              ...(stage === "configuration"
                ? [
                    `return JSON.stringify({ ...JSON.parse(original.call(this, filename, ...args)), archiveGraphId: null, artifactDirectory: ${JSON.stringify(canary)} });`,
                  ]
                : []),
              `const error = new ${category === "invalid-json" ? "SyntaxError" : "Error"}(${JSON.stringify(canary)});`,
              `error.code = ${JSON.stringify(category)}; throw error; }`,
              "return original.call(this, filename, ...args); }; syncBuiltinESMExports(); }",
              `Object.defineProperty(process, "version", { value: ${JSON.stringify(`v${nodeVersion}`)} });`,
              `process.argv[1] = ${JSON.stringify(entrypoint)};`,
              `await import(${JSON.stringify(pathToFileURL(entrypoint).href)});`,
            ].join("\n"),
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NEMOCLAW_REVIEWED_NPM_AUDIT_TARGET_ROOT: root,
              NEMOCLAW_REVIEWED_NPM_AUDIT_REPORT_DIR: operation ? "reports" : `../${canary}`,
            },
          },
        );
        expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
          status: 1,
          stdout: "",
          stderr: `Reviewed npm audit failed. [stage=${stage}; category=${category}]\n`,
        });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("admits the SDK in the controller without forwarding API credentials to npm", async () => {
    const fixture = candidateSdkFixture();
    const responses: Record<string, unknown> = {};
    await readApprovedOpenShellSdkConfig(
      sdkCandidateIdentity,
      async (route) => {
        const value = await fixture.request(route);
        responses[route] = value;
        return value;
      },
      fixture.trustedSource,
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-admitted-audit-entry-"));
    try {
      candidateSdkCheckout(root, fixture);
      const observation = path.join(root, "npm-observation.json");
      const entrypoint = path.join(REPO_ROOT, "scripts/checks/audit-admitted-npm-graph.mts");
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            'import fs from "node:fs";',
            'import childProcess from "node:child_process";',
            'import { syncBuiltinESMExports } from "node:module";',
            `const responses = ${JSON.stringify(responses)};`,
            "globalThis.fetch = async (input, options) => {",
            "const url = new URL(input); const value = responses[url.pathname + url.search];",
            'if (url.origin !== "https://api.github.com" || value === undefined || options.headers.Authorization !== "Bearer fixture-api-token") return new Response("denied", { status: 403 });',
            "return new Response(JSON.stringify(value), { status: 200 }); };",
            "childProcess.spawnSync = (command, args, options) => {",
            `fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ command, args, github: options.env.GITHUB_TOKEN ?? null, gh: options.env.GH_TOKEN ?? null }));`,
            // A deliberate version mismatch stops before package installs or registry access.
            'return { status: 0, stdout: "0.0.0", stderr: "" }; }; syncBuiltinESMExports();',
            `Object.defineProperty(process, "version", { value: ${JSON.stringify(`v${fixture.trusted.nodeVersion}`)} });`,
            `process.argv[1] = ${JSON.stringify(entrypoint)};`,
            `await import(${JSON.stringify(pathToFileURL(entrypoint).href)});`,
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            GITHUB_TOKEN: "fixture-api-token",
            GH_TOKEN: "fixture-gh-token",
            UPGRADE_PR_NUMBER: String(sdkCandidateIdentity.prNumber),
            CHECKOUT_SHA: sdkCandidateIdentity.candidateSha,
            NEMOCLAW_PROTECTED_MANAGED_IMAGE_BASE_SHA: sdkCandidateIdentity.baseSha,
            NEMOCLAW_REVIEWED_NPM_AUDIT_TARGET_ROOT: root,
            NEMOCLAW_REVIEWED_NPM_AUDIT_REPORT_DIR: "reports",
          },
        },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("[stage=npm-version; category=rejected]");
      expect(JSON.parse(fs.readFileSync(observation, "utf8"))).toEqual({
        command: "npm",
        args: ["--version"],
        github: null,
        gh: null,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("can be imported when the process entry-point path does not exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-missing-audit-entry-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `process.argv[1] = ${JSON.stringify(path.join(root, "missing-entrypoint"))}; await import(${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "scripts/audit-reviewed-npm-graph.mts")).href)});`,
        ],
        { encoding: "utf8" },
      );

      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
