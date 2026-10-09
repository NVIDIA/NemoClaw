// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { captureOpenshellCommandAsync } from "../../adapters/openshell/command-execution";
import { resolveNativeCustomCredentialReference } from "./credential-reference";

const scope = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  credentialEnv: "COMPATIBLE_API_KEY",
};

it("reads only the selected sandbox issued credential reference through its named gateway (#12636)", async () => {
  const capture = vi.fn<NonNullable<Parameters<typeof resolveNativeCustomCredentialReference>[1]>>(
    (_args, options) =>
      captureOpenshellCommandAsync(
        process.execPath,
        [
          "-e",
          "process.stdout.write('openshell:resolve:env:v12_COMPATIBLE_API_KEY'); process.stderr.write('diagnostic-only');",
        ],
        options,
      ),
  );
  expect(await resolveNativeCustomCredentialReference(scope, capture)).toBe(
    "openshell:resolve:env:v12_COMPATIBLE_API_KEY",
  );
  expect(capture).toHaveBeenCalledWith(
    [
      "sandbox",
      "exec",
      "-g",
      "nemoclaw",
      "--name",
      "alpha",
      "--",
      "sh",
      "-lc",
      "printf '%s' \"${COMPATIBLE_API_KEY}\"",
    ],
    { ignoreError: true, includeStreams: true, timeout: 15000 },
  );
});

it.each([
  "raw-secret",
  "openshell:resolve:env:v1_NVIDIA_API_KEY",
  "openshell:resolve:env:COMPATIBLE_API_KEY",
])(
  "rejects credential output outside the issued selected-key boundary (%s) (#12636)",
  async (value) => {
    const capture = vi.fn(async () => ({ status: 0, stdout: value, output: value, stderr: value }));
    await expect(resolveNativeCustomCredentialReference(scope, capture)).rejects.toThrow(
      "no matching supervisor-issued credential reference",
    );
    try {
      await resolveNativeCustomCredentialReference(scope, capture);
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  },
);

it("rejects an invalid credential scope before sandbox execution (#12636)", async () => {
  const capture = vi.fn();
  await expect(
    resolveNativeCustomCredentialReference(
      { ...scope, credentialEnv: "KEY; echo secret" },
      capture,
    ),
  ).rejects.toThrow("Invalid native custom credential scope");
  expect(capture).not.toHaveBeenCalled();
});
