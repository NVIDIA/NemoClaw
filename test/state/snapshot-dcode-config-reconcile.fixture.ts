// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { writeExecutable, writeFakeOpenshell, writeFakeSsh } from "../support/native-snapshot";

export function prepareDcodeConfigRestoreFixture(fixture: string, layout: string) {
  const binDir = path.join(fixture, "bin");
  const nativeRoot = path.join(fixture, "native-home");
  const config = path.join(nativeRoot, ".deepagents/config.toml");
  const memory = path.join(nativeRoot, ".deepagents/agent/AGENTS.md");
  const external = path.join(fixture, "external-state");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "config.toml"), "external selection");
  fs.mkdirSync(path.dirname(memory), { recursive: true });
  fs.writeFileSync(config, "archived selection");
  fs.writeFileSync(memory, "archived memory");
  if (layout !== "directory" && layout !== "replacement symlink") {
    fs.rmSync(path.join(nativeRoot, ".deepagents"), { recursive: true });
    if (layout === "archive symlink") {
      fs.symlinkSync(external, path.join(nativeRoot, ".deepagents"));
    }
  }
  writeFakeOpenshell(binDir);
  writeFakeSsh(binDir);
  writeExecutable(
    path.join(binDir, "stat"),
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] !== "-c" || process.argv[3] !== "%u") process.exit(95);
process.stdout.write(String(fs.lstatSync(process.argv.at(-1)).uid) + "\\n");
`,
  );
  return {
    binDir,
    nativeRoot,
    config,
    memory,
    external,
    createReplacement() {
      fs.rmSync(path.join(nativeRoot, ".deepagents"), { recursive: true, force: true });
      if (layout === "replacement symlink") {
        fs.symlinkSync(external, path.join(nativeRoot, ".deepagents"));
      } else {
        fs.mkdirSync(path.dirname(config), { recursive: true });
      }
      fs.writeFileSync(config, "replacement selection");
    },
  };
}
