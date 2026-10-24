// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildRemediatedOpenClawPluginArchive,
  fatalOpenClawNpmRemediationDiagnostic,
  hashPackageTree,
  migrateDiscordZodDeclarations,
  migrateDiscordZodSource,
  patchCurrentOpenClawCorePackageGraph,
  patchLegacyOpenClawCorePackageGraph,
  patchOpenClawDiagnosticsOtelPackageGraph,
  patchOpenClawBundledZodPackageGraph,
  patchOpenClawDiscordPackageGraph,
  patchOpenClawPluginPackageGraph,
  patchOpenClawSlackProxyAddrPackageGraph,
  remediateInstalledOfficialOpenClawPlugin,
  OpenClawNpmRemediationCommandError,
  runOpenClawNpmRemediationCommand,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";

const temporaryDirectories: string[] = [];

describe("Discord SDK Zod 4 migration", () => {
  let directory: string;
  let zod: Record<string, unknown>;
  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-discord-zod4-"));
    const archive = path.resolve(import.meta.dirname, "../../fixtures/npm/zod-4.6.6/zod-4.6.6.tgz");
    expect(`sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`).toBe(
      "sha512-4UmzQUF5fxvfcYHlbjBmejU+w+hbDnWFx4aS8kBx7nPBHcO2SqPbpAG8snbdg+Xse4pRefR98hgjFgIMCI/UhA==",
    );
    const unpacked = spawnSync("tar", ["-xzf", archive, "-C", directory]);
    expect(unpacked.status, unpacked.stderr.toString()).toBe(0);
    mkdirSync(path.join(directory, "node_modules"));
    symlinkSync(path.join(directory, "package"), path.join(directory, "node_modules", "zod"));
    zod = await import(pathToFileURL(path.join(directory, "package", "index.js")).href);
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it.each([
    ["2026.9.2", "4.4.3"],
    ["2026.9.5", "4.5.4"],
  ])("replaces Google Chat %s bundled Zod with the verified patched tree", (version, original) => {
    const plugin = path.join(directory, `googlechat-${version}`);
    const target = path.join(plugin, "node_modules/zod");
    mkdirSync(target, { recursive: true });
    writeJson(path.join(plugin, "package.json"), {
      name: "@openclaw/googlechat",
      version,
      dependencies: { zod: original },
    });
    writeJson(path.join(target, "package.json"), { name: "zod", version: original });
    patchOpenClawBundledZodPackageGraph(
      plugin,
      path.join(directory, "package"),
      `@openclaw/googlechat@${version}`,
    );
    expect(hashPackageTree(target)).toBe(hashPackageTree(path.join(directory, "package")));
    expect(readJson(path.join(plugin, "package.json"))).toMatchObject({
      dependencies: { zod: "4.6.6" },
    });
  });

  it("preserves SDK defaults, unknown scopes and optional frame data with the patched runtime", () => {
    const source = [
      "const index = require('../lib/zod/lib/index.cjs');",
      "function fallbackToDefault(schema) {",
      "  const transform = index.custom().transform(data => {",
      "    const res = schema.safeParse(data);",
      "    if (res.success) return res.data;",
      "    return schema._def.defaultValue();",
      "  });",
      "  transform.overlayType = schema; return transform;",
      "}",
      'const scopes = index.array(fallbackToDefault(index.enum(["identify"]).or(index.literal(-1)).default(-1)));',
      "const values = { ...scopes.element.overlayType._def.innerType.options[0].Values, UNHANDLED: -1 };",
      "module.exports = {",
      "  fallback: fallbackToDefault(index.object({opened:index.boolean().or(index.null())}).default({opened:null})),",
      "  frame: index.object({cmd:index.string(), data: index.unknown(), evt:index.null(), nonce:index.string()}),",
      "  scopes: index.preprocess(arg => arg != null && !Object.values(values).includes(arg) ? -1 : arg, index.string().or(index.number())),",
      "  bounded(values) { let visited=0; const schema=index.array(index.string().superRefine(()=>{visited++})).max(1); return {success:schema.safeParse(values).success,visited}; }",
      "};",
    ].join("\n");
    const module = { exports: {} };
    runInNewContext(migrateDiscordZodSource("output/utils/zodUtils.cjs", source), {
      module,
      require: (specifier: string) => {
        expect(specifier).toBe("zod");
        return zod;
      },
    });
    const sdk = module.exports as {
      fallback: { parse: (input: unknown) => unknown };
      frame: { safeParse: (input: unknown) => { success: boolean } };
      scopes: { parse: (input: unknown) => unknown };
      bounded: (input: unknown) => { success: boolean; visited: number };
    };
    expect(sdk.fallback.parse({ opened: true })).toEqual({ opened: true });
    expect(sdk.fallback.parse("invalid")).toEqual({ opened: null });
    expect(sdk.scopes.parse("identify")).toBe("identify");
    expect(sdk.scopes.parse("new-client-scope")).toBe(-1);
    expect(sdk.frame.safeParse({ cmd: "x", evt: null, nonce: "n" }).success).toBe(true);
    expect(sdk.frame.safeParse({ cmd: 42, evt: null, nonce: "n" }).success).toBe(false);
    expect(sdk.bounded(["a", "b"])).toEqual({ success: false, visited: 0 });
  });

  it("keeps SDK declaration consumers valid against Zod 4 types", () => {
    const source = [
      'import * as z from "zod";',
      'declare const response: z.ZodObject<{name:z.ZodString;tags:z.ZodArray<z.ZodString,"many">},"strip",z.ZodTypeAny,{name:string;tags:string[]},{name:string;tags:string[]}>;',
      "declare const scope: z.ZodEffects<z.ZodType<string,z.ZodTypeDef,string>,string,unknown>;",
      "interface Event<T extends z.AnyZodObject = z.AnyZodObject> { payload:T }",
      'const value = response.parse({name:"n",tags:["t"]});',
      "const name:string=value.name; const tag:string=value.tags[0]!;",
      'const known:string=scope.parse("identify"); void [name,tag,known];',
    ].join("\n");
    const file = path.join(directory, "consumer.ts");
    writeFileSync(file, migrateDiscordZodDeclarations(source));
    const program = ts.createProgram([file], {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      esModuleInterop: true,
      ignoreDeprecations: "6.0",
      types: [],
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    ).toEqual([]);
    expect(() => migrateDiscordZodDeclarations("z.ZodObject<{name:z.ZodString}")).toThrow(
      "incomplete schema type",
    );
  });
});

function writeFixture(axiosVersion = "1.16.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-npm-remediation-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/slack",
        version: "2026.7.1",
        dependencies: { "@slack/bolt": "4.7.3" },
        bundledDependencies: ["@slack/bolt"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/slack",
        version: "2026.7.1",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "@openclaw/slack",
            version: "2026.7.1",
            dependencies: { "@slack/bolt": "4.7.3" },
          },
          "node_modules/axios": {
            version: axiosVersion,
            resolved: `https://registry.npmjs.org/axios/-/axios-${axiosVersion}.tgz`,
            integrity: "sha512-old",
            dependencies: {
              "follow-redirects": "^1.16.0",
              "form-data": "^4.0.5",
              "proxy-from-env": "^2.1.0",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeDiagnosticsFixture(jaegerVersion = "2.8.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-otel-remediation-"));
  temporaryDirectories.push(directory);
  const sdkDirectory = path.join(directory, "node_modules", "@opentelemetry", "sdk-node");
  mkdirSync(sdkDirectory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name: "@openclaw/diagnostics-otel", version: "2026.7.1" }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(sdkDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "@opentelemetry/sdk-node",
        version: "0.219.0",
        dependencies: { "@opentelemetry/propagator-jaeger": jaegerVersion },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/diagnostics-otel",
        version: "2026.7.1",
        lockfileVersion: 3,
        packages: {
          "": { name: "@openclaw/diagnostics-otel", version: "2026.7.1" },
          "node_modules/@opentelemetry/sdk-node": {
            version: "0.219.0",
            dependencies: { "@opentelemetry/propagator-jaeger": jaegerVersion },
          },
          "node_modules/@opentelemetry/propagator-jaeger": {
            version: jaegerVersion,
            dependencies: { "@opentelemetry/core": jaegerVersion },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeLegacyCoreFixture(tarVersion = "7.5.11"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-legacy-openclaw-core-remediation-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "openclaw",
        version: "2026.3.11",
        dependencies: {
          "@whiskeysockets/baileys": "7.0.0-rc.9",
          commander: "14.0.3",
          tar: tarVersion,
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeCurrentCoreFixture(
  braceExpansionVersion = "5.0.7",
  fastUriVersion = "3.1.2",
  undiciVersion = "8.5.0",
  ipAddressVersion = "10.2.0",
): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-current-openclaw-core-remediation-"));
  temporaryDirectories.push(directory);
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "openclaw",
        version: "2026.7.1",
        dependencies: {
          "@modelcontextprotocol/sdk": "1.29.0",
          "@openclaw/fs-safe": "0.4.1",
          minimatch: "10.2.5",
          tar: "7.5.19",
          undici: undiciVersion,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "openclaw",
        version: "2026.7.1",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "openclaw",
            version: "2026.7.1",
            dependencies: {
              "@modelcontextprotocol/sdk": "1.29.0",
              "@openclaw/fs-safe": "0.4.1",
              minimatch: "10.2.5",
              tar: "7.5.19",
              undici: undiciVersion,
            },
          },
          "node_modules/@openclaw/fs-safe": {
            version: "0.4.1",
            resolved: "https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.4.1.tgz",
            integrity:
              "sha512-hQi+BxO10KdRFlYUot1syC+hTaUnGeQNdqX5kwkKJig8CFq1tKsYJLPm+zkiiGsSKOprPAquQl/txejEhpKPgg==",
            license: "MIT",
            engines: { node: ">=22" },
            optionalDependencies: { jszip: "^3.10.1", tar: "7.5.19" },
          },
          "node_modules/ajv": {
            version: "8.20.0",
            dependencies: { "fast-uri": "^3.0.1" },
          },
          "node_modules/brace-expansion": {
            version: braceExpansionVersion,
            resolved: `https://registry.npmjs.org/brace-expansion/-/brace-expansion-${braceExpansionVersion}.tgz`,
            integrity:
              "sha512-7oFy703dxfY3/NLxC1fh2SUCQ0H9rmAY+5EpDVfXjUTTs+HEwR2nYaqLv+GWcTsumwxPfiz6CzCNkwXwBUwqCA==",
            dependencies: { "balanced-match": "^4.0.2" },
          },
          "node_modules/fast-uri": {
            version: fastUriVersion,
            resolved: `https://registry.npmjs.org/fast-uri/-/fast-uri-${fastUriVersion}.tgz`,
            integrity:
              "sha512-rVjf7ArG3LTk+FS6Yw81V1DLuZl1bRbNrev6Tmd/9RaroeeRRJhAt7jg/6YFxbvAQXUCavSoZhPPj6oOx+5KjQ==",
          },
          "node_modules/minimatch": {
            version: "10.2.5",
            dependencies: { "brace-expansion": "^5.0.5" },
          },
          "node_modules/tar": {
            version: "7.5.19",
            resolved: "https://registry.npmjs.org/tar/-/tar-7.5.19.tgz",
            integrity:
              "sha512-4LeEWl96twnS2Q7Bz4MGqgazLqO+hJN63GZxXoIqh1T3VweYD997gbU1ItNsQafqqXTXd5WFyFdReLtwvRBNiw==",
            license: "BlueOak-1.0.0",
            dependencies: {
              "@isaacs/fs-minipass": "^4.0.0",
              chownr: "^3.0.0",
              minipass: "^7.1.2",
              minizlib: "^3.1.0",
              yallist: "^5.0.0",
            },
            engines: { node: ">=18" },
          },
          "node_modules/express-rate-limit": {
            version: "8.5.2",
            dependencies: { "ip-address": "^10.2.0" },
          },
          "node_modules/ip-address": {
            version: ipAddressVersion,
            resolved: `https://registry.npmjs.org/ip-address/-/ip-address-${ipAddressVersion}.tgz`,
            integrity:
              "sha512-/+S6j4E9AHvW9SWMSEY9Xfy66O5PWvVEJ08O0y5JGyEKQpojb0K0GKpz/v5HJ/G0vi3D2sjGK78119oXZeE0qA==",
            engines: { node: ">= 12" },
          },
          "node_modules/undici": {
            version: undiciVersion,
            resolved: `https://registry.npmjs.org/undici/-/undici-${undiciVersion}.tgz`,
            integrity:
              "sha512-xamtWoB1EshgjpmlXd7GGm2VfdDtw1+rD8uhry8pSNW3If6S8E0m2T2+orSKeZXEn/aPJMviCpDBA65WJt8zhg==",
            engines: { node: ">=22.19.0" },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeDiscordFixture(undiciVersion = "8.5.0"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-discord-remediation-"));
  temporaryDirectories.push(directory);
  const dependencies = { undici: undiciVersion, ws: "8.21.0" };
  const bundledUndiciDirectory = path.join(directory, "node_modules", "undici");
  mkdirSync(bundledUndiciDirectory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/discord",
        version: "2026.7.1",
        dependencies,
        bundledDependencies: ["undici"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(bundledUndiciDirectory, "package.json"),
    `${JSON.stringify(
      { name: "undici", version: undiciVersion, engines: { node: ">=22.19.0" } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(directory, "npm-shrinkwrap.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/discord",
        version: "2026.7.1",
        lockfileVersion: 3,
        packages: {
          "": { name: "@openclaw/discord", version: "2026.7.1", dependencies },
          "node_modules/undici": {
            version: undiciVersion,
            resolved: `https://registry.npmjs.org/undici/-/undici-${undiciVersion}.tgz`,
            integrity:
              "sha512-xamtWoB1EshgjpmlXd7GGm2VfdDtw1+rD8uhry8pSNW3If6S8E0m2T2+orSKeZXEn/aPJMviCpDBA65WJt8zhg==",
            engines: { node: ">=22.19.0" },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

function writeSlackProxyAddrFixture(
  sourceVersion = "2.0.7",
  replacementVersion = "2.0.8",
): { packageDirectory: string; replacementDirectory: string } {
  const packageDirectory = mkdtempSync(
    path.join(tmpdir(), "nemoclaw-openclaw-slack-proxy-addr-remediation-"),
  );
  temporaryDirectories.push(packageDirectory);
  const boltDirectory = path.join(packageDirectory, "node_modules", "@slack", "bolt");
  const expressDirectory = path.join(boltDirectory, "node_modules", "express");
  const proxyAddrDirectory = path.join(boltDirectory, "node_modules", "proxy-addr");
  mkdirSync(expressDirectory, { recursive: true });
  mkdirSync(proxyAddrDirectory, { recursive: true });
  writeJson(path.join(packageDirectory, "package.json"), {
    name: "@openclaw/slack",
    version: "2026.9.2",
    dependencies: { "@slack/bolt": "5.0.0" },
    bundledDependencies: ["@slack/bolt"],
  });
  writeJson(path.join(boltDirectory, "package.json"), {
    name: "@slack/bolt",
    version: "5.0.0",
    dependencies: { express: "^5.0.0" },
    license: "MIT",
    engines: { node: ">=20" },
  });
  writeJson(path.join(expressDirectory, "package.json"), {
    name: "express",
    version: "5.2.1",
    dependencies: { "proxy-addr": "^2.0.7" },
    license: "MIT",
    engines: { node: ">= 18" },
  });
  writeJson(path.join(proxyAddrDirectory, "package.json"), {
    name: "proxy-addr",
    version: sourceVersion,
    dependencies: { forwarded: "0.2.0", "ipaddr.js": "1.9.1" },
    license: "MIT",
    engines: { node: ">= 0.10" },
  });
  writeFileSync(path.join(proxyAddrDirectory, "index.js"), "module.exports = 'vulnerable';\n");

  const replacementDirectory = mkdtempSync(path.join(tmpdir(), "nemoclaw-proxy-addr-replacement-"));
  temporaryDirectories.push(replacementDirectory);
  writeJson(path.join(replacementDirectory, "package.json"), {
    name: "proxy-addr",
    version: replacementVersion,
    dependencies: { forwarded: "0.2.0", "ipaddr.js": "1.9.1" },
    license: "MIT",
    engines: { node: ">= 0.10" },
  });
  writeFileSync(path.join(replacementDirectory, "index.js"), "module.exports = 'patched';\n");
  return { packageDirectory, replacementDirectory };
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function packFixture(packageDirectory: string, archivePath: string): void {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-archive-fixture-"));
  temporaryDirectories.push(root);
  cpSync(packageDirectory, path.join(root, "package"), { recursive: true });
  const result = spawnSync("tar", ["-czf", archivePath, "-C", root, "package"], {
    encoding: "utf-8",
  });
  expect(result.status, result.stderr || "failed to pack OpenClaw test archive").toBe(0);
}

function readPackageField<T>(directory: string, field: string): T {
  let value: unknown = readJson<Record<string, unknown>>(path.join(directory, "package.json"));
  for (const part of field.split(".")) {
    value = (value as Record<string, unknown>)[part];
  }
  return value as T;
}

function writeLegacyCoreArchiveFixtures(): {
  archivePath: string;
  npmExecutable: string;
  workingDirectory: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-legacy-openclaw-build-remediation-"));
  temporaryDirectories.push(root);
  const archivePath = path.join(root, "openclaw-2026.3.11.tgz");
  packFixture(writeLegacyCoreFixture(), archivePath);

  const tarDirectory = path.join(root, "tar-package");
  mkdirSync(tarDirectory, { recursive: true });
  writeFileSync(
    path.join(tarDirectory, "package.json"),
    `${JSON.stringify({ name: "tar", version: "7.5.21" }, null, 2)}\n`,
  );
  const tarArchive = path.join(root, "tar-7.5.21-source.tgz");
  packFixture(tarDirectory, tarArchive);

  const baileysDirectory = path.join(root, "baileys-package");
  mkdirSync(baileysDirectory, { recursive: true });
  writeFileSync(
    path.join(baileysDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "@whiskeysockets/baileys",
        version: "7.0.0-rc.9",
        license: "MIT",
        engines: { node: ">=20.0.0" },
        gitHead: "cb8b3717aaede47460ba700651ee936f268c0ce4",
        dependencies: {
          "@cacheable/node-cache": "^1.4.0",
          "@hapi/boom": "^9.1.3",
          "async-mutex": "^0.5.0",
          libsignal: "git+https://github.com/whiskeysockets/libsignal-node",
          "lru-cache": "^11.1.0",
          "music-metadata": "^11.7.0",
          "p-queue": "^9.0.0",
          pino: "^9.6",
          protobufjs: "^7.2.4",
          ws: "^8.13.0",
        },
        peerDependencies: {
          "audio-decode": "^2.1.3",
          jimp: "^1.6.0",
          "link-preview-js": "^3.0.0",
          sharp: "*",
        },
      },
      null,
      2,
    )}\n`,
  );
  const baileysArchive = path.join(root, "whiskeysockets-baileys-7.0.0-rc.9-source.tgz");
  packFixture(baileysDirectory, baileysArchive);

  const libsignalDirectory = path.join(root, "libsignal-package");
  mkdirSync(libsignalDirectory, { recursive: true });
  writeFileSync(
    path.join(libsignalDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "libsignal",
        version: "6.0.0",
        license: "GPL-3.0",
        gitHead: "bcea72df9ec34d9d9140ab30619cf479c7c144c7",
        dependencies: { "curve25519-js": "^0.0.4", protobufjs: "^7.5.5" },
      },
      null,
      2,
    )}\n`,
  );
  const libsignalArchive = path.join(root, "libsignal-6.0.0-source.tgz");
  packFixture(libsignalDirectory, libsignalArchive);

  const npmExecutable = path.join(root, "npm-fixture.sh");
  writeFileSync(
    npmExecutable,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `tar_archive=${JSON.stringify(tarArchive)}`,
      `baileys_archive=${JSON.stringify(baileysArchive)}`,
      `libsignal_archive=${JSON.stringify(libsignalArchive)}`,
      'case "$1:$2:${3:-}" in',
      '  "view:tar@7.5.21:dist.integrity") value="sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==" ;;',
      '  "view:tar@7.5.21:dist.tarball") value="https://registry.npmjs.org/tar/-/tar-7.5.21.tgz" ;;',
      '  "pack:tar@7.5.21:--pack-destination") ;;',
      '  "view:@whiskeysockets/baileys@7.0.0-rc.9:dist.integrity") value="sha512-YFm5gKXfDP9byCXCW3OPHKXLzrAKzolzgVUlRosHHgwbnf2YOO3XknkMm6J7+F0ns8OA0uuSBhgkRHTDtqkacw==" ;;',
      '  "view:@whiskeysockets/baileys@7.0.0-rc.9:dist.tarball") value="https://registry.npmjs.org/@whiskeysockets/baileys/-/baileys-7.0.0-rc.9.tgz" ;;',
      '  "pack:@whiskeysockets/baileys@7.0.0-rc.9:--pack-destination") ;;',
      '  "view:libsignal@6.0.0:dist.integrity") value="sha512-d/5V3YFtDljbFMufz4ncyUYGYhJl+vzAe+c2EFFBQ6bz1h8Q3IOMEGXYMzlibU60I+e8GagMMpji18iez3P1hA==" ;;',
      '  "view:libsignal@6.0.0:dist.tarball") value="https://registry.npmjs.org/libsignal/-/libsignal-6.0.0.tgz" ;;',
      '  "pack:libsignal@6.0.0:--pack-destination") ;;',
      '  *) echo "unexpected npm fixture invocation: $*" >&2; exit 1 ;;',
      "esac",
      'if [ "$1" = "view" ]; then printf "%s\\n" "$value"; exit 0; fi',
      'package_spec="$2"',
      'destination=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--pack-destination" ]; then destination="$2"; shift 2; continue; fi',
      "  shift",
      "done",
      'case "$package_spec" in',
      '  "tar@7.5.21") archive="$tar_archive"; filename="tar-7.5.21.tgz"; integrity="sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==" ;;',
      '  "@whiskeysockets/baileys@7.0.0-rc.9") archive="$baileys_archive"; filename="whiskeysockets-baileys-7.0.0-rc.9.tgz"; integrity="sha512-YFm5gKXfDP9byCXCW3OPHKXLzrAKzolzgVUlRosHHgwbnf2YOO3XknkMm6J7+F0ns8OA0uuSBhgkRHTDtqkacw==" ;;',
      '  "libsignal@6.0.0") archive="$libsignal_archive"; filename="libsignal-6.0.0.tgz"; integrity="sha512-d/5V3YFtDljbFMufz4ncyUYGYhJl+vzAe+c2EFFBQ6bz1h8Q3IOMEGXYMzlibU60I+e8GagMMpji18iez3P1hA==" ;;',
      "esac",
      'cp "$archive" "$destination/$filename"',
      'printf \'[{"filename":"%s","integrity":"%s"}]\\n\' "$filename" "$integrity"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(npmExecutable, 0o700);
  return { archivePath, npmExecutable, workingDirectory: path.join(root, "work") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw npm remediation", () => {
  it.each([
    ["package.json", "symlink", symlinkSync],
    ["package.json", "hardlink", linkSync],
    ["npm-shrinkwrap.json", "symlink", symlinkSync],
    ["npm-shrinkwrap.json", "hardlink", linkSync],
  ] as const)(
    "rejects linked %s metadata (%s) before Zod migration changes files",
    (name, _kind, link) => {
      const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-zod-metadata-link-"));
      temporaryDirectories.push(root);
      const plugin = path.join(root, "plugin");
      mkdirSync(plugin);
      const original = JSON.stringify({
        name: "@openclaw/slack",
        version: "2026.9.5",
        dependencies: { zod: "4.5.4" },
      });
      const external = path.join(root, "external.json");
      writeFileSync(external, original);
      writeFileSync(path.join(plugin, "package.json"), original);
      rmSync(path.join(plugin, name), { force: true });
      link(external, path.join(plugin, name));
      expect(() =>
        patchOpenClawBundledZodPackageGraph(
          plugin,
          path.join(root, "must-not-read"),
          "@openclaw/slack@2026.9.5",
        ),
      ).toThrow("single regular file");
      expect(readFileSync(external, "utf8")).toBe(original);
      expect(existsSync(path.join(plugin, "node_modules"))).toBe(false);
    },
  );

  it("bounds a non-returning remediation command and keeps its diagnostic generic", () => {
    const startedAt = Date.now();
    let failure: unknown;
    try {
      runOpenClawNpmRemediationCommand(
        process.execPath,
        ["-e", 'process.stdout.write("private command output"); setInterval(() => {}, 1000);'],
        undefined,
        process.env,
        "fetch replacement",
        64 * 1024 * 1024,
        750,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(OpenClawNpmRemediationCommandError);
    expect(failure).toMatchObject({
      couldNotStart: false,
      operation: "fetch replacement",
      timedOut: true,
      timeoutMs: 750,
      message: "Remediation command timed out after 750 ms.",
    });
    expect(fatalOpenClawNpmRemediationDiagnostic(failure)).toBe(
      "OpenClaw npm remediation operation 'fetch replacement' timed out after 750 ms.",
    );
    expect(String(failure)).not.toContain("private command output");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it.each([
    {
      failure: "malformed",
      prepare: (archivePath: string) => writeFileSync(archivePath, "not a tar archive"),
      env: {},
      message: "OpenClaw npm remediation operation 'list archive' failed.",
    },
    {
      failure: "missing",
      prepare: (_archivePath: string) => undefined,
      env: {},
      message: "OpenClaw npm remediation operation 'list archive' failed.",
    },
    {
      failure: "unavailable tar",
      prepare: (archivePath: string) => writeFileSync(archivePath, "not a tar archive"),
      env: { PATH: "" },
      message:
        "OpenClaw npm remediation operation 'list archive' could not start a required command.",
    },
  ])("withholds archive paths and child diagnostics when $failure", ({ prepare, env, message }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-private-archive-marker-"));
    temporaryDirectories.push(directory);
    const archivePath = path.join(directory, "private-archive-marker.tgz");
    prepare(archivePath);
    const request = {
      archivePath,
      packageSpec: "@openclaw/slack@2026.9.2",
      workingDirectory: path.join(directory, "work"),
      env,
    };

    let failure: unknown;
    try {
      buildRemediatedOpenClawPluginArchive(request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenClawNpmRemediationCommandError);
    expect(fatalOpenClawNpmRemediationDiagnostic(failure)).toBe(message);
    expect(String(failure)).not.toContain("private-archive-marker");
  });

  it("rejects unsafe archive members without echoing their names or archive path", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-private-archive-marker-"));
    temporaryDirectories.push(directory);
    const memberName = "private-member-marker";
    writeFileSync(path.join(directory, memberName), "untrusted member");
    const archivePath = path.join(directory, "private-archive-marker.tgz");
    const packed = spawnSync("tar", ["-czf", archivePath, "-C", directory, memberName], {
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const request = {
      archivePath,
      packageSpec: "@openclaw/slack@2026.9.2",
      workingDirectory: path.join(directory, "work"),
    };

    expect(() => buildRemediatedOpenClawPluginArchive(request)).toThrow(
      "npm archive has an unsafe member",
    );
    expect(() => buildRemediatedOpenClawPluginArchive(request)).not.toThrow(
      "private-member-marker",
    );
    expect(() => buildRemediatedOpenClawPluginArchive(request)).not.toThrow(
      "private-archive-marker",
    );
  });

  it.each(["@slack/bolt", "@slack/bolt/node_modules/express"])(
    "rejects changed Slack %s contracts before replacing proxy bytes",
    (dependency) => {
      const { packageDirectory, replacementDirectory } = writeSlackProxyAddrFixture();
      const metadataPath = path.join(packageDirectory, "node_modules", dependency, "package.json");
      const metadata = readJson<Record<string, unknown>>(metadataPath);
      writeJson(metadataPath, { ...metadata, license: "unexpected" });
      expect(() =>
        patchOpenClawSlackProxyAddrPackageGraph(packageDirectory, replacementDirectory),
      ).toThrow("contract changed after review");
      expect(
        readFileSync(
          path.join(packageDirectory, "node_modules/@slack/bolt/node_modules/proxy-addr/index.js"),
          "utf8",
        ),
      ).toContain("vulnerable");
    },
  );
  it("replaces bundled Slack proxy-addr bytes and rejects an unexpected source version", () => {
    const { packageDirectory: directory, replacementDirectory: replacement } =
      writeSlackProxyAddrFixture();
    const target = path.join(directory, "node_modules/@slack/bolt/node_modules/proxy-addr");
    patchOpenClawSlackProxyAddrPackageGraph(directory, replacement);
    expect(readFileSync(path.join(target, "index.js"), "utf8")).toBe(
      readFileSync(path.join(replacement, "index.js"), "utf8"),
    );
    expect(readJson(path.join(target, "package.json"))).toMatchObject({ version: "2.0.8" });
    expect(() => patchOpenClawSlackProxyAddrPackageGraph(directory, replacement)).toThrow(
      "must be proxy-addr@2.0.7",
    );
  });
  it("hashes package entries through opened file descriptors", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-tree-integrity-"));
    temporaryDirectories.push(directory);
    mkdirSync(path.join(directory, "nested"));
    writeFileSync(path.join(directory, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(path.join(directory, "nested", "content.txt"), "reviewed content\n");

    const first = hashPackageTree(directory);
    const second = hashPackageTree(directory);

    expect(first).toMatch(/^sha512-/);
    expect(second).toBe(first);
  });

  it("rejects symbolic links in a remediated package tree", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-tree-symlink-"));
    temporaryDirectories.push(directory);
    const outside = path.join(directory, "..", `${path.basename(directory)}-outside`);
    writeFileSync(outside, "must not be hashed\n");
    temporaryDirectories.push(outside);
    symlinkSync(outside, path.join(directory, "linked-content"));

    expect(() => hashPackageTree(directory)).toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "rejects FIFOs without blocking in a remediated package tree",
    () => {
      const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-openclaw-tree-fifo-"));
      temporaryDirectories.push(directory);
      const fifo = path.join(directory, "blocked-reader");
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 5000 });
      expect(created.status, created.stderr).toBe(0);

      const startedAt = Date.now();
      expect(() => hashPackageTree(directory)).toThrow(/unsupported entry/);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    },
  );

  // source-shape-contract: security -- Exact package and shrinkwrap identities prove the guarded Axios remediation installs only the reviewed replacement graph
  it("replaces the reviewed bundled Axios graph with the patched graph", () => {
    const directory = writeFixture();

    patchOpenClawPluginPackageGraph(directory, "@openclaw/slack@2026.7.1");

    expect(readPackageField<string>(directory, "dependencies.axios")).toBe("1.18.0");
    expect(readPackageField<string[]>(directory, "bundledDependencies")).toEqual([
      "@slack/bolt",
      "axios",
    ]);

    const shrinkwrap = readJson<{
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    expect(shrinkwrap.packages["node_modules/axios"]).toMatchObject({
      version: "1.18.0",
      resolved: "https://registry.npmjs.org/axios/-/axios-1.18.0.tgz",
      integrity:
        "sha512-E32NzpYKp++W7XRe52rHiXV2ehxmh3wbdgO7MHeFM+vqxLBYHzt0ElkiImtOBxtOmyp0yoC8C6uESVV84Y2/hw==",
      dependencies: { "https-proxy-agent": "^5.0.1" },
    });
    expect(shrinkwrap.packages["node_modules/axios/node_modules/https-proxy-agent"]).toMatchObject({
      version: "5.0.1",
      resolved: "https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-5.0.1.tgz",
      integrity:
        "sha512-dFcAjpTQFgoLMzC2VwU+C/CbS7uRL0lWmxDITmqm7C+7F0Odmj6s9l6alZc6AELXhrnggM2CeWSXHGOdX2YtwA==",
      dependencies: { "agent-base": "6" },
    });
    expect(
      shrinkwrap.packages[
        "node_modules/axios/node_modules/https-proxy-agent/node_modules/agent-base"
      ],
    ).toMatchObject({
      version: "6.0.2",
      resolved: "https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz",
      integrity:
        "sha512-RZNwNclF7+MS/8bDg70amg32dyeZGZxiDuQmZxKLAlQjr3jGyLx+4Kkk58UO7D2QdgFIQCovuSuZESne6RG6XQ==",
      dependencies: { debug: "4" },
    });
  });

  it("rejects an upstream Axios graph that changed after review", () => {
    const directory = writeFixture("1.17.0");

    expect(() => patchOpenClawPluginPackageGraph(directory, "@openclaw/slack@2026.7.1")).toThrow(
      "must resolve node_modules/axios to 1.16.0 before remediation",
    );
  });

  // source-shape-contract: security -- Exact Slack, Bolt, Express, and proxy-addr identities constrain the archive rewrite to the reviewed vulnerable package
  it("replaces only the reviewed Slack bundled proxy-addr package", () => {
    const { packageDirectory, replacementDirectory } = writeSlackProxyAddrFixture();

    patchOpenClawSlackProxyAddrPackageGraph(packageDirectory, replacementDirectory);

    const proxyAddrDirectory = path.join(
      packageDirectory,
      "node_modules",
      "@slack",
      "bolt",
      "node_modules",
      "proxy-addr",
    );
    expect(readPackageField<string>(proxyAddrDirectory, "version")).toBe("2.0.8");
    expect(readFileSync(path.join(proxyAddrDirectory, "index.js"), "utf8")).toBe(
      "module.exports = 'patched';\n",
    );
    expect(
      readPackageField<string>(
        path.join(packageDirectory, "node_modules", "@slack", "bolt", "node_modules", "express"),
        "dependencies.proxy-addr",
      ),
    ).toBe("^2.0.7");
  });

  it("rejects a Slack bundled proxy-addr identity that changed after review", () => {
    const { packageDirectory, replacementDirectory } = writeSlackProxyAddrFixture("2.0.6");

    expect(() =>
      patchOpenClawSlackProxyAddrPackageGraph(packageDirectory, replacementDirectory),
    ).toThrow("must be proxy-addr@2.0.7");
  });

  it("rejects a proxy-addr replacement identity that changed after review", () => {
    const { packageDirectory, replacementDirectory } = writeSlackProxyAddrFixture("2.0.7", "2.0.9");

    expect(() =>
      patchOpenClawSlackProxyAddrPackageGraph(packageDirectory, replacementDirectory),
    ).toThrow("must be proxy-addr@2.0.8");
  });

  // source-shape-contract: security -- Exact package and shrinkwrap identities prove the guarded Jaeger remediation installs only the reviewed aligned graph
  it("replaces the reviewed Jaeger propagator with its aligned patched core", () => {
    const directory = writeDiagnosticsFixture();

    patchOpenClawDiagnosticsOtelPackageGraph(directory);

    expect(
      readPackageField<string>(
        path.join(directory, "node_modules", "@opentelemetry", "sdk-node"),
        "dependencies.@opentelemetry/propagator-jaeger",
      ),
    ).toBe("2.9.0");
    const shrinkwrap = readJson<{
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    expect(shrinkwrap.packages["node_modules/@opentelemetry/propagator-jaeger"]).toMatchObject({
      version: "2.9.0",
      dependencies: { "@opentelemetry/core": "2.9.0" },
    });
    expect(
      shrinkwrap.packages[
        "node_modules/@opentelemetry/propagator-jaeger/node_modules/@opentelemetry/core"
      ],
    ).toMatchObject({
      version: "2.9.0",
      dependencies: { "@opentelemetry/semantic-conventions": "^1.29.0" },
    });
  });

  it("rejects a diagnostics Jaeger graph that changed after review", () => {
    const directory = writeDiagnosticsFixture("2.8.1");

    expect(() => patchOpenClawDiagnosticsOtelPackageGraph(directory)).toThrow(
      "with Jaeger propagator 2.8.0 before remediation",
    );
  });

  it("rejects a legacy rebuild fixture tar graph that changed after review", () => {
    const directory = writeLegacyCoreFixture("7.5.12");

    expect(() => patchLegacyOpenClawCorePackageGraph(directory)).toThrow(
      "must declare reviewed tar@7.5.11 before remediation",
    );
  });

  it("replaces the reviewed OpenClaw 2026.7.1 dependency resolutions", () => {
    const directory = writeCurrentCoreFixture();

    patchCurrentOpenClawCorePackageGraph(directory);

    const shrinkwrap = readJson<{
      packages: Record<
        string,
        {
          dependencies?: Record<string, string>;
          integrity?: string;
          optionalDependencies?: Record<string, string>;
          resolved?: string;
          version?: string;
        }
      >;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    expect(shrinkwrap.packages["node_modules/brace-expansion"]).toMatchObject({
      version: "5.0.9",
      resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz",
      integrity:
        "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==",
    });
    expect(shrinkwrap.packages["node_modules/fast-uri"]).toMatchObject({
      version: "3.1.7",
      resolved: "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.7.tgz",
      integrity:
        "sha512-dOvZVzjdZdz7phd9v6jCbwxrBW3fK6n8Rc0CtdmM4bumzMnxywBYhuph6J819RRw/ku+rLbelwfMunktuzVVHg==",
    });
    expect(shrinkwrap.packages["node_modules/undici"]).toMatchObject({
      version: "8.12.2",
      resolved: "https://registry.npmjs.org/undici/-/undici-8.12.2.tgz",
      integrity:
        "sha512-XtuDWVdqTLr3NAxm2ly9/hU6kUsJOgGh1RASzMBbsw6aWCOaQzHdW+QQDfdERjfJ2V5vL5pRPa4RetO9UfivDg==",
    });
    expect(shrinkwrap.packages["node_modules/ip-address"]).toMatchObject({
      version: "10.3.1",
      resolved: "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz",
      integrity:
        "sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==",
    });
    expect(shrinkwrap.packages["node_modules/tar"]).toMatchObject({
      version: "7.5.21",
      resolved: "https://registry.npmjs.org/tar/-/tar-7.5.21.tgz",
      integrity:
        "sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==",
    });
    expect(shrinkwrap.packages["node_modules/@openclaw/fs-safe"].optionalDependencies).toEqual({
      jszip: "^3.10.1",
      tar: "7.5.21",
    });
    expect(shrinkwrap.packages[""].dependencies).toMatchObject({ tar: "7.5.21" });
    expect(
      readJson<{ dependencies: Record<string, string> }>(path.join(directory, "package.json")),
    ).toMatchObject({ dependencies: { tar: "7.5.21", undici: "8.12.2" } });
  });

  it("rejects a current OpenClaw manifest with a changed tar dependency", () => {
    const directory = writeCurrentCoreFixture();
    const packageJsonPath = path.join(directory, "package.json");
    const packageJson = readJson<{ dependencies: Record<string, string> }>(packageJsonPath);
    packageJson.dependencies.tar = "7.5.20";
    writeJson(packageJsonPath, packageJson);

    expect(() => patchCurrentOpenClawCorePackageGraph(directory)).toThrow(
      "dependency boundary changed after review",
    );
  });

  it("rejects a current OpenClaw fs-safe edge with a changed tar dependency", () => {
    const directory = writeCurrentCoreFixture();
    const shrinkwrapPath = path.join(directory, "npm-shrinkwrap.json");
    const shrinkwrap = readJson<{
      packages: Record<string, { optionalDependencies: Record<string, string> }>;
    }>(shrinkwrapPath);
    shrinkwrap.packages["node_modules/@openclaw/fs-safe"].optionalDependencies.tar = "7.5.20";
    writeJson(shrinkwrapPath, shrinkwrap);

    expect(() => patchCurrentOpenClawCorePackageGraph(directory)).toThrow(
      "@openclaw/fs-safe tar layout changed after review",
    );
  });

  it.each([
    ["version", "7.5.20"],
    ["resolved", "https://registry.npmjs.org/tar/-/tar-7.5.20.tgz"],
    ["integrity", "sha512-deliberate-mismatch"],
  ])("rejects a current OpenClaw tar shrinkwrap with changed %s", (field, value) => {
    const directory = writeCurrentCoreFixture();
    const shrinkwrapPath = path.join(directory, "npm-shrinkwrap.json");
    const shrinkwrap = readJson<{
      packages: Record<string, Record<string, unknown>>;
    }>(shrinkwrapPath);
    shrinkwrap.packages["node_modules/tar"][field] = value;
    writeJson(shrinkwrapPath, shrinkwrap);

    expect(() => patchCurrentOpenClawCorePackageGraph(directory)).toThrow(
      "tar layout changed after review",
    );
  });

  it.each([
    ["brace-expansion", "5.0.6", "brace-expansion layout changed after review"],
    ["fast-uri", "3.1.1", "fast-uri layout changed after review"],
    ["undici", "8.4.0", "dependency boundary changed after review"],
    ["ip-address", "10.1.1", "ip-address layout changed after review"],
  ])(
    "rejects a current OpenClaw %s graph that changed after review",
    (dependency, version, error) => {
      const directory =
        dependency === "brace-expansion"
          ? writeCurrentCoreFixture(version)
          : dependency === "fast-uri"
            ? writeCurrentCoreFixture("5.0.7", version)
            : dependency === "undici"
              ? writeCurrentCoreFixture("5.0.7", "3.1.2", version)
              : writeCurrentCoreFixture("5.0.7", "3.1.2", "8.5.0", version);

      expect(() => patchCurrentOpenClawCorePackageGraph(directory)).toThrow(error);
    },
  );

  it.each([
    ["resolved", "https://registry.npmjs.org/undici/-/undici-8.4.0.tgz"],
    ["integrity", "sha512-deliberate-mismatch"],
    ["engines", { node: ">=22.20.0" }],
  ])("rejects a current OpenClaw undici shrinkwrap with changed %s", (field, value) => {
    const directory = writeCurrentCoreFixture();
    const shrinkwrapPath = path.join(directory, "npm-shrinkwrap.json");
    const shrinkwrap = readJson<{
      packages: Record<string, Record<string, unknown>>;
    }>(shrinkwrapPath);
    shrinkwrap.packages["node_modules/undici"][field] = value;
    writeJson(shrinkwrapPath, shrinkwrap);

    expect(() => patchCurrentOpenClawCorePackageGraph(directory)).toThrow(
      "undici layout changed after review",
    );
  });

  // source-shape-contract: security -- Exact package and shrinkwrap identities prove the guarded Discord remediation installs only the reviewed undici graph
  it("replaces the reviewed OpenClaw Discord undici dependency", () => {
    const directory = writeDiscordFixture();

    patchOpenClawDiscordPackageGraph(directory);

    expect(readPackageField<string>(directory, "dependencies.undici")).toBe("8.12.2");
    const shrinkwrap = readJson<{
      packages: Record<
        string,
        {
          dependencies?: Record<string, string>;
          integrity?: string;
          resolved?: string;
          version?: string;
        }
      >;
    }>(path.join(directory, "npm-shrinkwrap.json"));
    expect(shrinkwrap.packages[""].dependencies).toMatchObject({ undici: "8.12.2" });
    expect(shrinkwrap.packages["node_modules/undici"]).toMatchObject({
      version: "8.12.2",
      resolved: "https://registry.npmjs.org/undici/-/undici-8.12.2.tgz",
      integrity:
        "sha512-XtuDWVdqTLr3NAxm2ly9/hU6kUsJOgGh1RASzMBbsw6aWCOaQzHdW+QQDfdERjfJ2V5vL5pRPa4RetO9UfivDg==",
    });
  });

  it("rejects an OpenClaw Discord undici graph that changed after review", () => {
    const directory = writeDiscordFixture("8.4.0");

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow(
      "undici dependency changed after review",
    );
  });

  it.each([
    ["resolved", "https://registry.npmjs.org/undici/-/undici-8.4.0.tgz"],
    ["integrity", "sha512-deliberate-mismatch"],
    ["engines", { node: ">=22.20.0" }],
  ])("rejects an OpenClaw Discord undici shrinkwrap with changed %s", (field, value) => {
    const directory = writeDiscordFixture();
    const shrinkwrapPath = path.join(directory, "npm-shrinkwrap.json");
    const shrinkwrap = readJson<{
      packages: Record<string, Record<string, unknown>>;
    }>(shrinkwrapPath);
    shrinkwrap.packages["node_modules/undici"][field] = value;
    writeJson(shrinkwrapPath, shrinkwrap);

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow(
      "undici layout changed after review",
    );
  });

  it("rejects a changed OpenClaw Discord bundled undici identity", () => {
    const directory = writeDiscordFixture();
    writeJson(path.join(directory, "node_modules", "undici", "package.json"), {
      name: "undici",
      version: "8.4.0",
      engines: { node: ">=22.19.0" },
    });

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow("must be undici@8.5.0");
  });

  it("rejects a changed OpenClaw Discord bundled undici layout", () => {
    const directory = writeDiscordFixture();
    writeJson(path.join(directory, "node_modules", "undici", "package.json"), {
      name: "undici",
      version: "8.5.0",
      engines: { node: ">=22.20.0" },
    });

    expect(() => patchOpenClawDiscordPackageGraph(directory)).toThrow(
      "bundled undici layout changed after review",
    );
  });

  it("rebuilds the legacy fixture archive with the reviewed tar package bundled", () => {
    const fixture = writeLegacyCoreArchiveFixtures();
    const request = {
      archivePath: fixture.archivePath,
      env: {
        NEMOCLAW_REVIEWED_NPM_EXECUTABLE: fixture.npmExecutable,
        NPM_CONFIG_CACHE: path.join(path.dirname(fixture.archivePath), "npm-cache"),
      },
      packageSpec: "openclaw@2026.3.11",
      workingDirectory: fixture.workingDirectory,
    };
    const remediated = buildRemediatedOpenClawPluginArchive(request);
    expect(() =>
      buildRemediatedOpenClawPluginArchive({
        ...request,
        expectedPatchedMetadataIntegrity: "sha512-deliberate-mismatch",
      }),
    ).toThrow(`got ${remediated.metadataIntegrity}`);

    const extracted = path.join(path.dirname(fixture.archivePath), "asserted");
    mkdirSync(extracted, { recursive: true });
    const extraction = spawnSync("tar", ["-xzf", remediated.archivePath, "-C", extracted], {
      encoding: "utf8",
    });
    expect(extraction.status, extraction.stderr).toBe(0);
    expect(existsSync(path.join(extracted, "package", "npm-shrinkwrap.json"))).toBe(false);
    expect(
      readJson<{
        bundledDependencies?: string[];
        dependencies?: Record<string, string>;
      }>(path.join(extracted, "package", "package.json")),
    ).toMatchObject({
      bundledDependencies: ["tar", "@whiskeysockets/baileys", "libsignal"],
      dependencies: {
        "@whiskeysockets/baileys": "7.0.0-rc.9",
        libsignal: "6.0.0",
        tar: "7.5.21",
      },
    });
    expect(
      readJson<{ name?: string; version?: string }>(
        path.join(extracted, "package", "node_modules", "tar", "package.json"),
      ),
    ).toMatchObject({ name: "tar", version: "7.5.21" });
    expect(
      readJson<{
        dependencies?: Record<string, string>;
        name?: string;
        version?: string;
      }>(
        path.join(
          extracted,
          "package",
          "node_modules",
          "@whiskeysockets",
          "baileys",
          "package.json",
        ),
      ),
    ).toMatchObject({
      name: "@whiskeysockets/baileys",
      version: "7.0.0-rc.9",
      dependencies: { libsignal: "6.0.0" },
    });
    expect(
      readJson<{ name?: string; version?: string }>(
        path.join(extracted, "package", "node_modules", "libsignal", "package.json"),
      ),
    ).toMatchObject({ name: "libsignal", version: "6.0.0" });
  }, 60_000);
});

describe("Teams native dependency remediation", () => {
  function teamsFixture() {
    const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-teams-msal-"));
    temporaryDirectories.push(root);
    const project = `openclaw-msteams-${createHash("sha256").update("@openclaw/msteams").digest("hex").slice(0, 10)}`;
    const modules = path.join(root, "npm/projects", project, "node_modules");
    const packageDirectory = path.join(modules, "@openclaw/msteams");
    const packages = [
      [
        "@openclaw/msteams",
        { name: "@openclaw/msteams", version: "2026.9.2", dependencies: { zod: "4.4.3" } },
      ],
      [
        "@azure/identity",
        {
          name: "@azure/identity",
          version: "4.13.2",
          dependencies: { "@azure/msal-node": "^5.1.5" },
        },
      ],
      [
        "@microsoft/teams.apps",
        {
          name: "@microsoft/teams.apps",
          version: "2.0.15",
          dependencies: { "@azure/msal-node": "^5.2.2" },
        },
      ],
      [
        "@azure/msal-node",
        {
          name: "@azure/msal-node",
          version: "5.6.0",
          main: "index.cjs",
          dependencies: { "@azure/msal-common": "16.13.0", jsonwebtoken: "^9.0.0" },
        },
      ],
      ["@azure/msal-common", { name: "@azure/msal-common", version: "16.14.0" }],
      ["zod", { name: "zod", version: "4.4.3", main: "index.cjs" }],
    ] as const;
    packages.forEach(([name, metadata]) => {
      mkdirSync(path.join(modules, name), { recursive: true });
      writeJson(path.join(modules, name, "package.json"), metadata);
    });
    const archives = path.join(root, "archives");
    mkdirSync(archives);
    ["msal-node-7.1.0", "msal-common-16.14.2", "zod-4.6.6"].forEach((name) =>
      cpSync(
        path.resolve(import.meta.dirname, "../../fixtures/npm", name, `${name}.tgz`),
        path.join(archives, `${name}.tgz`),
      ),
    );
    const target = path.join(modules, "@azure/msal-node");
    writeFileSync(path.join(target, "index.cjs"), "vulnerable-original");
    writeFileSync(path.join(modules, "zod/index.cjs"), "vulnerable-zod");
    return {
      root,
      modules,
      target,
      request: {
        archivePath: path.join(root, "unused.tgz"),
        packageSpec: "@openclaw/msteams@2026.9.2",
        workingDirectory: root,
        trustedStateRoot: root,
        packageDirectory,
        env: { NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR: archives },
      },
    };
  }

  it("replaces shared MSAL and its Common together while preserving the browser Common", () => {
    const fixture = teamsFixture();
    remediateInstalledOfficialOpenClawPlugin(fixture.request);
    expect(readJson(path.join(fixture.target, "package.json"))).toMatchObject({ version: "7.1.0" });
    expect(
      readJson(path.join(fixture.target, "node_modules/@azure/msal-common/package.json")),
    ).toMatchObject({ version: "16.14.2" });
    expect(readJson(path.join(fixture.modules, "@azure/msal-common/package.json"))).toMatchObject({
      version: "16.14.0",
    });
    expect(existsSync(path.join(fixture.target, "index.cjs"))).toBe(false);
    const zod = createRequire(path.join(fixture.request.packageDirectory, "package.json"))("zod");
    expect(
      createRequire(path.join(fixture.request.packageDirectory, "package.json"))("zod/package.json")
        .version,
    ).toBe("4.6.6");
    let visited = 0;
    const bounded = zod
      .array(
        zod.string().superRefine(() => {
          visited += 1;
        }),
      )
      .max(1);
    expect(bounded.safeParse(["a", "b"]).success).toBe(false);
    expect(visited).toBe(0);
    expect(bounded.parse(["a"])).toEqual(["a"]);
  });

  it.each([
    "dependency link",
    "nested MSAL",
    "unreviewed SDK",
    "wrong project",
    "nested Zod",
    "Zod link",
    "unreviewed Zod",
  ])("denies %s before replacing MSAL", (scenario) => {
    const fixture = teamsFixture();
    const identity = path.join(fixture.modules, "@azure/identity");
    const mutations: Record<string, () => void> = {
      "dependency link": () => {
        const original = path.join(fixture.root, "original-identity");
        cpSync(identity, original, { recursive: true });
        rmSync(identity, { recursive: true });
        symlinkSync(original, identity);
      },
      "nested MSAL": () => {
        const nested = path.join(identity, "node_modules/@azure/msal-node");
        mkdirSync(nested, { recursive: true });
        writeJson(path.join(nested, "package.json"), {
          name: "@azure/msal-node",
          version: "5.6.0",
          main: "index.cjs",
        });
        writeFileSync(path.join(nested, "index.cjs"), "nested-vulnerable");
      },
      "unreviewed SDK": () =>
        writeJson(path.join(identity, "package.json"), {
          name: "@azure/identity",
          version: "5.0.0",
        }),
      "nested Zod": () => {
        const nested = path.join(fixture.request.packageDirectory, "node_modules/zod");
        mkdirSync(nested, { recursive: true });
        writeJson(path.join(nested, "package.json"), {
          name: "zod",
          version: "4.4.3",
          main: "index.cjs",
        });
        writeFileSync(path.join(nested, "index.cjs"), "nested-vulnerable");
      },
      "Zod link": () => {
        const target = path.join(fixture.modules, "zod");
        const original = path.join(fixture.root, "original-zod");
        cpSync(target, original, { recursive: true });
        rmSync(target, { recursive: true });
        symlinkSync(original, target);
      },
      "unreviewed Zod": () =>
        writeJson(path.join(fixture.modules, "zod/package.json"), {
          name: "zod",
          version: "5.0.0",
        }),
      "wrong project": () => {
        fixture.request.trustedStateRoot = fixture.modules;
      },
    };
    mutations[scenario]();
    expect(() => remediateInstalledOfficialOpenClawPlugin(fixture.request)).toThrow(
      "reviewed dependency graph",
    );
    expect(readFileSync(path.join(fixture.target, "index.cjs"), "utf8")).toBe(
      "vulnerable-original",
    );
  });
});
