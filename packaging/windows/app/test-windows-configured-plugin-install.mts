// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { guardWindowsConfiguredPluginInstall } from "./openclaw-app-resources.mts";

const source = path.resolve(process.argv[process.argv.indexOf("--source-root") + 1] ?? "");
const relative = "dist/missing-configured-plugin-install-jsvFew4a.js";
const original = fs.readFileSync(path.join(source, relative), "utf8");
const patched = guardWindowsConfiguredPluginInstall(relative, original);
const syntax = createRequire(import.meta.url)(
  path.join(source, "node_modules/typescript"),
) as typeof import("typescript");
function body(text: string) {
  const tree = syntax.createSourceFile(
    "repair.js",
    text,
    syntax.ScriptTarget.Latest,
    true,
    syntax.ScriptKind.JS,
  );
  const functions = tree.statements
    .filter(syntax.isFunctionDeclaration)
    .filter((node) => node.name?.text === "repairMissingPluginInstalls");
  assert.equal(functions.length, 1);
  return functions[0].getText(tree);
}
async function control(text: string, platform: string, mode: "new" | "recorded" | "healthy") {
  const calls: string[] = [];
  const records: Record<string, { source: string; healthy: boolean }> =
    mode === "new" ? {} : { discord: { source: "path", healthy: mode === "healthy" } };
  const bindings = {
    process: { platform, env: {} },
    VERSION: "2026.7.1",
    loadManifestMetadataSnapshot: () => ({
      plugins: mode === "healthy" ? [{ id: "discord", origin: "config" }] : [],
    }),
    loadInstalledPluginIndex: () => ({ plugins: [] }),
    collectEffectiveConfiguredChannelOwnerPluginIds: () => new Map(),
    collectConfiguredPluginIdsWithMissingChannelConfigDescriptors: () => new Set(),
    loadInstalledPluginIndexInstallRecords: async () => records,
    resolveRegistryUpdateChannel: () => "stable",
    normalizeUpdateChannel: () => undefined,
    collectInstalledPluginIdsWithRepairablePackageDiagnostics: () => new Set(),
    collectInstalledPluginIdsWithStaleVersionBoundRuntimePackages: () => new Set(),
    collectOfficialReplacementInstallCandidates: () => new Map(),
    isLegacyPackageUpdateDoctorPass: () => false,
    shouldDeferConfiguredPluginInstallRepair: () => false,
    isInstalledRecordMissingOnDisk: (record: { healthy?: boolean }) => !record.healthy,
    forceNpmInstallRecordRepair: (record: unknown) => record,
    resolveCompatibilityHostVersion: () => "2026.7.1",
    updateNpmInstalledPlugins: async () => {
      calls.push("package-manager-repair");
      return {
        config: { plugins: { installs: { discord: { source: "path", healthy: true } } } },
        outcomes: [],
      };
    },
    collectDownloadableInstallCandidates: () => [
      { pluginId: "discord", label: "Discord", npmSpec: "@openclaw/discord" },
    ],
    installCandidate: async () => {
      calls.push("package-manager-install");
      return {
        records: { discord: { source: "path", healthy: true } },
        changes: [],
        notices: [],
        warnings: [],
      };
    },
    writePersistedInstalledPluginIndexInstallRecords: async () => {
      calls.push("persist-records");
    },
  };
  const params = {
    cfg: { plugins: { entries: { discord: { enabled: true } } } },
    env: {},
    pluginIds: new Set(["discord"]),
    channelIds: new Set(["discord"]),
    blockedPluginIds: new Set(),
  };
  // Execute the actual source function with install APIs replaced by observation
  // boundaries. No package manager, filesystem writer or network client runs.
  const invoke = new Function(...Object.keys(bindings), `return (${body(text)});`)(
    ...Object.values(bindings),
  );
  try {
    return { calls, result: await invoke(params), error: null };
  } catch (error) {
    return { calls, result: null, error };
  }
}
let controls = 0;
for (const mode of ["new", "recorded"] as const) {
  const before = await control(original, "win32", mode);
  assert.equal(before.error, null);
  assert(before.calls.some((name) => name.startsWith("package-manager-")));
  const denied = await control(patched, "win32", mode);
  assert(denied.error instanceof Error);
  assert.match(
    denied.error.message,
    /Repair or update NemoClaw.*runtime plugin downloads are disabled/u,
  );
  assert.deepEqual(denied.calls, []);
  const portable = await control(patched, "linux", mode);
  assert.equal(portable.error, null);
  assert(portable.calls.some((name) => name.startsWith("package-manager-")));
  controls += 3;
}
const healthy = await control(patched, "win32", "healthy");
assert.equal(healthy.error, null);
assert.deepEqual(healthy.calls, []);
controls++;
assert.throws(
  () => guardWindowsConfiguredPluginInstall(relative, original + "\n"),
  /source changed/u,
);
controls++;
console.log(
  JSON.stringify({
    controls,
    actualSourceFunction: true,
    packageManagerExecuted: false,
    platformClaim: "controlled function branches; full Windows gateway checked separately",
  }),
);
