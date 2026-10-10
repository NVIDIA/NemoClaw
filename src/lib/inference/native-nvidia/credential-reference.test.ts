// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { resolveNativeNvidiaCredentialReference } from "./credential-reference";

const scope = { sandboxName: "alpha", gatewayName: "nemoclaw" };

it("does not expose NVIDIA credential material in transport errors (#12636)", async () => {
  const capture = vi.fn(async () => {
    throw new Error("raw-credential diagnostic");
  });
  await expect(resolveNativeNvidiaCredentialReference(scope, capture)).rejects.toThrow(
    "Native NVIDIA credential reference could not be read.",
  );
});

it.each(["v12", `s${"a".repeat(64)}`])(
  "reads an issued NVIDIA handle through the selected gateway (%s) (#12636)",
  async (identity) => {
    const reference = `openshell:resolve:env:${identity}_NVIDIA_INFERENCE_API_KEY`;
    const capture = vi.fn(async () => ({
      status: 0,
      stdout: reference,
      stderr: "diagnostic",
      output: "not the reference",
    }));
    expect(await resolveNativeNvidiaCredentialReference(scope, capture)).toBe(reference);
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
        "printf '%s' \"${NVIDIA_INFERENCE_API_KEY}\"",
      ],
      { ignoreError: true, includeStreams: true, timeout: 15000 },
    );
  },
);

it.each([
  [0, "raw-secret"],
  [0, "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY"],
  [0, "openshell:resolve:env:v1_COMPATIBLE_API_KEY"],
  [0, "openshell:resolve:env:v1_NVIDIA_INFERENCE_API_KEY\nextra"],
  [1, "openshell:resolve:env:v1_NVIDIA_INFERENCE_API_KEY"],
])(
  "rejects unissued or unsuccessful NVIDIA credential output (%s, %s) (#12636)",
  async (status, stdout) => {
    const capture = vi.fn(async () => ({ status, stdout, stderr: "", output: stdout }));
    await expect(resolveNativeNvidiaCredentialReference(scope, capture)).rejects.toThrow(
      "Native NVIDIA inference has no matching supervisor-issued credential reference.",
    );
  },
);

it("rejects invalid NVIDIA sandbox scope before execution (#12636)", async () => {
  const capture = vi.fn();
  await expect(
    resolveNativeNvidiaCredentialReference({ ...scope, gatewayName: "bad;scope" }, capture),
  ).rejects.toThrow("Invalid native NVIDIA credential scope.");
  expect(capture).not.toHaveBeenCalled();
});
