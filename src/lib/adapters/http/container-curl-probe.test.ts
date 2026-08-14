// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CONTAINER_REACHABILITY_IMAGE,
  createContainerCurlProbeSpawn,
} from "./container-curl-probe";

function successfulSpawn(stdout = "200"): SpawnSyncReturns<string> {
  return {
    pid: 123,
    output: [stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
  };
}

describe("container curl probe", () => {
  it("writes the response body and returns the HTTP status without a WSL bind mount (#9116)", () => {
    const responseBody = '{"choices":[{"message":{"tool_calls":[{}]}}]}';
    const spawn = vi.fn(
      (_command: string, args: readonly string[], _options: SpawnSyncOptionsWithStringEncoding) => {
        const writeOutIndex = args.indexOf("-w");
        const writeOut = args[writeOutIndex + 1];
        return successfulSpawn(`${responseBody}${writeOut.replace("%{http_code}", "200")}`);
      },
    );
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-probe-test-"));
    const outputPath = path.join(tempDir, "response.json");
    fs.writeFileSync(outputPath, "");
    const args = ["-sS", "-o", outputPath, "-w", "%{http_code}", "http://example.test/v1"];

    try {
      const result = createContainerCurlProbeSpawn(spawn)("curl", args, { encoding: "utf8" });

      expect(result.stdout).toBe("200");
      expect(fs.readFileSync(outputPath, "utf8")).toBe(responseBody);
      const containerArgs = spawn.mock.calls[0][1];
      expect(containerArgs).toEqual(
        expect.arrayContaining([
          "run",
          "--rm",
          CONTAINER_REACHABILITY_IMAGE,
          "http://example.test/v1",
        ]),
      );
      expect(containerArgs).not.toContain("--volume");
      expect(containerArgs).not.toContain(outputPath);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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

  it("rejects container curl output without the HTTP status marker (#9116)", () => {
    const spawn = vi.fn(() => successfulSpawn("{}"));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-probe-test-"));
    const outputPath = path.join(tempDir, "response.json");
    fs.writeFileSync(outputPath, "");

    try {
      expect(() =>
        createContainerCurlProbeSpawn(spawn)(
          "curl",
          ["-sS", "-o", outputPath, "-w", "%{http_code}", "http://example.test/v1"],
          { encoding: "utf8" },
        ),
      ).toThrow(/did not return the HTTP status write-out/);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
