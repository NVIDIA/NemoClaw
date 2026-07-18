// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditOpenShellPolicyMutationReads,
  countPolicyReadCalls,
  discoverPolicyReadSites,
} from "../scripts/checks/openshell-policy-mutation-read.mts";

describe("OpenShell policy mutation read discovery (#6921)", () => {
  it("counts canonical builder bindings and direct argv reads", () => {
    const source = [
      'import { buildPolicyGetCommand as buildBase } from "./policy/commands";',
      'import * as policyBuilders from "./policy/index";',
      'const { buildPolicyGetFullCommand: buildFull } = require("./policy");',
      'const requiredPolicyBuilders = require("./policy");',
      "// buildPolicyGetCommand(commentedSandbox);",
      'const decoy = "buildPolicyGetFullCommand(stringSandbox)";',
      "buildBase(sandboxName);",
      "policyBuilders.buildPolicyGetCommand(sandboxName);",
      'policyBuilders["buildPolicyGetFullCommand"](sandboxName);',
      "buildFull(sandboxName);",
      "requiredPolicyBuilders.buildPolicyGetCommand(sandboxName);",
      '["openshell", "policy", "get", "--base", sandboxName];',
      '["policy", "get", "--full", sandboxName];',
      'const arrayDecoy = `["policy", "get", "--base", sandboxName]`;',
      '["not-openshell", "policy", "get", "--base", sandboxName];',
    ].join("\n");

    expect(countPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toBe(7);
  });

  it("ignores similarly named calls without canonical policy bindings", () => {
    const source = [
      'import { buildPolicyGetCommand as unrelated } from "./fixture-helpers";',
      'import * as fixtureBuilders from "./fixture-helpers";',
      'const requiredFixtureBuilders = require("./fixture-helpers");',
      "const fixture = { buildPolicyGetCommand() {}, buildPolicyGetFullCommand() {} };",
      "unrelated(sandboxName);",
      "fixtureBuilders.buildPolicyGetCommand(sandboxName);",
      "requiredFixtureBuilders.buildPolicyGetFullCommand(sandboxName);",
      "fixture.buildPolicyGetCommand(sandboxName);",
      'fixture["buildPolicyGetFullCommand"](sandboxName);',
    ].join("\n");

    expect(countPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toBe(0);
  });

  it("ignores a named policy builder import when a nested binding shadows its alias", () => {
    const source = [
      'import { buildPolicyGetCommand as buildBase } from "./policy/commands";',
      "buildBase(rootSandbox);",
      "function inspect(buildBase: (sandbox: string) => string[]) {",
      "  buildBase(shadowedSandbox);",
      "}",
    ].join("\n");

    expect(countPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toBe(1);
  });

  it("ignores a namespace policy import when a nested binding shadows its alias", () => {
    const source = [
      'import * as policyBuilders from "./policy/index";',
      "policyBuilders.buildPolicyGetCommand(rootSandbox);",
      "function inspect(policyBuilders: Record<string, (sandbox: string) => string[]>) {",
      "  policyBuilders.buildPolicyGetCommand(shadowedSandbox);",
      '  policyBuilders["buildPolicyGetFullCommand"](shadowedSandbox);',
      "}",
    ].join("\n");

    expect(countPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toBe(1);
  });

  it("ignores policy-shaped modules outside the repository-root canonical policy path", () => {
    const source = [
      'import { buildPolicyGetCommand as decoyBase } from "./vendor/src/lib/policy";',
      'import * as decoyBuilders from "./vendor/src/lib/policy/commands";',
      'const requiredDecoyBuilders = require("./vendor/src/lib/policy/index");',
      "decoyBase(sandboxName);",
      "decoyBuilders.buildPolicyGetFullCommand(sandboxName);",
      "requiredDecoyBuilders.buildPolicyGetCommand(sandboxName);",
    ].join("\n");

    expect(countPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toBe(0);
  });

  it("discovers builder and direct policy reads in new production files", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-read-discovery-"));
    const mutationPath = path.join(repoRoot, "src", "lib", "new-policy-mutation.ts");
    const diagnosticPath = path.join(repoRoot, "nemoclaw", "src", "new-policy-diagnostic.ts");
    fs.mkdirSync(path.dirname(mutationPath), { recursive: true });
    fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });
    fs.writeFileSync(
      mutationPath,
      [
        'import { buildPolicyGetCommand } from "./policy/commands";',
        "runCapture(buildPolicyGetCommand(sandboxName));",
      ].join("\n"),
    );
    fs.writeFileSync(
      diagnosticPath,
      'runCmd(["openshell", "policy", "get", "--full", sandboxName]);\n',
    );

    try {
      expect(discoverPolicyReadSites(repoRoot)).toEqual([
        { relativePath: "nemoclaw/src/new-policy-diagnostic.ts", readCalls: 1 },
        { relativePath: "src/lib/new-policy-mutation.ts", readCalls: 1 },
      ]);
      expect(auditOpenShellPolicyMutationReads(repoRoot)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("new-policy-diagnostic.ts: found 1 unaccounted policy read"),
          expect.stringContaining("new-policy-mutation.ts: found 1 unaccounted policy read"),
        ]),
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
