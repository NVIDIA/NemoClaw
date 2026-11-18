// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { collectOnboardFailureRuntimeDiagnostics } from "../live/managed-image-activation-e2e-helpers.ts";

it.each([
  { state: "unchanged", beforeRead: (_filename: string) => {} },
  {
    state: "replaced",
    beforeRead: (filename: string) => {
      fs.renameSync(filename, `${filename}.original`);
      fs.writeFileSync(filename, "replacement must not be published\n");
    },
  },
])("redacts a copied failed-startup log when its pathname is $state", async ({ beforeRead }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-startup-diagnostics-"));
  const secret = "supplied-startup-diagnostic-secret";
  const containerId = "a".repeat(64);
  const artifacts = new ArtifactSink(directory);
  const originalRead = fs.readFileSync;
  const readSpy = vi.spyOn(fs, "readFileSync");
  const command = vi.fn(async (executable: string, args: readonly string[]) => {
    switch (`${executable}:${String(args[0])}`) {
      case "docker:ps":
        return {
          exitCode: 0,
          stdout: `${containerId}\tmanaged-container\timage\tExited\n`,
          stderr: "",
        };
      case "docker:cp":
        fs.writeFileSync(String(args[2]), `startup log contains ${secret}\n`);
        readSpy.mockImplementationOnce((source) => {
          beforeRead(String(args[2]));
          return originalRead(source, "utf8");
        });
        break;
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });

  try {
    await collectOnboardFailureRuntimeDiagnostics(
      artifacts,
      { command } as never,
      "openclaw",
      "managed-openclaw",
      {},
      [secret],
    );

    const published = fs.readFileSync(
      artifacts.pathFor(
        "managed-activation-onboard-failure-openclaw-container-1-nemoclaw-start.log",
      ),
      "utf8",
    );
    expect(published).toContain("[REDACTED]");
    expect(published).not.toContain(secret);
    expect(published).not.toContain("replacement must not be published");
  } finally {
    readSpy.mockRestore();
    fs.rmSync(directory, { force: true, recursive: true });
  }
});
