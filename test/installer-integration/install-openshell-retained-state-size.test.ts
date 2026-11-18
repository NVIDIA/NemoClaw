// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommandWithInstalledVersion } from "../support/openshell-installed-version";

describe("OpenShell installer retained state size", { timeout: 15_000 }, () => {
  it.each([
    { record: "registry", staleSize: false },
    { record: "metadata", staleSize: false },
    { record: "registry", staleSize: true },
    { record: "metadata", staleSize: true },
  ])(
    "preserves oversized retained $record when the size snapshot is stale=$staleSize",
    ({ record, staleSize }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-state-size-"));
      try {
        const preload = path.join(root, "stale-size.cjs");
        fs.writeFileSync(
          preload,
          `
const fs = require("node:fs");
const original = fs.fstatSync;
fs.fstatSync = (...args) => {
  const stat = original(...args);
  if (stat.size > 16 * 1024 * 1024) stat.size = 0;
  return stat;
};
require("node:module").syncBuiltinESMExports();
`,
        );
        const oversized = " ".repeat(16 * 1024 * 1024 + 1);
        const result = runCommandWithInstalledVersion(
          "0.0.116",
          staleSize ? { NODE_OPTIONS: `--require=${preload}` } : {},
          {
            driverBins: false,
            ...(record === "registry"
              ? { retainedRegistry: oversized }
              : { legacyGateway: "empty", legacyMetadata: oversized }),
          },
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("exceeds the 16777216 byte limit");
        expect(result.downloads).toBe("");
        expect(result.retainedFilesUnchanged).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
