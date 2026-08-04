// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CONTAINER_REACHABILITY_IMAGE,
  createContainerCurlProbeSpawn,
} from "./container-curl-probe";

function successfulSpawn(): SpawnSyncReturns<string> {
  return {
    pid: 123,
    output: ["200", ""],
    stdout: "200",
    stderr: "",
    status: 0,
    signal: null,
  };
}

describe("container curl probe", () => {
  it("mounts only the temporary output directory and preserves curl arguments", () => {
    const spawn = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnSyncOptionsWithStringEncoding) =>
        successfulSpawn(),
    );
    const outputPath = path.join(os.tmpdir(), "nemoclaw-curl-probe-test", "response.json");
    const args = ["-sS", "-o", outputPath, "-w", "%{http_code}", "http://example.test/v1"];

    createContainerCurlProbeSpawn(spawn)("curl", args, { encoding: "utf8" });

    expect(spawn).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining([
        "run",
        "--rm",
        "--volume",
        `${path.dirname(outputPath)}:${path.dirname(outputPath)}`,
        CONTAINER_REACHABILITY_IMAGE,
        ...args,
      ]),
      { encoding: "utf8" },
    );
  });

  it("rejects credential configs and output paths outside the temporary directory", () => {
    const spawn = vi.fn(() => successfulSpawn());
    const run = createContainerCurlProbeSpawn(spawn);
    const outputPath = path.join(os.tmpdir(), "nemoclaw-curl-probe-test", "response.json");

    expect(() =>
      run("curl", ["--config", path.join(os.tmpdir(), "auth.conf"), "-o", outputPath], {
        encoding: "utf8",
      }),
    ).toThrow(/does not accept credential config files/);
    expect(() =>
      run("curl", ["-o", path.join(process.cwd(), "response.json")], { encoding: "utf8" }),
    ).toThrow(/must stay inside the temporary directory/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
