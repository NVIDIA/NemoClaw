// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hashPackageTree,
  migrateDiscordZodDeclarations,
  migrateDiscordZodSource,
  patchOpenClawBundledZodPackageGraph,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

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
