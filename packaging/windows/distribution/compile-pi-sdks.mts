// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Compact SDK ESM modules at build time; retain Pi's original entrypoints and assets.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const SDK_ROOTS = {
  "@mistralai/mistralai": "esm",
  "@aws-sdk/client-bedrock-runtime": "dist-es",
  "@aws-sdk/core": "dist-es",
  "@aws-sdk/nested-clients": "dist-es",
  "@smithy/core": "dist-es",
};
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function compiledExports(value: any, mapping: Record<string, string>): any {
  if (typeof value === "string") return mapping[value] ?? value;
  if (Array.isArray(value)) return value.map((item) => compiledExports(item, mapping));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "source" || key === "types") continue;
    if (!key.includes("*")) result[key] = compiledExports(item, mapping);
    else {
      const target = typeof item === "string" ? item : (item as any).default;
      assert.equal(typeof target, "string", "Unsupported SDK export pattern.");
      const [prefix, suffix] = target.split("*");
      assert.equal(target.split("*").length, 2);
      for (const [source, output] of Object.entries(mapping)) {
        if (!source.startsWith(prefix) || !source.endsWith(suffix)) continue;
        const name = key.replace("*", source.slice(prefix.length, source.length - suffix.length));
        // Explicit package exports take precedence over wildcard exports.
        if (!(name in value))
          result[name] = typeof item === "string" ? output : { default: output };
      }
    }
  }
  return result;
}

function ordinaryFiles(root: string) {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name),
        info = fs.lstatSync(file);
      assert(!info.isSymbolicLink(), "SDK links cannot enter compilation.");
      if (info.isDirectory()) visit(file);
      else {
        assert(info.isFile(), "SDK special files cannot enter compilation.");
        files.push(file);
      }
    }
  };
  assert(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink());
  visit(root);
  return files;
}

export async function compileSdk(source: string, output: string, tree: string, compiler: any) {
  assert.equal(compiler.version, "0.27.4");
  assert(!fs.existsSync(output), "Compiled SDK output must be fresh.");
  const files = ordinaryFiles(source);
  const sourceHashes = files.map((file) => [file, digest(fs.readFileSync(file))]);
  const metadataBytes = fs.readFileSync(path.join(source, "package.json"));
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  const inputs = files.filter(
    (file) => file.startsWith(path.join(source, tree) + path.sep) && file.endsWith(".js"),
  );
  assert(inputs.length > 0, "SDK ESM entrypoints are absent.");
  const mapping = Object.fromEntries(
    inputs.map((file) => {
      const relative = path.relative(source, file).replaceAll(path.sep, "/");
      return ["./" + relative, "./" + tree + "/e-" + digest(relative).slice(0, 24) + ".mjs"];
    }),
  );
  assert.equal(new Set(Object.values(mapping)).size, inputs.length);
  const build = await compiler.build({
    absWorkingDir: source,
    entryPoints: inputs.map((file) => ({
      in: file,
      out: path.basename(
        mapping["./" + path.relative(source, file).replaceAll(path.sep, "/")],
        ".mjs",
      ),
    })),
    outdir: path.join(output, tree),
    outExtension: { ".js": ".mjs" },
    chunkNames: "c-[hash]",
    bundle: true,
    splitting: true,
    packages: "external",
    platform: "node",
    target: "node22",
    format: "esm",
    metafile: true,
    sourcemap: false,
    write: false,
    logLevel: "silent",
  });
  assert.equal(build.warnings.length, 0, "SDK compilation produced warnings.");
  for (const name of Object.keys(build.metafile.inputs)) {
    const resolved = path.resolve(source, name);
    assert(resolved.startsWith(source + path.sep), "SDK compilation escaped its package.");
  }
  assert.deepEqual(ordinaryFiles(source), files, "SDK input membership changed.");
  for (const [file, hash] of sourceHashes)
    assert.equal(digest(fs.readFileSync(file)), hash, "SDK input changed during compilation.");
  fs.mkdirSync(output, { recursive: true });
  for (const file of files) {
    const relative = path.relative(source, file);
    if (
      [tree, "src", "dist-types"].includes(relative.split(path.sep)[0]) ||
      relative === "package.json"
    )
      continue;
    // Mistral ships sibling SDK TypeScript workspaces, not runtime exports.
    if (metadata.name === "@mistralai/mistralai" && relative.split(path.sep)[0] === "packages")
      continue;
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
    assert.equal(digest(fs.readFileSync(target)), digest(fs.readFileSync(file)));
  }
  for (const file of build.outputFiles) {
    assert(file.path.startsWith(output + path.sep));
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.contents, { flag: "wx" });
  }
  const finalMetadata = { ...metadata, exports: compiledExports(metadata.exports, mapping) };
  for (const key of ["main", "module"])
    if (mapping[metadata[key]]) finalMetadata[key] = mapping[metadata[key]];
  delete finalMetadata.types;
  fs.writeFileSync(
    path.join(output, "package.json"),
    JSON.stringify(finalMetadata, null, 2) + "\n",
    { flag: "wx" },
  );
  return {
    name: metadata.name,
    version: metadata.version,
    sourcePackageSha256: digest(metadataBytes),
    sourceInventorySha256: digest(
      JSON.stringify(
        sourceHashes.map(([file, hash]) => [
          path.relative(source, file).replaceAll(path.sep, "/"),
          hash,
        ]),
      ),
    ),
    entrypoints: inputs.length,
    outputFiles: build.outputFiles.length,
    files: ordinaryFiles(output).map((file) => ({
      path: path.relative(output, file).replaceAll(path.sep, "/"),
      sha256: digest(fs.readFileSync(file)),
    })),
  };
}

async function main() {
  const [sourceArgument, outputArgument, toolsArgument] = process.argv.slice(2);
  assert(sourceArgument && outputArgument && toolsArgument);
  const source = path.resolve(sourceArgument),
    output = path.resolve(outputArgument);
  assert(!fs.existsSync(output));
  const compiler = createRequire(import.meta.url)(
    path.join(path.resolve(toolsArgument), "node_modules/esbuild"),
  );
  const packages = [];
  for (const [name, tree] of Object.entries(SDK_ROOTS)) {
    const receipt = await compileSdk(
      path.join(source, name),
      path.join(output, name),
      tree,
      compiler,
    );
    assert.equal(receipt.name, name);
    packages.push(receipt);
  }
  fs.writeFileSync(
    path.join(output, "build.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        classification: "pi-compiled-sdk-paths",
        compilerVersion: compiler.version,
        packages,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
