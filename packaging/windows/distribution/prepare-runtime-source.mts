// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// CI-only source adaptation preserves the published diagnostic entry files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { verifyNativeEndpointPolicy } from "./native-endpoint-policy.mts";

const DIAGNOSTIC_ENTRIES = [
  "native-inference-cli.mts",
  "run-installed-native-console-agent.mts",
  "run-installed-native-hermes-turn.mts",
  "run-installed-native-hermes-ui.mts",
  "run-installed-native-turn.mts",
  "run-installed-native-web-ui.mts",
];

export function prepareRuntimeSource(source: string) {
  if (arguments.length !== 1)
    throw new Error("Historical static-runtime patches are no longer accepted.");
  const changes = fs.readdirSync(source).filter((file) => file.endsWith(".mts"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "native-runtime-build-"));
  const runtime = path.join(work, "packaging", "windows", "runtime");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const inputs: { file: string; sha256: string }[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("The runtime source contains a redirected build input.");
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile())
        inputs.push({ file: path.relative(source, file), sha256: hash(fs.readFileSync(file)) });
      else throw new Error("The runtime source contains a non-file input.");
    }
  };
  try {
    visit(source);
    fs.cpSync(source, runtime, { recursive: true });
    const removedDiagnosticGuards: string[] = [];
    for (const file of changes) {
      const target = path.join(runtime, file);
      let text = fs.readFileSync(target, "utf8");
      const syntax = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const guards = syntax.statements
        .filter(ts.isIfStatement)
        .filter((statement) =>
          statement.expression.getText(syntax).startsWith("typeof NEMOCLAW_BUNDLED_RUNTIME"),
        );
      for (const statement of guards.reverse())
        text = text.slice(0, statement.getStart(syntax)) + text.slice(statement.end);
      if (guards.length) {
        fs.writeFileSync(target, text);
        removedDiagnosticGuards.push("packaging/windows/runtime/" + file);
      }
    }
    if (
      JSON.stringify(removedDiagnosticGuards.slice().sort()) !==
      JSON.stringify(DIAGNOSTIC_ENTRIES.map((file) => "packaging/windows/runtime/" + file))
    )
      throw new Error("The explicit diagnostic entry inventory changed.");
    verifyNativeEndpointPolicy(runtime, source);
    return {
      runtime,
      receipt: {
        schemaVersion: 1,
        classification: "ci-only-static-runtime-adaptation",
        adapterSha256: null,
        patchContextLines: 0,
        preimagesVerified: 0,
        inputs,
        removedDiagnosticGuards,
      },
      close: () => fs.rmSync(work, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    throw error;
  }
}
