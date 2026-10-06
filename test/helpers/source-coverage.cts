// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const path = require("node:path");
const { fileURLToPath } = require("node:url");

const OPTIONS_ENV = "NEMOCLAW_SOURCE_COVERAGE_OPTIONS";
const COVERAGE_KEY = "__nemoclawSourceCoverage__";
const STATE_KEY = Symbol.for("nemoclaw.source-coverage.state");

function enableSourceCoverage(options, isEnabled = () => true) {
  // Compile once before enabling the hook that examines every native import.
  const picomatch = require("picomatch");
  const matcher = picomatch(options.include ?? "**", {
    contains: true,
    dot: true,
    ignore: options.exclude,
  });
  globalThis[STATE_KEY] = {
    options,
    cache: new Map(),
    matcher,
    isEnabled,
    instrument: instrumentSourceForCoverage,
  };
}

function disableSourceCoverage() {
  delete globalThis[STATE_KEY];
}

function resetSourceCoverage() {
  const serialized = process.env[OPTIONS_ENV];
  if (!serialized) throw new Error("Source coverage options were not initialized");
  enableSourceCoverage(JSON.parse(serialized));
  // Keep objects referenced by cached modules alive across non-isolated runs.
  for (const file of Object.values(globalThis[COVERAGE_KEY] ?? {})) {
    for (const metric of ["s", "f"]) {
      for (const key of Object.keys(file[metric])) file[metric][key] = 0;
    }
    for (const key of Object.keys(file.b)) file.b[key].fill(0);
  }
}

function canonicalFilename(id) {
  const filename = id.startsWith("file:") ? fileURLToPath(id) : id.split("?")[0];
  return path.resolve(filename).replaceAll("\\", "/");
}

function isIncluded(filename, options, matcher) {
  if (
    options.allowExternal === false &&
    !options.roots.some((root) => {
      const relative = path.relative(root, filename);
      return (
        !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
      );
    })
  )
    return false;
  return matcher(filename) && (!options.changedFiles || options.changedFiles.includes(filename));
}

function guardSerializedCounters(program, types) {
  const factory = program.node.body[0];
  if (factory?.loc || !types.isFunctionDeclaration(factory)) return;
  const name = factory.id.name;
  if (!name.startsWith("cov_")) return;
  program.traverse({
    UpdateExpression(counter) {
      if (counter.node.loc || !counter.getFunctionParent()) return;
      let root = counter.node.argument;
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

function instrumentSource(source, filename, options) {
  const { transformSync } = require("@babel/core");
  const { programVisitor, readInitialCoverage } = require("istanbul-lib-instrument");
  let coverage;
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
        ...(filename.endsWith("x") ? ["jsx"] : []),
        ["importAttributes", { deprecatedAssertSyntax: true }],
      ],
    },
    plugins: [
      ({ types }) => {
        const visitor = programVisitor(types, filename, {
          coverageVariable: COVERAGE_KEY,
          coverageGlobalScope: "globalThis",
          coverageGlobalScopeFunc: false,
          ignoreClassMethods: options.ignoreClassMethods,
        });
        return {
          visitor: {
            Program: {
              enter: visitor.enter,
              exit(program) {
                coverage = visitor.exit(program)?.fileCoverage;
                if (coverage) guardSerializedCounters(program, types);
              },
            },
          },
        };
      },
    ],
  });
  if (!coverage) return { code: source, coverage: readInitialCoverage(result.ast)?.coverageData };
  return { code: result.code, map: result.map, coverage };
}

function shouldInstrumentSource(id) {
  const state = globalThis[STATE_KEY];
  return Boolean(
    state &&
    state.isEnabled() &&
    /\.[cm]?[jt]sx?(?:\?|$)/.test(id) &&
    isIncluded(canonicalFilename(id), state.options, state.matcher),
  );
}

function instrumentSourceForCoverage(source, id) {
  if (!shouldInstrumentSource(id)) return undefined;
  const state = globalThis[STATE_KEY];
  const filename = canonicalFilename(id);
  const cached = state.cache.get(filename);
  if (cached?.source === source) return cached.result;
  const result = instrumentSource(source, filename, state.options);
  state.cache.set(filename, { source, result });
  return result;
}

function sourceCoverageCacheIdentity(id) {
  if (!shouldInstrumentSource(id)) return "";
  const state = globalThis[STATE_KEY];
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
  return state.fingerprint;
}

module.exports = {
  OPTIONS_ENV,
  COVERAGE_KEY,
  enableSourceCoverage,
  disableSourceCoverage,
  resetSourceCoverage,
  instrumentSource,
  shouldInstrumentSource,
  instrumentSourceForCoverage,
  sourceCoverageCacheIdentity,
};
