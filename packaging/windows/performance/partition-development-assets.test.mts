// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  partitionDevelopmentAssets,
  planDevelopmentPartition,
  verifyPartitionUnion,
} from "./partition-development-assets.mts";

const exec = promisify(execFile);
async function fixture(): Promise<{
  base: string;
  payload: string;
  diagnostics: string;
  write(name: string, value: string): Promise<void>;
}> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "native-partition-"));
  const payload = path.join(base, "payload");
  const write = async (name: string, value: string) => {
    const target = path.join(payload, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value);
  };
  await write(
    "runtime-payload-receipt.json",
    JSON.stringify({
      classification: "nemoclaw-native-windows-arm64-runtime-payload",
      nemoclaw: { revision: "a".repeat(40) },
    }),
  );
  return { base, payload, diagnostics: path.join(base, "diagnostics"), write };
}
const map = JSON.stringify({ version: 3, sources: ["index.ts"], mappings: "AAAA" });

test("the build command preserves plan inputs and separates verified production assets", async () => {
  const f = await fixture();
  try {
    const prefix = "pi/node_modules/cli-fixture/";
    await f.write(
      prefix + "package.json",
      JSON.stringify({ types: "./index.d.ts", main: "./index.js" }),
    );
    await f.write(prefix + "index.d.ts", "export declare const sentinel: number;\n");
    await f.write(prefix + "index.js", "exports.sentinel = 42;\n");
    const output = path.join(f.base, "plan.json");
    const cli = fileURLToPath(new URL("./partition-payload.mts", import.meta.url));
    const invoke = (mode: string, destination: string, revision = "a".repeat(40)) =>
      exec(process.execPath, [
        "--experimental-strip-types",
        "--no-warnings",
        cli,
        mode,
        f.payload,
        destination,
        revision,
      ]);
    const planned = JSON.parse((await invoke("plan", output)).stdout);
    assert.equal(planned.filesEligible, 1);
    assert.equal(planned.installedAcceptance, false);
    const original = await fs.readFile(path.join(f.payload, prefix + "index.d.ts"));
    await assert.rejects(invoke("plan", output), /EEXIST/);
    await assert.rejects(
      invoke("partition", f.diagnostics, "b".repeat(40)),
      /differs from the expected revision/,
    );
    await assert.rejects(fs.stat(f.diagnostics), { code: "ENOENT" });
    const partitioned = JSON.parse((await invoke("partition", f.diagnostics)).stdout);
    assert.equal(partitioned.sourceInventorySha256, planned.sourceInventorySha256);
    assert.deepEqual(await fs.readFile(path.join(f.diagnostics, prefix + "index.d.ts")), original);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(f.diagnostics, "partition-receipt.json"), "utf8"))
        .completeSourceUnionVerified,
      true,
    );
    await assert.rejects(fs.stat(path.join(f.payload, prefix + "index.d.ts")), { code: "ENOENT" });
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("production retains working dynamic code and licenses while diagnostics receives exact development files", async () => {
  const f = await fixture();
  try {
    const prefix = "openclaw/node_modules/example/";
    await f.write(
      prefix + "package.json",
      JSON.stringify({ type: "module", exports: { types: "./index.d.ts", default: "./index.js" } }),
    );
    await f.write(
      prefix + "index.js",
      'export async function value() { return (await import("./dynamic.js")).value; }\n//# sourceMappingURL=index.js.map\n',
    );
    await f.write(prefix + "dynamic.js", "export const value = 42;\n");
    await f.write(prefix + "index.d.ts", "export declare function value(): Promise<number>;\n");
    await f.write(prefix + "index.js.map", map);
    await f.write(prefix + "LICENSE.txt", "Required upstream license\n");
    await f.write(prefix + "runtime.ts", "export const plugin = true;\n");
    const invocation = [
      "--input-type=module",
      "-e",
      "const m = await import(process.argv[1]); console.log(await m.value());",
      pathToFileURL(path.join(f.payload, prefix, "index.js")).href,
    ];
    const before = await exec(process.execPath, invocation, { cwd: f.payload });
    const result = await partitionDevelopmentAssets(f.payload, f.diagnostics);
    const after = await exec(process.execPath, invocation, { cwd: f.payload });
    assert.equal(before.stdout, "42\n");
    assert.equal(after.stdout, before.stdout);
    assert.equal(result.moved.length, 2);
    assert.equal(await fs.readFile(path.join(f.diagnostics, prefix, "index.js.map"), "utf8"), map);
    assert.equal(
      await fs.readFile(path.join(f.payload, prefix, "LICENSE.txt"), "utf8"),
      "Required upstream license\n",
    );
    assert.equal(
      await fs.readFile(path.join(f.payload, prefix, "runtime.ts"), "utf8"),
      "export const plugin = true;\n",
    );
    await assert.rejects(fs.stat(path.join(f.payload, prefix, "index.d.ts")), { code: "ENOENT" });
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("runtime exports, compiler declarations and non-source-map data are retained", async () => {
  const f = await fixture();
  try {
    await f.write(
      "pi/node_modules/compiler/package.json",
      JSON.stringify({ exports: { "./schema": "./schema.d.ts" } }),
    );
    await f.write("pi/node_modules/compiler/schema.d.ts", "runtime-readable declaration\n");
    await f.write("pi/node_modules/typescript/lib/lib.esnext.d.ts", "compiler resource\n");
    await f.write(
      "pi/node_modules/compiler/data.js.map",
      JSON.stringify({ version: 7, map: "runtime data" }),
    );
    await f.write("hermes/hermes-agent/custom.d.ts", "outside audited Node distributions\n");
    const result = await planDevelopmentPartition(f.payload);
    assert.equal(result.moved.length, 0);
    assert.equal(result.retainedCandidates.length, 4);
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("runtime export wildcards protect matching assets but type-only conditions do not", async () => {
  const f = await fixture();
  try {
    await f.write(
      "nemoclaw/node_modules/sdk/package.json",
      JSON.stringify({
        exports: {
          "./schema/*": "./schemas/*.d.ts",
          "./api": { "types@>=5": "./api.d.ts", default: "./api.js" },
        },
      }),
    );
    await f.write("nemoclaw/node_modules/sdk/schemas/user.d.ts", "schema asset\n");
    await f.write("nemoclaw/node_modules/sdk/api.d.ts", "type declaration\n");
    const result = await planDevelopmentPartition(f.payload);
    assert.deepEqual(
      result.moved.map((x) => x.path),
      ["nemoclaw/node_modules/sdk/api.d.ts"],
    );
    assert.deepEqual(
      result.retainedCandidates.map((x) => x.path),
      ["nemoclaw/node_modules/sdk/schemas/user.d.ts"],
    );
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("a symbolic link aborts before any production file moves", async () => {
  const f = await fixture();
  try {
    await f.write("nemoclaw/app/dist/index.d.ts", "keep on failure\n");
    const linked = path.join(f.base, "linked-target");
    await fs.mkdir(linked);
    await fs.symlink(
      linked,
      path.join(f.payload, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(partitionDevelopmentAssets(f.payload, f.diagnostics), /reparse points/);
    assert.equal(
      await fs.readFile(path.join(f.payload, "nemoclaw/app/dist/index.d.ts"), "utf8"),
      "keep on failure\n",
    );
    await assert.rejects(fs.stat(f.diagnostics), { code: "ENOENT" });
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("diagnostics cannot replace production or an existing artifact", async () => {
  const f = await fixture();
  try {
    await f.write("nemoclaw/app/dist/index.d.ts", "declaration\n");
    await assert.rejects(
      partitionDevelopmentAssets(f.payload, path.join(f.payload, "diagnostics")),
      /separate/,
    );
    await fs.mkdir(f.diagnostics);
    await assert.rejects(partitionDevelopmentAssets(f.payload, f.diagnostics), { code: "EEXIST" });
    assert.equal(
      await fs.readFile(path.join(f.payload, "nemoclaw/app/dist/index.d.ts"), "utf8"),
      "declaration\n",
    );
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("official Hermes Node trees and unproven declarations remain outside the partition", async () => {
  const f = await fixture();
  try {
    for (const prefix of [
      "hermes/hermes-agent/node_modules/example/",
      "openclaw/node_modules/unproven/",
    ]) {
      await f.write(prefix + "package.json", JSON.stringify({ type: "module" }));
      await f.write(prefix + "schema.d.ts", "runtime-readable schema\n");
    }
    const prefix = "hermes/hermes-agent/node_modules/example/";
    await f.write(
      prefix + "index.js",
      "export const value = 1;\n//# sourceMappingURL=index.js.map\n",
    );
    await f.write(prefix + "index.js.map", map);
    const result = await planDevelopmentPartition(f.payload);
    assert.equal(result.moved.length, 0);
    assert.equal(result.retainedCandidates.length, 3);
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("an ancestor export remains a working resource through nested package metadata", async () => {
  const f = await fixture();
  try {
    const prefix = "openclaw/node_modules/example/";
    await f.write(
      prefix + "package.json",
      JSON.stringify({
        name: "example",
        type: "module",
        exports: { "./schema": "./dist/schema.d.ts" },
        bin: { types: "./command.d.ts" },
      }),
    );
    await f.write(prefix + "dist/package.json", JSON.stringify({ type: "module" }));
    await f.write(prefix + "dist/schema.d.ts", "runtime schema\n");
    await f.write(prefix + "command.d.ts", "runtime command\n");
    const args = [
      "--input-type=module",
      "-e",
      'import fs from "node:fs";import {fileURLToPath} from "node:url";process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.resolve("example/schema")),"utf8"));',
    ];
    const before = await exec(process.execPath, args, { cwd: path.join(f.payload, "openclaw") });
    const result = await partitionDevelopmentAssets(f.payload, f.diagnostics);
    const after = await exec(process.execPath, args, { cwd: path.join(f.payload, "openclaw") });
    assert.equal(before.stdout, "runtime schema\n");
    assert.equal(after.stdout, before.stdout);
    assert.equal(result.moved.length, 0);
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("a literal declaration resource read stays functional even when package metadata calls it types", async () => {
  const f = await fixture();
  try {
    const prefix = "pi/node_modules/schema-reader/";
    await f.write(
      prefix + "package.json",
      JSON.stringify({ type: "module", types: "./schema.d.ts" }),
    );
    await f.write(prefix + "schema.d.ts", "schema preserved\n");
    await f.write(
      prefix + "index.js",
      'import fs from "node:fs";export const schema=fs.readFileSync(new URL("./schema.d.ts",import.meta.url),"utf8");\n',
    );
    const args = [
      "--input-type=module",
      "-e",
      "const value=await import(process.argv[1]);process.stdout.write(value.schema);",
      pathToFileURL(path.join(f.payload, prefix, "index.js")).href,
    ];
    const before = await exec(process.execPath, args);
    const result = await partitionDevelopmentAssets(f.payload, f.diagnostics);
    assert.equal(result.moved.length, 0);
    assert.equal((await exec(process.execPath, args)).stdout, before.stdout);
    assert.equal(before.stdout, "schema preserved\n");
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("a source-map-looking string is not a source mapping comment", async () => {
  const f = await fixture();
  try {
    const prefix = "nemoclaw/node_modules/map-data/";
    await f.write(prefix + "package.json", JSON.stringify({ type: "module" }));
    await f.write(
      prefix + "index.js",
      'export const text = "//# sourceMappingURL=index.js.map";\n',
    );
    await f.write(prefix + "index.js.map", map);
    assert.equal((await planDevelopmentPartition(f.payload)).moved.length, 0);
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("source, production and diagnostics inventory files carry exact byte digests", async () => {
  const f = await fixture();
  try {
    const prefix = "nemoclaw/node_modules/typed/";
    await f.write(
      prefix + "package.json",
      JSON.stringify({ types: "./index.d.ts", main: "./index.js" }),
    );
    await f.write(prefix + "index.d.ts", "export declare const value: number;\n");
    await f.write(prefix + "index.js", "exports.value=3;\n");
    const plan = await partitionDevelopmentAssets(f.payload, f.diagnostics, {
      expectedSourceRevision: "a".repeat(40),
    });
    const receipt = JSON.parse(
      await fs.readFile(path.join(f.diagnostics, "partition-receipt.json"), "utf8"),
    );
    for (const [name, field] of [
      ["source", "sourceInventorySha256"],
      ["production", "productionInventorySha256"],
      ["diagnostics", "diagnosticsInventorySha256"],
    ]) {
      const bytes = await fs.readFile(path.join(f.diagnostics, name + "-inventory.json"));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt[field]);
    }
    assert.equal(receipt.completeSourceUnionVerified, true);
    assert.equal(receipt.filesMoved + receipt.filesProduction, receipt.filesBefore);
    const verified = await verifyPartitionUnion(f.payload, f.diagnostics, plan);
    assert.equal(verified.diagnostics.length, 1);
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("union verification rejects changed production, lost diagnostics, and altered inventory sidecars", async () => {
  const f = await fixture();
  try {
    const prefix = "openclaw/node_modules/typed/";
    await f.write(prefix + "package.json", JSON.stringify({ types: "./index.d.ts" }));
    await f.write(prefix + "index.d.ts", "declaration\n");
    await f.write(prefix + "index.js", "exports.value=3;\n");
    const plan = await partitionDevelopmentAssets(f.payload, f.diagnostics);
    await f.write(prefix + "index.js", "changed\n");
    await assert.rejects(
      verifyPartitionUnion(f.payload, f.diagnostics, plan),
      /complete unchanged source inventory/,
    );
    await f.write(prefix + "index.js", "exports.value=3;\n");
    const declarationPath = path.join(f.diagnostics, prefix, "index.d.ts");
    await fs.unlink(declarationPath);
    await assert.rejects(
      verifyPartitionUnion(f.payload, f.diagnostics, plan),
      /complete unchanged source inventory/,
    );
    await fs.writeFile(declarationPath, "declaration\n");
    await fs.writeFile(path.join(f.diagnostics, "production-inventory.json"), "[]\n");
    await assert.rejects(
      verifyPartitionUnion(f.payload, f.diagnostics, plan),
      /Recorded partition inventory differs/,
    );
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("an expected source mismatch refuses the partition before creating diagnostics", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      partitionDevelopmentAssets(f.payload, f.diagnostics, {
        expectedSourceRevision: "b".repeat(40),
      }),
      /expected revision/,
    );
    await assert.rejects(fs.stat(f.diagnostics), { code: "ENOENT" });
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});
