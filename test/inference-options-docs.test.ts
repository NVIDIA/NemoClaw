// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as TypeScript from "typescript";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof TypeScript;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inferenceOptionsPath = path.join(repoRoot, "docs", "inference", "inference-options.mdx");
const inferenceConfigPath = path.join(repoRoot, "src", "lib", "inference", "config.ts");
const modelPromptsPath = path.join(repoRoot, "src", "lib", "inference", "model-prompts.ts");

/**
 * Removes TypeScript `as const` wrappers before inspecting literal AST nodes.
 */
function unwrapConstAssertion(expression: TypeScript.Expression): TypeScript.Expression {
  return ts.isAsExpression(expression) ? unwrapConstAssertion(expression.expression) : expression;
}

function readExportedConstInitializer(
  sourcePath: string,
  exportName: string,
): { sourceFile: TypeScript.SourceFile; initializer: TypeScript.Expression } {
  const source = fs.readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);

  const declaration = sourceFile.statements
    .filter(
      (statement): statement is TypeScript.VariableStatement =>
        ts.isVariableStatement(statement) &&
        (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
          false),
    )
    .flatMap((statement) => Array.from(statement.declarationList.declarations))
    .find((candidate) => candidate.name.getText(sourceFile) === exportName);
  expect(declaration).toBeTruthy();

  const initializer = declaration?.initializer && unwrapConstAssertion(declaration.initializer);
  expect(initializer).toBeTruthy();

  return { sourceFile, initializer: initializer as TypeScript.Expression };
}

function readCuratedCloudModelIds(): string[] {
  const { sourceFile, initializer } = readExportedConstInitializer(
    inferenceConfigPath,
    "CLOUD_MODEL_OPTIONS",
  );
  expect(ts.isArrayLiteralExpression(initializer)).toBe(true);

  return (initializer as TypeScript.ArrayLiteralExpression).elements.map((element) => {
    expect(ts.isObjectLiteralExpression(element)).toBe(true);
    const idProperty = (element as TypeScript.ObjectLiteralExpression).properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(sourceFile) === "id" &&
        ts.isStringLiteralLike(unwrapConstAssertion(property.initializer)),
    );
    expect(idProperty).toBeTruthy();
    const idInitializer = unwrapConstAssertion(
      (idProperty as TypeScript.PropertyAssignment).initializer,
    );
    return (idInitializer as TypeScript.StringLiteral).text;
  });
}

function readRemoteModelIds(providerKey: string): string[] {
  const { sourceFile, initializer } = readExportedConstInitializer(
    modelPromptsPath,
    "REMOTE_MODEL_OPTIONS",
  );
  expect(ts.isObjectLiteralExpression(initializer)).toBe(true);

  const providerProperty = (initializer as TypeScript.ObjectLiteralExpression).properties.find(
    (property) =>
      ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === providerKey,
  );
  expect(providerProperty).toBeTruthy();

  const providerInitializer = unwrapConstAssertion(
    (providerProperty as TypeScript.PropertyAssignment).initializer,
  );
  expect(ts.isArrayLiteralExpression(providerInitializer)).toBe(true);

  return (providerInitializer as TypeScript.ArrayLiteralExpression).elements.map((element) => {
    expect(ts.isStringLiteralLike(unwrapConstAssertion(element))).toBe(true);
    return (unwrapConstAssertion(element) as TypeScript.StringLiteral).text;
  });
}

/**
 * Reads curated onboarding model IDs from source config instead of duplicating them in docs tests.
 */
function readCuratedOnboardingModelIds(): string[] {
  return [
    ...readCuratedCloudModelIds(),
    ...readRemoteModelIds("openai"),
    ...readRemoteModelIds("anthropic"),
    ...readRemoteModelIds("gemini"),
  ];
}

describe("inference options model task-fit docs (#4755)", () => {
  it("keeps a per-model task-fit comparison table for curated onboarding models", () => {
    const markdown = fs.readFileSync(inferenceOptionsPath, "utf8");
    const start = markdown.indexOf("## Model Task-Fit Guide");
    const end = markdown.indexOf("## Choosing the Right Option for Nemotron", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = markdown.slice(start, end);

    expect(section).toContain(
      "| Model | Best-for task type | Relative latency | Tool-use quality | Context-window fit | Relative cost |",
    );
    expect(section).toContain("provider catalog remains authoritative");
    expect(section).not.toMatch(/\bTBD\b|\bTODO\b/i);
    expect(section).not.toContain("Very large context");

    const documentedModelIds = Array.from(
      section.matchAll(/^\| `([^`]+)` \|/gm),
      (match) => match[1],
    );
    expect(documentedModelIds).toEqual(readCuratedOnboardingModelIds());
  });

  it("keeps GLM 5.1 scoped to the independent Hermes Provider catalog", () => {
    const markdown = fs.readFileSync(inferenceOptionsPath, "utf8");
    const start = markdown.indexOf("## Provider Options");
    const end = markdown.indexOf("## Model Task-Fit Guide", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = markdown.slice(start, end);
    const lines = section.split("\n");
    const nvidiaRow = lines.find((line) => line.startsWith("| NVIDIA Endpoints |"));
    const hermesRow = lines.find((line) => line.startsWith("| Hermes Provider |"));

    expect(nvidiaRow).toBeDefined();
    expect(nvidiaRow).not.toMatch(/GLM-?5\.1|z-ai\/glm-5\.1/i);
    expect(hermesRow).toContain("`z-ai/glm-5.1`");
  });
});
