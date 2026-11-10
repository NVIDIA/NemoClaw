// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { PluginBuild } from "esbuild";

const sources: Record<string, { hash: string; calls: number; workspace?: boolean }> = {
  "dist/builtin-openclaw-B_H1oNzF.js": {
    hash: "18772e63fa42f6e774b692fee3e2ceb394870c03b9caaec02b155728bb75de77",
    calls: 0,
    workspace: true,
  },
  "dist/openclaw-agent-db-maintenance-wTIy-jt-.js": {
    hash: "cb74fbb66177d98bfd2ad3a01362a0973db5d77af440875ac402bd2cafdc4521",
    calls: 2,
  },
  "dist/sqlite-readonly-location-BC9PgENz.js": {
    hash: "51b2e9d5e354d2f61546c87d90ae719f1d794545e06a5d9b944c03306a84808c",
    calls: 3,
  },
  "dist/openclaw-database-preflight-DmhpNBQv.js": {
    hash: "7472b7e3f7db87580267e1b022936251942b9f44ff7eb2fd3b860f7da6046bab",
    calls: 3,
  },
};

export function compileSqliteCanonicalRuntime(relative: string, text: string, original = text) {
  const expected = sources[relative];
  if (!expected) return text;
  if (createHash("sha256").update(original).digest("hex") !== expected.hash)
    throw new Error("The reviewed SQLite canonical-path source changed.");
  const expression = /\b(?:fs\.)?realpathSync\.native\(/gu;
  if ([...text.matchAll(expression)].length !== expected.calls)
    throw new Error("The SQLite canonical-path call boundary changed.");
  let result = text.replace(expression, "__nemoSqliteCanonicalPath(");
  if (expected.workspace) {
    const workspaceLookup = "await fs$1.realpath(resolvedWorkspace)";
    if (result.split(workspaceLookup).length !== 2)
      throw new Error("The workspace canonical-path call boundary changed.");
    // File-tool guards require the handle-resolved root in the drive-letter namespace.
    result = result.replace(
      workspaceLookup,
      '(process.platform === "win32" ? __nemoWorkspaceCanonicalPath(resolvedWorkspace) : await fs$1.realpath(resolvedWorkspace))',
    );
  }
  const marker = "function resolveDanglingSymlinkTargetPath(lexicalPath) {";
  if (relative === "dist/openclaw-agent-db-maintenance-wTIy-jt-.js") {
    if (result.split(marker).length !== 2)
      throw new Error("The SQLite missing-path boundary changed.");
    result = result.replace(
      marker,
      marker +
        '\n\tif (process.platform === "win32") return __nemoResolveMissingSqlitePath(lexicalPath);',
    );
  }
  return (
    `import { createRequire as __nemoSqliteRequire } from "node:module";
import { createSqliteCanonicalPath, createWorkspaceCanonicalPath, resolveMissingSqlitePath as __nemoResolveMissingSqlitePath } from "nemoclaw:sqlite-canonical-path";
const __nemoSqliteCanonicalPath = createSqliteCanonicalPath(() => __nemoSqliteRequire(import.meta.url)("koffi"));
const __nemoWorkspaceCanonicalPath = createWorkspaceCanonicalPath(() => __nemoSqliteRequire(import.meta.url)("koffi"));
` + result
  );
}

export function registerSqliteCanonicalModule(build: PluginBuild, source: string) {
  build.onResolve({ filter: /^nemoclaw:sqlite-canonical-path$/ }, () => ({
    path: "sqlite-canonical-path.mts",
    namespace: "nemoclaw-sqlite",
  }));
  build.onLoad({ filter: /.*/, namespace: "nemoclaw-sqlite" }, () => ({
    contents: fs.readFileSync(new URL("./sqlite-canonical-path.mts", import.meta.url), "utf8"),
    loader: "ts",
    resolveDir: source,
  }));
}
