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

    try {
      expect(() =>
        createContainerCurlProbeSpawn(spawn)(
          "curl",
          ["-sS", "-o", outputPath, "-w", "%{http_code}", "http://example.test/v1"],
          { encoding: "utf8" },
        ),
      ).toThrow(/did not return the HTTP status write-out/);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each(["20x", "200 extra"])(
    "rejects a malformed HTTP status write-out without creating the response file: %s (#9116)",
    (httpStatus) => {
      const spawn = vi.fn(
        (_command: string, args: readonly string[]) => {
          const writeOutIndex = args.indexOf("-w");
          const writeOut = args[writeOutIndex + 1];
          return successfulSpawn(`{}${writeOut.replace("%{http_code}", httpStatus)}`);
        },
      );
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-probe-test-"));
      const outputPath = path.join(tempDir, "response.json");

      try {
        expect(() =>
          createContainerCurlProbeSpawn(spawn)(
            "curl",
            ["-sS", "-o", outputPath, "-w", "%{http_code}", "http://example.test/v1"],
            { encoding: "utf8" },
          ),
        ).toThrow(/invalid HTTP status write-out/);
        expect(fs.existsSync(outputPath)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("returns an unchanged nonzero Docker probe result without creating the response file (#9116)", () => {
    const dockerFailure = successfulSpawn("partial response");
    dockerFailure.status = 7;
    const expectedFailure = { ...dockerFailure, output: [...dockerFailure.output] };
    const spawn = vi.fn(() => dockerFailure);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-probe-test-"));
    const outputPath = path.join(tempDir, "response.json");

    try {
      const result = createContainerCurlProbeSpawn(spawn)(
        "curl",
        ["-sS", "-o", outputPath, "-w", "%{http_code}", "http://example.test/v1"],
        { encoding: "utf8" },
      );

      expect(result).toBe(dockerFailure);
      expect(result).toEqual(expectedFailure);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not follow a replacement output symlink (#9116)", () => {
    const spawn = vi.fn(
      (_command: string, args: readonly string[]) => {
        const writeOutIndex = args.indexOf("-w");
        const writeOut = args[writeOutIndex + 1];
        return successfulSpawn(`replacement${writeOut.replace("%{http_code}", "200")}`);
      },
    );
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-curl-probe-test-"));
    const targetPath = path.join(tempDir, "target.json");
    const outputPath = path.join(tempDir, "response.json");
    fs.writeFileSync(targetPath, "original");
    fs.symlinkSync(targetPath, outputPath);

    try {
      expect(() =>
        createContainerCurlProbeSpawn(spawn)(
          "curl",
          ["-sS", "-o", outputPath, "-w", "%{http_code}", "http://example.test/v1"],
          { encoding: "utf8" },
        ),
      ).toThrow();
      expect(fs.readFileSync(targetPath, "utf8")).toBe("original");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
