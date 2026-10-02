// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { expect } from "vitest";
import { buildHermesManagedPolicy } from "../../../agents/hermes/config/managed-policy.ts";
import type { HermesBuildSettings } from "../../../agents/hermes/config/build-env.ts";

export const settings: HermesBuildSettings = {
  model: "fixture-model",
  baseUrl: "https://inference.local/v1",
  providerKey: "custom",
  upstreamProvider: "custom",
  inferenceApi: "openai-completions",
  contextWindow: null,
  toolDisclosure: "progressive",
  webSearchProvider: null,
  messagingCredentialPlaceholders: [],
  managedToolGateways: { brokerEnabled: false, presets: [] },
  managedImageCapabilityUnion: true,
};

// Compile only a temporary copy of the real generator. This measures the
// generated configuration delta, not the behavior of a running native agent.
export function candidatePolicy(omit: string[], omitNeutralPlatforms = false) {
  const owner = path.resolve(
    import.meta.dirname,
    "../../../agents/hermes/config/managed-policy.ts",
  );
  const source = fs.readFileSync(owner, "utf8");
  const transform: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit: ts.Visitor = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "config" &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const properties = node.initializer.properties.filter(
          (property) =>
            !property.name || !ts.isIdentifier(property.name) || !omit.includes(property.name.text),
        );
        return context.factory.updateVariableDeclaration(
          node,
          node.name,
          node.exclamationToken,
          node.type,
          context.factory.updateObjectLiteralExpression(node.initializer, properties),
        );
      }
      if (
        omitNeutralPlatforms &&
        ts.isIfStatement(node) &&
        node.expression.getText() === "settings.managedImageCapabilityUnion"
      ) {
        return context.factory.createNotEmittedStatement(node);
      }
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".")
      ) {
        return context.factory.updateImportDeclaration(
          node,
          node.modifiers,
          node.importClause,
          context.factory.createStringLiteral(
            pathToFileURL(path.resolve(path.dirname(owner), node.moduleSpecifier.text)).href,
          ),
          node.attributes,
        );
      }
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".")
      ) {
        return context.factory.updateExportDeclaration(
          node,
          node.modifiers,
          node.isTypeOnly,
          node.exportClause,
          context.factory.createStringLiteral(
            pathToFileURL(path.resolve(path.dirname(owner), node.moduleSpecifier.text)).href,
          ),
          node.attributes,
        );
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (node) => ts.visitNode(node, visit) as ts.SourceFile;
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [transform] },
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-removal-config-"));
  try {
    const modulePath = path.join(directory, "candidate.mjs");
    fs.writeFileSync(modulePath, compiled.outputText);
    const program = `import { buildHermesManagedPolicy } from ${JSON.stringify(pathToFileURL(modulePath).href)}; console.log(JSON.stringify(buildHermesManagedPolicy(${JSON.stringify(settings)}, {})));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      encoding: "utf8",
      timeout: 10000,
      env: { PATH: process.env.PATH },
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as ReturnType<typeof buildHermesManagedPolicy>;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
