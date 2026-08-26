// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditOpenShellPolicyMutationReads,
  classifyPolicyReadCalls,
  countPolicyReadCalls,
  discoverPolicyReadSites,
} from "../../../scripts/checks/openshell-policy-mutation-read.mts";

function createShieldsAuditFixture(source: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shields-read-audit-"));
  const sourcePath = path.join(repoRoot, "src", "lib", "shields", "index.ts");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, source);
  return repoRoot;
}

function shieldsAuditSource(
  downRead = "runCapture(buildPolicyGetCommand(sandboxName));",
  extraRead = "",
  aliasDeclaration = "",
  ignoreErrors = true,
): string {
  const downFunction = ignoreErrors
    ? [
        "function shieldsDownWithoutHostLock(sandboxName: string) {",
        "  try {",
        `    ${downRead}`,
        "  } catch {",
        "    return;",
        "  }",
        "}",
      ]
    : ["function shieldsDownWithoutHostLock(sandboxName: string) {", `  ${downRead}`, "}"];
  return [
    'const { buildPolicyGetCommand, buildPolicyGetFullCommand } = require("../policy");',
    'const { runCapture } = require("../runner");',
    aliasDeclaration,
    ...downFunction,
    extraRead,
  ].join("\n");
}

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

  it("classifies gateway-pinned direct policy reads", () => {
    const source = [
      "function actionApply(gateway: string, sandboxName: string) {",
      '  return runCmd(["openshell", "policy", "get", "-g", gateway, "--base", sandboxName], { reject: false });',
      "}",
      "function inspectAuthority(gateway: string, sandboxName: string) {",
      '  return runCmd(["openshell", "policy", "get", "-g", gateway, "--full", "--output", "json", sandboxName]);',
      "}",
    ].join("\n");

    expect(classifyPolicyReadCalls(source, "/repo/nemoclaw/src/blueprint/runner.ts", "/repo"))
      .toEqual([
        { site: "actionApply", view: "base", failureHandling: "error-preserving" },
        {
          site: "inspectAuthority",
          view: "full",
          failureHandling: "error-preserving",
        },
      ]);
  });

  it("ignores direct policy reads with ambiguous view flags (#9833)", () => {
    const source = [
      "function both(sandboxName: string) {",
      '  return runCmd(["openshell", "policy", "get", "--base", "--full", sandboxName]);',
      "}",
      "function neither(sandboxName: string) {",
      '  return runCmd(["openshell", "policy", "get", sandboxName]);',
      "}",
    ].join("\n");

    expect(classifyPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toEqual([]);
  });

  it("classifies each read by function, policy view, and failure handling", () => {
    const source = [
      'import { buildPolicyGetCommand as buildBase, buildPolicyGetFullCommand as buildFull } from "./policy/commands";',
      "let readPolicy = buildBase;",
      "function preserve(sandboxName: string) {",
      "  return runCapture(readPolicy(sandboxName));",
      "}",
      "const ignore = (sandboxName: string) =>",
      "  runCapture(buildFull(sandboxName), { ignoreError: true });",
      "function unknown(sandboxName: string) {",
      "  return execute(buildBase(sandboxName));",
      "}",
    ].join("\n");

    expect(classifyPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toEqual([
      { site: "preserve", view: "base", failureHandling: "error-preserving" },
      { site: "ignore", view: "full", failureHandling: "ignore-error" },
      { site: "unknown", view: "base", failureHandling: "unclassified" },
    ]);
  });

  it("discovers a full builder destructured from a canonical namespace import", () => {
    const source = [
      'import * as policy from "./policy/commands";',
      "function inspectPolicy(sandboxName: string) {",
      "  const { buildPolicyGetFullCommand: readPolicy } = policy;",
      "  return runCapture(readPolicy(sandboxName));",
      "}",
    ].join("\n");

    expect(classifyPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toEqual([
      { site: "inspectPolicy", view: "full", failureHandling: "error-preserving" },
    ]);
  });

  it("discovers a literal computed builder destructured from a policy namespace", () => {
    const source = [
      'import * as policy from "./policy/commands";',
      "function inspectPolicy(sandboxName: string) {",
      '  const { ["buildPolicyGetFullCommand"]: readPolicy } = policy;',
      "  return runCapture(readPolicy(sandboxName));",
      "}",
    ].join("\n");

    expect(classifyPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toEqual([
      { site: "inspectPolicy", view: "full", failureHandling: "error-preserving" },
    ]);
  });

  it("follows an object-rest policy namespace alias", () => {
    const source = [
      'import * as policy from "./policy/commands";',
      "function inspectPolicy(sandboxName: string) {",
      "  return runCapture(policyAlias.buildPolicyGetFullCommand(sandboxName));",
      "}",
      "const { ...firstPolicyAlias } = policy;",
      "const policyAlias = firstPolicyAlias;",
    ].join("\n");

    expect(classifyPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toEqual([
      { site: "inspectPolicy", view: "full", failureHandling: "error-preserving" },
    ]);
  });

  it("follows chained namespace aliases before destructuring a builder", () => {
    const source = [
      'import * as policy from "./policy/commands";',
      "function inspectPolicy(sandboxName: string) {",
      "  const { buildPolicyGetCommand: readPolicy } = policyAlias;",
      "  return runCapture(readPolicy(sandboxName));",
      "}",
      "const firstPolicyAlias = policy;",
      "const policyAlias = firstPolicyAlias;",
    ].join("\n");

    expect(classifyPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toEqual([
      { site: "inspectPolicy", view: "base", failureHandling: "error-preserving" },
    ]);
  });

  it("classifies empty and fallback catches as ignored runner failures", () => {
    const source = [
      'import { buildPolicyGetCommand } from "./policy/commands";',
      "function inspectPolicy(sandboxName: string) {",
      "  try {",
      "    return runCapture(buildPolicyGetCommand(sandboxName));",
      "  } catch {}",
      "}",
      "function inspectFallbackPolicy(sandboxName: string) {",
      '  let rawPolicy = "";',
      "  try {",
      "    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName));",
      "  } catch {",
      '    rawPolicy = "";',
      "  }",
      "  return rawPolicy;",
      "}",
    ].join("\n");

    expect(classifyPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toEqual([
      { site: "inspectPolicy", view: "base", failureHandling: "ignore-error" },
      {
        site: "inspectFallbackPolicy",
        view: "base",
        failureHandling: "ignore-error",
      },
    ]);
  });

  it("leaves conditional catch exits unclassified", () => {
    const source = [
      'import { buildPolicyGetCommand } from "./policy/commands";',
      "function inspectPolicy(sandboxName: string) {",
      "  try {",
      "    return runCapture(buildPolicyGetCommand(sandboxName));",
      "  } catch (error) {",
      "    switch (String(error)) {",
      '      case "retry":',
      "        throw error;",
      "    }",
      "  }",
      "}",
      "function inspectPolicyWithEarlyExit(sandboxName: string) {",
      "  try {",
      "    return runCapture(buildPolicyGetCommand(sandboxName));",
      "  } catch (error) {",
      "    switch (String(error)) {",
      '      case "ignore":',
      '        return "";',
      "    }",
      "    throw error;",
      "  }",
      "}",
    ].join("\n");

    expect(classifyPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toEqual([
      { site: "inspectPolicy", view: "base", failureHandling: "unclassified" },
      {
        site: "inspectPolicyWithEarlyExit",
        view: "base",
        failureHandling: "unclassified",
      },
    ]);
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

  it("ignores locally shadowed CommonJS require and OpenShell resolver decoys", () => {
    const source = [
      "const require = () => ({ buildPolicyGetCommand: () => [] });",
      'const { buildPolicyGetCommand } = require("./policy");',
      "function resolveOpenshellBinary() { return 'openshell'; }",
      "buildPolicyGetCommand(sandboxName);",
      '[resolveOpenshellBinary(), "policy", "get", "--base", sandboxName];',
    ].join("\n");

    expect(countPolicyReadCalls(source, "/repo/src/lib/fixture.ts", "/repo")).toBe(0);
  });

  it("ignores a nested resolver shadow in the canonical policy command module", () => {
    const source = [
      "function resolveOpenshellBinary() { return 'openshell'; }",
      "function inspect(resolveOpenshellBinary: () => string) {",
      '  return [resolveOpenshellBinary(), "policy", "get", "--base", sandboxName];',
      "}",
    ].join("\n");

    expect(countPolicyReadCalls(source, "/repo/src/lib/policy/commands.ts", "/repo")).toBe(0);
  });

  it("ignores a nested resolver function in the canonical policy command module", () => {
    const source = [
      "function resolveOpenshellBinary() { return 'openshell'; }",
      "function inspect() {",
      "  function resolveOpenshellBinary() { return 'decoy'; }",
      '  return [resolveOpenshellBinary(), "policy", "get", "--base", sandboxName];',
      "}",
    ].join("\n");

    expect(countPolicyReadCalls(source, "/repo/src/lib/policy/commands.ts", "/repo")).toBe(0);
  });

  it("counts the canonical policy command resolver arrays", () => {
    const source = [
      "function resolveOpenshellBinary() { return 'openshell'; }",
      'const base = [resolveOpenshellBinary(), "policy", "get", "--base", sandboxName];',
      'const full = [resolveOpenshellBinary(), "policy", "get", "--full", sandboxName];',
    ].join("\n");

    expect(countPolicyReadCalls(source, "/repo/src/lib/policy/commands.ts", "/repo")).toBe(2);
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
        {
          relativePath: "nemoclaw/src/new-policy-diagnostic.ts",
          readCalls: 1,
          reads: [{ site: "<module>", view: "full", failureHandling: "error-preserving" }],
        },
        {
          relativePath: "src/lib/new-policy-mutation.ts",
          readCalls: 1,
          reads: [{ site: "<module>", view: "base", failureHandling: "error-preserving" }],
        },
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

  it("rejects an aliased full read substituted at an approved Shields site", () => {
    const source = shieldsAuditSource(
      "runCapture(readPolicy(sandboxName));",
      "",
      "const readPolicy = buildPolicyGetFullCommand;",
    );
    const repoRoot = createShieldsAuditFixture(source);

    try {
      expect(
        countPolicyReadCalls(source, path.join(repoRoot, "src/lib/shields/index.ts"), repoRoot),
      ).toBe(1);
      expect(auditOpenShellPolicyMutationReads(repoRoot)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("shieldsDownWithoutHostLock (full, ignore-error)"),
        ]),
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects a destructured full builder substituted at an approved Shields site", () => {
    const source = shieldsAuditSource(
      "runCapture(readPolicy(sandboxName));",
      "",
      [
        'const policyNamespace = require("../policy");',
        "const policyAlias = policyNamespace;",
        "const { buildPolicyGetFullCommand: readPolicy } = policyAlias;",
      ].join("\n"),
    );
    const repoRoot = createShieldsAuditFixture(source);

    try {
      expect(
        countPolicyReadCalls(source, path.join(repoRoot, "src/lib/shields/index.ts"), repoRoot),
      ).toBe(1);
      expect(auditOpenShellPolicyMutationReads(repoRoot)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("shieldsDownWithoutHostLock (full, ignore-error)"),
        ]),
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects error-preserving behavior substituted at an approved Shields site", () => {
    const source = shieldsAuditSource(
      "runCapture(buildPolicyGetCommand(sandboxName));",
      "",
      "",
      false,
    );
    const repoRoot = createShieldsAuditFixture(source);

    try {
      expect(
        countPolicyReadCalls(source, path.join(repoRoot, "src/lib/shields/index.ts"), repoRoot),
      ).toBe(1);
      expect(auditOpenShellPolicyMutationReads(repoRoot)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("shieldsDownWithoutHostLock (base, error-preserving)"),
        ]),
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects moving a Shields read to an unapproved site without changing the count", () => {
    const source = shieldsAuditSource(
      "return;",
      [
        "function inspectAnotherPolicy(sandboxName: string) {",
        "  runCapture(buildPolicyGetCommand(sandboxName));",
        "}",
      ].join("\n"),
    );
    const repoRoot = createShieldsAuditFixture(source);

    try {
      expect(
        countPolicyReadCalls(source, path.join(repoRoot, "src/lib/shields/index.ts"), repoRoot),
      ).toBe(1);
      expect(auditOpenShellPolicyMutationReads(repoRoot)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("inspectAnotherPolicy (base, error-preserving)"),
        ]),
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
