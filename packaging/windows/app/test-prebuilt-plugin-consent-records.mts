// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { prebuiltPluginRegistrationSource } from "./openclaw-app-resources.mts";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  assert(index >= 0 && process.argv[index + 1]);
  return path.resolve(process.argv[index + 1]);
};
const source = argument("--source-root");
const toolRoot = argument("--tool-root");
const require = createRequire(import.meta.url);
const compiler = require(path.join(toolRoot, "node_modules/esbuild")) as typeof import("esbuild");
assert.equal(compiler.version, "0.27.4");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "prebuilt-consent-records-"));
try {
  const plugin = path.join(root, "plugins/brave");
  fs.mkdirSync(path.join(plugin, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "@openclaw/brave-plugin",
      version: "2026.9.2",
      openclaw: { runtimeExtensions: ["./dist/index.js"] },
    }),
  );
  fs.writeFileSync(path.join(plugin, "dist/index.js"), "// Fixture; never executed.\n");
  const closure = path.join(root, "openclaw-resource-closure.json");
  fs.writeFileSync(closure, '{"fixtureArtifact":"first"}\n');
  const recordsModule = `
    export let records={};
    export function setRecords(value){records=value;}
    export async function r(){return records;}
    export function n(current,update){const {pluginId,...record}=update;return {...current,[pluginId]:record};}
    export async function s(value){records=value;}`;
  // The fixture replaces storage only. The generated registration logic and
  // artifact identity calculation are the same code compiled into the app.
  const built = await compiler.build({
    stdin: {
      contents:
        prebuiltPluginRegistrationSource(source) +
        '\nexport {records,setRecords} from "fixture-records";',
      loader: "js",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    banner: {
      js: `const __nemoAssetDir=${JSON.stringify(root)};function __nemoPrepareAssetRoot(){}`,
    },
    plugins: [
      {
        name: "owned-record-store",
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /fixture-records|installed-plugin-index-records-C06Xozeq|installed-plugin-index-record-reader-SXWwf_BU/,
            },
            () => ({ path: "records", namespace: "fixture" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: recordsModule,
            loader: "js",
          }));
        },
      },
    ],
  });
  const file = path.join(root, "registration.cjs");
  fs.writeFileSync(file, built.outputFiles[0].contents);
  const api = require(file) as {
    records: Record<string, Record<string, unknown>>;
    setRecords(records: Record<string, Record<string, unknown>>): void;
    registerPrebuiltPlugins(config: unknown): Promise<{ registered: string[] }>;
  };
  const config = { plugins: { entries: { brave: { enabled: true } } } };
  assert.deepEqual((await api.registerPrebuiltPlugins(config)).registered, ["brave"]);
  const first = { ...api.records.brave };
  assert.equal(first.source, "path");
  assert.match(String(first.integrity), /^sha256-[A-Za-z0-9+/]{43}=$/);
  const approved = {
    ...first,
    acceptedSurface: { contracts: ["webSearchProviders: brave"] },
    acceptedSurfaceHash: "owned-consent-hash",
    acceptedSurfaceIntegrity: first.integrity,
  };
  api.setRecords({ brave: approved });
  await api.registerPrebuiltPlugins(config);
  assert.deepEqual(api.records.brave, approved);
  for (const field of ["source", "sourcePath", "installPath", "version", "integrity"]) {
    api.setRecords({ brave: { ...approved, [field]: "changed" } });
    await api.registerPrebuiltPlugins(config);
    assert.deepEqual(api.records.brave, first, field + " must invalidate prior consent");
  }
  api.setRecords({ brave: approved });
  fs.writeFileSync(closure, '{"fixtureArtifact":"second"}\n');
  await api.registerPrebuiltPlugins(config);
  assert.notEqual(api.records.brave.integrity, first.integrity);
  assert.equal(api.records.brave.acceptedSurface, undefined);
  api.setRecords({ brave: approved });
  await api.registerPrebuiltPlugins({ plugins: { entries: { brave: { enabled: false } } } });
  assert.deepEqual(api.records.brave, approved);
  console.log(
    JSON.stringify({
      passed: true,
      sameArtifactConsentRetained: true,
      changedIdentityCases: 5,
      changedArtifactConsentCleared: true,
      disabledPluginUntouched: true,
    }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
