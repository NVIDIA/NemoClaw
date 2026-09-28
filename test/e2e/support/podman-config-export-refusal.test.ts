// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { completeBraveConfigExport } from "../live/brave-search-helpers.ts";
import { isPodmanConfigExportRefusal } from "../fixtures/phases/config-export-validation.ts";

const diagnostic = JSON.stringify({
  error: {
    message:
      "Config export failed (unsupported).\nV1alpha1 export currently supports the Docker runtime; Podman compatibility is deferred.",
  },
});
const refusal = { exitCode: 2, signal: null, timedOut: false, stdout: "", stderr: diagnostic };

it.each([
  { name: "stderr refusal", result: {}, outputExists: false, accepted: true },
  {
    name: "stdout refusal",
    result: { stdout: diagnostic, stderr: "" },
    outputExists: false,
    accepted: true,
  },
  { name: "published output", result: {}, outputExists: true, accepted: false },
  {
    name: "malformed diagnostic",
    result: { stderr: "synthetic-secret" },
    outputExists: false,
    accepted: false,
  },
  { name: "timeout", result: { timedOut: true }, outputExists: false, accepted: false },
  { name: "signal", result: { signal: "SIGTERM" as const }, outputExists: false, accepted: false },
  { name: "successful export", result: { exitCode: 0 }, outputExists: false, accepted: false },
  {
    name: "another unsupported feature",
    result: {
      stderr: JSON.stringify({
        error: { message: "Config export failed (unsupported).\nOther unsupported feature." },
      }),
    },
    outputExists: false,
    accepted: false,
  },
])("classifies $name as Podman export refusal evidence", ({ result, outputExists, accepted }) => {
  expect(isPodmanConfigExportRefusal({ ...refusal, ...result }, outputExists)).toBe(accepted);
});

it.each(["docker", "podman"] as const)(
  "selects the supported Brave export checks for %s",
  async (runtime) => {
    const verifyDockerExport = vi.fn();
    const writeJson = vi.fn();
    await completeBraveConfigExport(
      runtime,
      { writeJson } as unknown as ArtifactSink,
      verifyDockerExport,
    );
    expect(verifyDockerExport).toHaveBeenCalledTimes(runtime === "docker" ? 1 : 0);
    expect(writeJson.mock.calls).toEqual(
      runtime === "docker"
        ? []
        : [
            [
              "brave-config-export-evidence.json",
              {
                sandboxName: process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-brave-search",
                runtimeProvider: "podman",
                classification: "expected-refusal",
                refusalCategory: "unsupported",
                outputPublished: false,
              },
            ],
          ],
    );
  },
);
