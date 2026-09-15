// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const source = path.join(repositoryRoot, "nemoclaw", "runner-dist");
const destination = path.join(repositoryRoot, "dist", "nemoclaw");
const runner = path.join(source, "blueprint", "runner.js");

if (!existsSync(runner) || !lstatSync(runner).isFile() || lstatSync(runner).isSymbolicLink()) {
  throw new Error("The compiled blueprint runner is missing from its focused build.");
}

rmSync(destination, { force: true, recursive: true });
mkdirSync(path.dirname(destination), { recursive: true });
cpSync(source, destination, { dereference: true, recursive: true });
writeFileSync(path.join(destination, "package.json"), '{"type":"module"}\n');
