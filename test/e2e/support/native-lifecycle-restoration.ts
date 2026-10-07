// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import ts from "typescript";

export function restorationScript(sourceText: string): string {
  const source = ts.createSourceFile(
    "rebuild-openclaw.test.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const scripts: string[] = [];
  function visitScript(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "trustedSandboxShellScript" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      scripts.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visitScript);
  }
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "verifyRestoredState"
    ) {
      visitScript(node);
    } else {
      ts.forEachChild(node, visit);
    }
  }
  visit(source);
  if (scripts.length !== 1) throw new Error("Expected one OpenClaw restoration script");
  return scripts[0]!;
}
