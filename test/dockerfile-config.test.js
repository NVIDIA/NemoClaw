// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dockerfilePath = path.join(import.meta.dirname, "..", "Dockerfile");
const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");

describe("sandbox Dockerfile config layout", () => {
  it("stores openclaw.json in writable sandbox state", () => {
    expect(dockerfile).toMatch(
      /ln -s \/sandbox\/\.openclaw-data\/openclaw\.json \/sandbox\/\.openclaw\/openclaw\.json/,
    );
    expect(dockerfile).not.toMatch(/chmod 444 \/sandbox\/\.openclaw\/openclaw\.json/);
  });
});
