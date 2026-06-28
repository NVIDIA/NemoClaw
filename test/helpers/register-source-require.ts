// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import ts from "typescript";

type CommonJsModule = NodeModule & {
  _compile(source: string, filename: string): void;
};

type ResolveFilename = (
  request: string,
  parent?: CommonJsModule | null,
  isMain?: boolean,
  options?: unknown,
) => string;

const moduleRuntime = Module as unknown as {
  _extensions: Record<string, (module: CommonJsModule, filename: string) => void>;
  _resolveFilename: ResolveFilename;
};
const repoRoot = path.resolve(__dirname, "../..");
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

const compilerOptions: ts.CompilerOptions = {
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
// Keep the cross-process transpilation cache in this checkout's dependency
// tree. A shared, predictable directory under the OS temp root could be
// replaced by another local user before a test process reads from it.
const cacheDir = path.join(repoRoot, "node_modules", ".cache", "nemoclaw-source-require");
const compilerFingerprint = JSON.stringify({ compilerOptions, typescript: ts.version });
fs.mkdirSync(cacheDir, { recursive: true });

const resolveFilename = moduleRuntime._resolveFilename;
moduleRuntime._resolveFilename = function resolveSourceFilename(request, parent, isMain, options) {
  try {
    return resolveFilename.call(this, request, parent, isMain, options);
  } catch (error) {
    const parentFilename = parent?.filename ? path.resolve(parent.filename) : "";
    const sourceRoot = path.join(repoRoot, "src") + path.sep;
    if (request.startsWith(".") && request.endsWith(".js") && parentFilename) {
      const sourceRequest = `${request.slice(0, -3)}.ts`;
      const sourceCandidate = path.resolve(path.dirname(parentFilename), sourceRequest);
      if (sourceCandidate.startsWith(sourceRoot) && fs.existsSync(sourceCandidate)) {
        return resolveFilename.call(this, sourceRequest, parent, isMain, options);
      }
    }
    throw error;
  }
};

moduleRuntime._extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const cacheKey = crypto
    .createHash("sha256")
    .update(filename)
    .update("\0")
    .update(source)
    .update("\0")
    .update(compilerFingerprint)
    .digest("hex");
  const cachePath = path.join(cacheDir, `${cacheKey}.cjs`);
  let outputText: string;

  try {
    outputText = fs.readFileSync(cachePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const result = ts.transpileModule(source, {
      compilerOptions,
      fileName: filename,
      reportDiagnostics: true,
    });
    const errors = result.diagnostics?.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (errors && errors.length > 0) {
      throw new Error(
        errors
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
          .join("\n"),
      );
    }
    outputText = result.outputText;
    const temporaryPath = `${cachePath}.${process.pid}.${crypto.randomUUID()}`;
    fs.writeFileSync(temporaryPath, outputText, { flag: "wx", mode: 0o600 });
    try {
      fs.renameSync(temporaryPath, cachePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  module._compile(outputText, filename);
};
