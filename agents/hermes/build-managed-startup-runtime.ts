// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "../..");
const sharedRuntime = path.join(root, "src/lib/onboard/managed-startup/image-runtime.ts");
const artifact = path.join(import.meta.dirname, "managed-startup-image-runtime.bundle");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check"))
  throw new Error("Unexpected Hermes runtime build argument");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["tools/mcp-tool-discovery-runtime/managed-startup-direct-entry.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  legalComments: "eof",
  minifyWhitespace: true,
  write: false,
  plugins: [
    {
      name: "hermes-generated-source-cleanup",
      setup(builder) {
        builder.onResolve({ filter: /^node:fs$/ }, (input) =>
          input.importer === sharedRuntime
            ? { path: path.join(import.meta.dirname, "managed-startup-filesystem.ts") }
            : undefined,
        );
      },
    },
  ],
});
const bytes = result.outputFiles[0]!.text.replace(/[ \t]+$/gmu, "");
if (args.includes("--check")) {
  if (fs.readFileSync(artifact, "utf8") !== bytes)
    throw new Error("Hermes managed-startup artifact is stale");
} else {
  fs.writeFileSync(artifact, bytes);
}
