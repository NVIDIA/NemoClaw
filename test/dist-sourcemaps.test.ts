// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findMissingDistSourcemapSources } from "../scripts/check-dist-sourcemaps";

describe("dist sourcemap checks", () => {
  it("reports JavaScript sourcemaps pointing at missing source files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sourcemap-check-"));
    const distLib = path.join(root, "dist", "lib");
    const srcLib = path.join(root, "src", "lib");
    fs.mkdirSync(distLib, { recursive: true });
    fs.mkdirSync(srcLib, { recursive: true });
    fs.writeFileSync(path.join(srcLib, "present.ts"), "export {};\n");
    fs.writeFileSync(
      path.join(distLib, "present.js.map"),
      JSON.stringify({ version: 3, sources: ["../../src/lib/present.ts"], mappings: "" }),
    );
    fs.writeFileSync(
      path.join(distLib, "missing.js.map"),
      JSON.stringify({ version: 3, sources: ["../../src/lib/missing.ts"], mappings: "" }),
    );

    expect(findMissingDistSourcemapSources(path.join(root, "dist"))).toEqual([
      `${path.join(distLib, "missing.js.map")} -> ../../src/lib/missing.ts`,
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
