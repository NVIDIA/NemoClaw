// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
const {
  instrumentSourceForCoverage,
  shouldInstrumentSource,
}: typeof import("./source-coverage.cts") = require("./source-coverage.cts");
import { compileSourceRequire } from "./source-require-compiler";

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

const resolveFilename = moduleRuntime._resolveFilename;
moduleRuntime._resolveFilename = function resolveSourceFilename(request, parent, isMain, options) {
  try {
    return resolveFilename.call(this, request, parent, isMain, options);
  } catch (error) {
    const parentFilename = parent?.filename ? path.resolve(parent.filename) : "";
    const sourceRoot = path.join(repoRoot, "src") + path.sep;
    const sharedSourceRoot = path.join(repoRoot, "nemoclaw/src/shared");
    const requestedPath = path.resolve(path.dirname(parentFilename), request);
    // Runtime require calls bypass Vitest aliases. Resolve unbuilt shared
    // modules only for typed source callers; packaged callers must use dist.
    if (
      /\.c?ts$/.test(parentFilename) &&
      request.startsWith(".") &&
      request.endsWith(".cjs") &&
      [path.join(repoRoot, "nemoclaw/dist/shared"), sharedSourceRoot].includes(
        path.dirname(requestedPath),
      )
    ) {
      const sourceCandidate = path.join(sharedSourceRoot, `${path.basename(request, ".cjs")}.cts`);
      if (fs.existsSync(sourceCandidate)) {
        return resolveFilename.call(this, sourceCandidate, parent, isMain, options);
      }
    }
    if (request.startsWith(".") && request.endsWith(".js") && parentFilename) {
      const sourceRequest = `${request.slice(0, -3)}.ts`;
      const sourceCandidate = path.resolve(path.dirname(parentFilename), sourceRequest);
      if (sourceCandidate.startsWith(sourceRoot) && fs.existsSync(sourceCandidate)) {
        return resolveFilename.call(this, sourceRequest, parent, isMain, options);
      }
    }
    if (request.startsWith(".") && request.endsWith(".mjs") && parentFilename) {
      const sourceRequest = `${request.slice(0, -4)}.mts`;
      const sourceCandidate = path.resolve(path.dirname(parentFilename), sourceRequest);
      if (sourceCandidate.startsWith(sourceRoot) && fs.existsSync(sourceCandidate)) {
        return resolveFilename.call(this, sourceRequest, parent, isMain, options);
      }
    }
    throw error;
  }
};

moduleRuntime._extensions[".ts"] = (module, filename) => {
  module._compile(compileSourceRequire(filename), filename);
};

moduleRuntime._extensions[".cts"] = moduleRuntime._extensions[".ts"];
moduleRuntime._extensions[".mts"] = moduleRuntime._extensions[".ts"];

const loadJavaScript = moduleRuntime._extensions[".js"];
moduleRuntime._extensions[".js"] = (module, filename) => {
  if (!shouldInstrumentSource(filename)) return loadJavaScript(module, filename);
  const source = fs.readFileSync(filename, "utf8");
  const instrumented = instrumentSourceForCoverage(source, filename);
  if (instrumented) module._compile(instrumented.code, filename);
  else loadJavaScript(module, filename);
};
