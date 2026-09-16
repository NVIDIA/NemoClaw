// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { type CoordinatorSnapshot, decideReviewAction } from "./decision.mts";

const inputPath = readInputPath(process.argv.slice(2));
const snapshot = JSON.parse(fs.readFileSync(inputPath, "utf8")) as CoordinatorSnapshot;
const decision = decideReviewAction(snapshot);
process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);

function readInputPath(args: readonly string[]): string {
  const inputIndex = args.indexOf("--input");
  const candidate = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
  if (!candidate || args.length !== 2) {
    throw new Error("Usage: npm run review:coordinate:local -- --input <snapshot.json>");
  }
  return path.resolve(candidate);
}
