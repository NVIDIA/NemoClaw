// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  managedImageDirectNativeStartupCommand,
  parseManagedImageDirectE2eInputs,
} from "../../../scripts/checks/run-managed-image-direct-e2e";
import { MANAGED_STARTUP_EXECUTABLE } from "../../../src/lib/onboard/managed-startup/hold";

const IMMUTABLE_IMAGE_ID = `sha256:${"a".repeat(64)}`;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed-image direct E2E inputs", () => {
  it("runs the native marker through the image-declared entrypoint", () => {
    expect(managedImageDirectNativeStartupCommand()).toEqual([
      MANAGED_STARTUP_EXECUTABLE,
      "/bin/sh",
      "-c",
      expect.stringContaining("nemoclaw-native-startup-uid"),
    ]);
  });

  it.each(["linux/amd64", "linux/arm64"] as const)(
    "accepts the native publication platform %s (#7744)",
    (platform) => {
      expect(
        parseManagedImageDirectE2eInputs([
          "--agent",
          "openclaw",
          "--image",
          IMMUTABLE_IMAGE_ID,
          "--platform",
          platform,
        ]),
      ).toEqual({ agent: "openclaw", image: IMMUTABLE_IMAGE_ID, platform });
    },
  );

  it("rejects platforms outside the native publication matrix", () => {
    expect(() =>
      parseManagedImageDirectE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        IMMUTABLE_IMAGE_ID,
        "--platform",
        "linux/s390x",
      ]),
    ).toThrow("--platform must be linux/amd64 or linux/arm64");
  });

  it("loads without the compiled CLI boundary used by the full bootstrap adapter", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-direct-e2e-import-"));
    temporaryDirectories.push(directory);
    const hook = path.join(directory, "reject-full-adapter.cjs");
    fs.writeFileSync(
      hook,
      String.raw`
const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  const value = String(request);
  if (
    value.includes("managed-bootstrap/adapter") ||
    value.includes("nemoclaw/dist/shared/sandbox-name.cjs")
  ) {
    throw new Error("forbidden protected-runtime dependency: " + value);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        hook,
        path.resolve(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs"),
        path.resolve(
          import.meta.dirname,
          "../../../scripts/checks/run-managed-image-direct-e2e.ts",
        ),
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--agent is required");
    expect(result.stderr).not.toContain("forbidden protected-runtime dependency");
  });
});
