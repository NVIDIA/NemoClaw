// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "oxfmt";

const require = createRequire(import.meta.url);
const { NemoClawConfigSchema } =
  require("../../src/lib/config/model.ts") as typeof import("../../src/lib/config/model.ts");
const schemaPath = "schemas/nemoclaw-config-v1.schema.json";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outputPath = path.join(repositoryRoot, schemaPath);
const args = process.argv.slice(2);

if (args.some((arg) => arg !== "--check")) {
  throw new Error("Expected no arguments or --check.");
}

const formatted = await format(schemaPath, `${JSON.stringify(NemoClawConfigSchema, null, 2)}\n`, {
  endOfLine: "lf",
  objectWrap: "preserve",
  printWidth: 100,
  tabWidth: 2,
});
if (formatted.errors.length > 0) {
  throw new Error("Could not format the generated NemoClawConfig schema.");
}

if (args.includes("--check")) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (current !== formatted.code) {
    console.error(`${schemaPath} is missing or stale. Run npm run config-schema:generate.`);
    process.exitCode = 1;
  } else {
    console.log("Generated NemoClawConfig schema is current.");
  }
} else {
  writeFileSync(outputPath, formatted.code);
  console.log(`Generated ${schemaPath}.`);
}
