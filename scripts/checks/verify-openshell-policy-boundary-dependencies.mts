// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ALLOWED_POLICY_BOUNDARY_MODULES = new Set(["yaml"]);
const STATIC_REQUIRE = /\brequire\s*\(\s*(["'])([^"'\\\r\n]+)\1\s*\)/g;
const STATIC_IMPORT = /\bimport\s*\(\s*(["'])([^"'\\\r\n]+)\1\s*\)/g;
const ANY_UNCLASSIFIED_REQUIRE = /\brequire\b/;
const ANY_DYNAMIC_IMPORT = /\bimport\s*\(/;

function collectStaticModules(source: string, pattern: RegExp, modules: string[]): string {
  return source.replace(pattern, (_call: string, _quote: string, specifier: string): string => {
    modules.push(specifier);
    return "/* audited module load */";
  });
}

// invalidState: the generated sandbox boundary gains an undeclared or dynamic
// module load that silently expands the trusted runtime dependency surface.
// sourceBoundary: this audit admits only the reviewed direct module set before
// Docker copies the compiled boundary into the runtime image.
// whyNotSourceFix: TypeScript and npm resolve imports independently; neither
// constrains future edits to the security boundary's least-dependency contract.
// regressionTest: test/package-contract/openshell-policy-boundary.test.ts.
// removalCondition: remove only when the build system enforces an equivalent
// per-module dependency allowlist before constructing the sandbox image.
export function auditOpenShellPolicyBoundaryDependencies(source: string): string[] {
  const modules: string[] = [];
  let unclassifiedSource = collectStaticModules(source, STATIC_REQUIRE, modules);
  unclassifiedSource = collectStaticModules(unclassifiedSource, STATIC_IMPORT, modules);

  if (
    ANY_UNCLASSIFIED_REQUIRE.test(unclassifiedSource) ||
    ANY_DYNAMIC_IMPORT.test(unclassifiedSource)
  ) {
    throw new Error(
      "OpenShell policy boundary contains a non-literal module load; only audited literal imports are allowed",
    );
  }

  const disallowed = [...new Set(modules)]
    .filter((specifier) => !ALLOWED_POLICY_BOUNDARY_MODULES.has(specifier))
    .sort();
  if (disallowed.length > 0) {
    throw new Error(
      `OpenShell policy boundary imports non-whitelisted modules: ${disallowed.join(", ")}; allowed: ${[
        ...ALLOWED_POLICY_BOUNDARY_MODULES,
      ].join(", ")}`,
    );
  }

  return [...new Set(modules)].sort();
}

export function auditOpenShellPolicyBoundaryFile(filePath: string): string[] {
  return auditOpenShellPolicyBoundaryDependencies(fs.readFileSync(filePath, "utf8"));
}

function runCli(): void {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error(
      "Usage: verify-openshell-policy-boundary-dependencies.mts <compiled-boundary.cjs>",
    );
  }
  const modules = auditOpenShellPolicyBoundaryFile(filePath);
  process.stdout.write(
    `Verified OpenShell policy boundary dependencies: ${modules.join(", ") || "none"}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
