// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultGatewayReleaseCommandExists } from "./gateway-port-listeners";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("defaultGatewayReleaseCommandExists", () => {
  it("finds an executable directly on the configured PATH", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-command-path-"));
    tempDirs.push(directory);
    const executable = path.join(directory, "lsof");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(defaultGatewayReleaseCommandExists("lsof", { PATH: directory })).toBe(true);
  });

  it("does not invoke a shell or trust an empty PATH entry", () => {
    expect(defaultGatewayReleaseCommandExists("lsof; exit 0", { PATH: "" })).toBe(false);
  });
});
