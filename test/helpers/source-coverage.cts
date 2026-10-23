// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const path = require("node:path");
const { fileURLToPath } = require("node:url");

const OPTIONS_ENVImpl = "NEMOCLAW_SOURCE_COVERAGE_OPTIONS";
const COVERAGE_KEYImpl = "__nemoclawSourceCoverage__";
const STATE_KEY = Symbol.for("nemoclaw.source-coverage.state");

type BabelTypes = typeof import("@babel/types");
type CoverageOptions = {
  roots: string[];
  include?: string | string[];
  exclude?: string[];
  allowExternal?: boolean;
  changedFiles?: string[];
  ignoreClassMethods?: string[];
};
type FileCoverage = {
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
  statementMap: Record<string, unknown>;
  fnMap: Record<string, unknown>;
  branchMap: Record<string, unknown>;
};
type InstrumentedSource = { code: string; map?: unknown; coverage?: FileCoverage };
type CoverageState = {
  options: CoverageOptions;
  cache: Map<string, { source: string; result: InstrumentedSource }>;
  matcher: (filename: string, absolute: string) => boolean;
  isEnabled: () => boolean;
  instrument: typeof instrumentSourceForCoverageImpl;
  fingerprint?: string;
};
type CounterPath = {
  node: import("@babel/types").UpdateExpression;
  getFunctionParent(): unknown;
  replaceWith(node: import("@babel/types").Expression): void;
  skip(): void;
};
type ProgramPath = {
  node: import("@babel/types").Program;
  traverse(visitor: { UpdateExpression(counter: CounterPath): void }): void;
};
const coverageGlobal = globalThis as typeof globalThis & {
  [STATE_KEY]?: CoverageState;
  [COVERAGE_KEYImpl]?: Record<string, FileCoverage>;
};

// Node loads this collector as native CommonJS in strip-only mode. These
// declarations expose its typed API without emitting unsupported export syntax.
export declare const OPTIONS_ENV: typeof OPTIONS_ENVImpl;
export declare const COVERAGE_KEY: typeof COVERAGE_KEYImpl;
export declare const enableSourceCoverage: typeof enableSourceCoverageImpl;
export declare const disableSourceCoverage: typeof disableSourceCoverageImpl;
export declare const resetSourceCoverage: typeof resetSourceCoverageImpl;
export declare const instrumentSource: typeof instrumentSourceImpl;
export declare const shouldInstrumentSource: typeof shouldInstrumentSourceImpl;
export declare const instrumentSourceForCoverage: typeof instrumentSourceForCoverageImpl;
export declare const sourceCoverageCacheIdentity: typeof sourceCoverageCacheIdentityImpl;

function enableSourceCoverageImpl(options: CoverageOptions, isEnabled = () => true) {
  // Compile once before enabling the hook that examines every native import.
  const picomatch = require("picomatch");
  const include = picomatch(options.include ?? "**", { dot: true });
  const exclude = picomatch(options.exclude ?? [], { dot: true });
  const matcher = (relative: string, absolute: string) =>
    (include(relative) || include(absolute)) && !exclude(relative) && !exclude(absolute);
  coverageGlobal[STATE_KEY] = {
    options,
    cache: new Map(),
    matcher,
    isEnabled,
    instrument: instrumentSourceForCoverageImpl,
  };
}

function disableSourceCoverageImpl() {
  delete coverageGlobal[STATE_KEY];
}

function resetSourceCoverageImpl() {
  const serialized = process.env[OPTIONS_ENVImpl];
  if (!serialized) throw new Error("Source coverage options were not initialized");
  enableSourceCoverageImpl(JSON.parse(serialized));
  // Keep objects referenced by cached modules alive across non-isolated runs.
  for (const file of Object.values(coverageGlobal[COVERAGE_KEYImpl] ?? {})) {
    for (const metric of ["s", "f"] as const) {
      for (const key of Object.keys(file[metric])) file[metric][key] = 0;
    }
    for (const key of Object.keys(file.b)) file.b[key].fill(0);
  }
}

function canonicalFilename(id: string) {
  const filename = id.startsWith("file:") ? fileURLToPath(id) : id.split("?")[0];
  return path.resolve(filename).replaceAll("\\", "/");
}

function isIncluded(
  filename: string,
  options: CoverageOptions,
  matcher: (filename: string, absolute: string) => boolean,
) {
  if (filename.split("/").includes("node_modules")) return false;
  if (options.changedFiles && !options.changedFiles.includes(filename)) return false;
  return options.roots.some((root) => {
    const relative = path.relative(root, filename);
    const outside =
      path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
    if (outside && options.allowExternal === false) return false;
    return matcher(relative.replaceAll("\\", "/"), filename);
  });
}

function guardSerializedCounters(program: ProgramPath, types: BabelTypes) {
  const factory = program.node.body[0];
  if (factory?.loc || !types.isFunctionDeclaration(factory)) return;
  const name = factory.id!.name;
  if (!name.startsWith("cov_")) return;
  program.traverse({
    UpdateExpression(counter) {
      if (counter.node.loc || !counter.getFunctionParent()) return;
      let root: import("@babel/types").Node = counter.node.argument;
      while (types.isMemberExpression(root)) root = root.object;
      if (!types.isCallExpression(root) || !types.isIdentifier(root.callee, { name })) return;
      // A serialized function can run outside the instrumented module. Keep
      // its behavior while counting every execution in the collecting process.
      counter.replaceWith(
        types.logicalExpression(
          "&&",
          types.binaryExpression(
            "===",
            types.unaryExpression("typeof", types.identifier(name)),
            types.stringLiteral("function"),
          ),
          counter.node,
        ),
      );
      counter.skip();
    },
  });
}

function instrumentSourceImpl(
  source: string,
  filename: string,
  options: CoverageOptions,
): InstrumentedSource {
  const { transformSync }: typeof import("@babel/core") = require("@babel/core");
  // The published 1.x declarations describe Babel 6 string paths; the locked
  // 6.x implementation uses Babel 7 NodePaths and accepts an AST.
  const {
    programVisitor,
    readInitialCoverage,
  }: {
    programVisitor(
      types: BabelTypes,
      filename: string,
      options: {
        coverageVariable: string;
        coverageGlobalScope: string;
        coverageGlobalScopeFunc: boolean;
        ignoreClassMethods?: string[];
      },
    ): {
      enter(path: ProgramPath): void;
      exit(path: ProgramPath): { fileCoverage: FileCoverage } | undefined;
    };
    readInitialCoverage(ast: import("@babel/types").File): { coverageData: FileCoverage } | null;
  } = require("istanbul-lib-instrument");
  let coverage: FileCoverage | undefined;
  const result = transformSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    ast: true,
    sourceMaps: true,
    compact: false,
    comments: true,
    parserOpts: {
      sourceType: "module",
      plugins: [
        "typescript",
        ...(filename.endsWith("x") ? ["jsx" as const] : []),
        ["importAttributes", { deprecatedAssertSyntax: true }],
      ],
    },
    plugins: [
      ({ types }: { types: BabelTypes }) => {
        const visitor = programVisitor(types, filename, {
          coverageVariable: COVERAGE_KEYImpl,
          coverageGlobalScope: "globalThis",
          coverageGlobalScopeFunc: false,
          ignoreClassMethods: options.ignoreClassMethods,
        });
        return {
          visitor: {
            Program: {
              enter: visitor.enter,
              exit(program: ProgramPath) {
                coverage = visitor.exit(program)?.fileCoverage;
                if (coverage) guardSerializedCounters(program, types);
              },
            },
          },
        };
      },
    ],
  });
  if (!result?.ast || typeof result.code !== "string") {
    throw new Error(`Source coverage transform produced no code or AST: ${filename}`);
  }
  if (!coverage) return { code: source, coverage: readInitialCoverage(result.ast)?.coverageData };
  return { code: result.code, map: result.map, coverage };
}

function shouldInstrumentSourceImpl(id: string) {
  const state = coverageGlobal[STATE_KEY];
  return Boolean(
    state &&
    state.isEnabled() &&
    /\.[cm]?[jt]sx?(?:\?|$)/.test(id) &&
    isIncluded(canonicalFilename(id), state.options, state.matcher),
  );
}

function instrumentSourceForCoverageImpl(source: string, id: string) {
  if (!shouldInstrumentSourceImpl(id)) return undefined;
  const state = coverageGlobal[STATE_KEY]!;
  const filename = canonicalFilename(id);
  const cached = state.cache.get(filename);
  if (cached?.source === source) return cached.result;
  const result = instrumentSourceImpl(source, filename, state.options);
  state.cache.set(filename, { source, result });
  return result;
}

function sourceCoverageCacheIdentityImpl(id: string) {
  if (!shouldInstrumentSourceImpl(id)) return "";
  const state = coverageGlobal[STATE_KEY]!;
  if (!state.fingerprint) {
    const fs = require("node:fs");
    const lockfile = path.resolve(__dirname, "../../package-lock.json");
    const dependencies = fs.existsSync(lockfile)
      ? fs.readFileSync(lockfile)
      : JSON.stringify([
          require("@babel/core/package.json"),
          require("istanbul-lib-instrument/package.json"),
        ]);
    state.fingerprint = require("node:crypto")
      .createHash("sha256")
      .update(fs.readFileSync(__filename))
      .update(dependencies)
      .update(JSON.stringify(state.options.ignoreClassMethods ?? []))
      .digest("hex");
  }
  return state.fingerprint!;
}

module.exports = {
  OPTIONS_ENV: OPTIONS_ENVImpl,
  COVERAGE_KEY: COVERAGE_KEYImpl,
  enableSourceCoverage: enableSourceCoverageImpl,
  disableSourceCoverage: disableSourceCoverageImpl,
  resetSourceCoverage: resetSourceCoverageImpl,
  instrumentSource: instrumentSourceImpl,
  shouldInstrumentSource: shouldInstrumentSourceImpl,
  instrumentSourceForCoverage: instrumentSourceForCoverageImpl,
  sourceCoverageCacheIdentity: sourceCoverageCacheIdentityImpl,
};
