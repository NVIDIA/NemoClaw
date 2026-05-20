// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { Config as OclifConfig } from "@oclif/core";

const OUTPUT_FILE = "oclif-command-metadata.generated.json";

type SerializableCommandMetadata = Record<string, unknown>;

function packageRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function setIfDefined(
  target: SerializableCommandMetadata,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) target[key] = toPlainJson(value);
}

async function main(): Promise<void> {
  process.env.OCLIF_METADATA_MANIFEST_GENERATION = "1";

  const root = packageRoot();
  const config = await OclifConfig.load(root);
  const metadata: Record<string, SerializableCommandMetadata> = {};

  for (const command of [...config.commands].sort((a, b) => a.id.localeCompare(b.id))) {
    const entry: SerializableCommandMetadata = {};
    setIfDefined(entry, "args", command.args);
    setIfDefined(entry, "description", command.description);
    setIfDefined(entry, "deprecationOptions", command.deprecationOptions);
    setIfDefined(entry, "examples", command.examples);
    setIfDefined(entry, "flags", command.flags);
    setIfDefined(entry, "hidden", command.hidden);
    setIfDefined(entry, "id", command.id);
    setIfDefined(entry, "publicDisplay", (command as { publicDisplay?: unknown }).publicDisplay);
    setIfDefined(entry, "state", command.state);
    setIfDefined(entry, "strict", command.strict);
    setIfDefined(entry, "summary", command.summary);
    setIfDefined(entry, "usage", command.usage);
    metadata[command.id] = entry;
  }

  const outputPath = path.join(root, "dist", "lib", "cli", OUTPUT_FILE);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
