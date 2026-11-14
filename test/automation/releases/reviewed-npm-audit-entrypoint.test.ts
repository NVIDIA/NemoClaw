// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

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
