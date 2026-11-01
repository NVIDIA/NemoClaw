// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { collectOnboardFailureRuntimeDiagnostics } from "../live/managed-image-activation-e2e-helpers.ts";

function replaceAfterValidation(copiedLog: string, foreignLog: string): void {
  fs.writeFileSync(copiedLog, "original startup log\n");
  const replace = vi.fn(() => {
    fs.unlinkSync(copiedLog);
    fs.symlinkSync(foreignLog, copiedLog);
  });
  const lstat = fs.lstatSync.bind(fs);
  const fstat = fs.fstatSync.bind(fs);
  // Exercise the former path-based reader as well as the descriptor-based reader.
  vi.spyOn(fs, "lstatSync").mockImplementationOnce((...args) => {
    const result = lstat(...args);
    replace();
    return result;
  });
  vi.spyOn(fs, "fstatSync").mockImplementationOnce((...args) => {
    const result = fstat(...args);
    replace();
    return result;
  });
}

const unsafeCopies: {
  name: string;
  prepare: (copiedLog: string, foreignLog: string) => void;
}[] = [
  { name: "symlink", prepare: (copy, foreign) => fs.symlinkSync(foreign, copy) },
  { name: "hardlink", prepare: (copy, foreign) => fs.linkSync(foreign, copy) },
  {
    name: "directory",
    prepare: (copy) => {
      fs.mkdirSync(copy);
    },
  },
  {
    name: "oversized",
    prepare: (copy) => fs.writeFileSync(copy, Buffer.alloc(2 * 1024 * 1024 + 1)),
  },
  { name: "empty", prepare: (copy) => fs.writeFileSync(copy, "") },
  { name: "replaced", prepare: replaceAfterValidation },
];

describe("copied managed startup log safety", () => {
  it.each(unsafeCopies)(
    "rejects $name input without losing diagnostics or leaking temporary files",
    async ({ prepare }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-startup-diagnostics-"));
      const artifacts = new ArtifactSink(directory);
      const foreignLog = path.join(directory, "foreign.log");
      fs.writeFileSync(foreignLog, "unrelated host data\n");
      let copiedLog = "";
      const command = vi.fn(async (_executable: string, args: readonly string[]) => {
        switch (args[0]) {
          case "ps":
            return {
              exitCode: 0,
              stdout: `${"a".repeat(64)}\tmanaged-container\timage\tExited\n`,
              stderr: "",
            };
          case "cp":
            copiedLog = String(args[2]);
            prepare(copiedLog, foreignLog);
            break;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      try {
        await expect(
          collectOnboardFailureRuntimeDiagnostics(
            artifacts,
            { command } as never,
            "hermes",
            "managed-hermes",
            {},
          ),
        ).resolves.toBeUndefined();
        expect(copiedLog).not.toBe("");
        expect(
          fs.existsSync(
            artifacts.pathFor(
              "managed-activation-onboard-failure-hermes-container-1-nemoclaw-start.log",
            ),
          ),
        ).toBe(false);
        expect(
          fs.existsSync(
            artifacts.pathFor(
              "managed-activation-onboard-failure-hermes-container-1-startup-signals.json",
            ),
          ),
        ).toBe(true);
        expect(fs.existsSync(path.dirname(copiedLog))).toBe(false);
        expect(fs.readFileSync(foreignLog, "utf8")).toBe("unrelated host data\n");
      } finally {
        vi.restoreAllMocks();
        fs.rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
