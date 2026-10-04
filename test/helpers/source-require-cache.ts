// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import path from "node:path";
import ts from "typescript";

export function loadSourceRequireCompilerOptions(repoRoot: string): ts.CompilerOptions {
  const configPath = path.join(repoRoot, "tsconfig.src.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    repoRoot,
    {},
    configPath,
  );
  if (parsedConfig.errors.length > 0) {
    throw new Error(
      parsedConfig.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n"),
    );
  }

  return {
    ...parsedConfig.options,
    declaration: false,
    declarationMap: false,
    inlineSourceMap: true,
    inlineSources: true,
    noEmit: false,
    outDir: undefined,
    rootDir: undefined,
    sourceMap: false,
  };
}

export function sourceRequireCacheDir(repoRoot: string): string {
  return path.join(repoRoot, "node_modules", ".cache", "nemoclaw-source-require");
}

export function sourceRequireCompilerFingerprint(compilerOptions: ts.CompilerOptions): string {
  return JSON.stringify({ compilerOptions, typescript: ts.version });
}

export function sourceRequireCachePath(options: {
  compilerOptions: ts.CompilerOptions;
  filename: string;
  repoRoot: string;
  source: string;
}): string {
  const cacheKey = crypto
    .createHash("sha256")
    .update(options.filename)
    .update("\0")
    .update(options.source)
    .update("\0")
    .update(sourceRequireCompilerFingerprint(options.compilerOptions))
    .digest("hex");
  return path.join(sourceRequireCacheDir(options.repoRoot), `${cacheKey}.cjs`);
}
