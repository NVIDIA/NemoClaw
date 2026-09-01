// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bindE2eCorrelationIdentity } from "../../../tools/e2e/bind-correlation-identity.mts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("E2E correlation identity", () => {
  it("exports one generated lowercase UUIDv4 through the GitHub environment file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-correlation-"));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, "github-env");
    const correlationId = "01234567-89ab-4def-8abc-0123456789ab";

    expect(bindE2eCorrelationIdentity(outputPath, () => correlationId)).toBe(correlationId);
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      `NEMOCLAW_E2E_CORRELATION_ID=${correlationId}\n`,
    );
  });

  it.each(["not-a-uuid", "01234567-89ab-3def-8abc-0123456789ab"])(
    "rejects invalid generated identity %s",
    (correlationId) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-correlation-"));
      temporaryDirectories.push(directory);
      const outputPath = path.join(directory, "github-env");

      expect(() => bindE2eCorrelationIdentity(outputPath, () => correlationId)).toThrow(
        "must be a lowercase UUIDv4",
      );
      expect(fs.existsSync(outputPath)).toBe(false);
    },
  );
});
