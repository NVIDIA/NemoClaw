// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  acceptTrustedPluginFixturePrebuild,
  registerTrustedPluginFixtureImageCleanup,
  trustedExdevImageRef,
  withEnabledLocalBaseImageBuild,
} from "../live/openclaw-plugin-runtime-exdev-trusted-prebuild.ts";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

afterEach(() => vi.unstubAllEnvs());

it("limits the local base-image build setting to one operation", () => {
  vi.stubEnv("NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD", "0");

  expect(
    withEnabledLocalBaseImageBuild(() => process.env.NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD),
  ).toBe("1");
  expect(process.env.NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD).toBe("0");
  expect(() =>
    withEnabledLocalBaseImageBuild(() => {
      throw new Error("base-image build failed");
    }),
  ).toThrow("base-image build failed");
  expect(process.env.NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD).toBe("0");
});

function commandResult(exitCode = 0, stderr = ""): ShellProbeResult {
  return {
    artifacts: { result: "result.json", stderr: "stderr.txt", stdout: "stdout.txt" },
    command: ["docker", "image", "rm"],
    exitCode,
    signal: null,
    stderr,
    stdout: "",
    timedOut: false,
  };
}

describe("trusted EXDEV fixture image cleanup", () => {
  it("reclaims an image whose immutable identity assertion fails in LIFO order", async () => {
    const calls: string[] = [];
    const cleanup = new CleanupRegistry();
    const host = {
      command: vi.fn(async (_command: string, args: string[]) => {
        calls.push(`image:${args.at(-1)}`);
        return commandResult();
      }),
    };
    const images = registerTrustedPluginFixtureImageCleanup({
      cleanup,
      environment: { PATH: "/usr/bin" },
      host,
    });
    cleanup.add("delete fixture sandbox", () => {
      calls.push("sandbox");
    });

    const imageV1 = trustedExdevImageRef("cleanup-v1");
    const imageV2 = trustedExdevImageRef("cleanup-v2");
    expect(
      acceptTrustedPluginFixturePrebuild({
        images,
        prebuild: {
          createArgs: ["--from", imageV1, "--name", "fixture-sandbox"],
          imageId: IMAGE_ID,
          imageRef: imageV1,
        },
        sandboxName: "fixture-sandbox",
        version: "v1",
      }),
    ).toEqual({ imageId: IMAGE_ID, imageRef: imageV1 });
    expect(() =>
      acceptTrustedPluginFixturePrebuild({
        images,
        prebuild: {
          createArgs: ["--from", imageV2, "--name", "fixture-sandbox"],
          imageId: null,
          imageRef: imageV2,
        },
        sandboxName: "fixture-sandbox",
        version: "v2",
      }),
    ).toThrow("trusted EXDEV fixture prebuild must retain its immutable local image identity");

    expect(await cleanup.runAll()).toEqual({
      failures: [],
      passed: ["delete fixture sandbox", "remove trusted EXDEV fixture images"],
    });
    expect(calls).toEqual(["sandbox", `image:${imageV2}`, `image:${imageV1}`]);
    expect(host.command).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["image", "rm", "--force", imageV2],
      expect.objectContaining({ artifactName: "cleanup-trusted-exdev-image-v2" }),
    );
  });

  it("continues reclaiming images after a removal fails and reports the failure", async () => {
    const cleanup = new CleanupRegistry();
    let removal = 0;
    const host = {
      command: vi.fn(async () => {
        removal += 1;
        return removal === 1 ? commandResult(1, "removal denied") : commandResult();
      }),
    };
    const images = registerTrustedPluginFixtureImageCleanup({
      cleanup,
      environment: { PATH: "/usr/bin" },
      host,
    });
    const imageV1 = trustedExdevImageRef("cleanup-failure-v1");
    const imageV2 = trustedExdevImageRef("cleanup-failure-v2");
    images.track(imageV1, "v1");
    images.track(imageV2, "v2");

    const result = await cleanup.runAll();

    expect(result.passed).toEqual([]);
    expect(result.failures).toEqual([
      {
        message: expect.stringContaining(`${imageV2}: removal denied`),
        name: "remove trusted EXDEV fixture images",
      },
    ]);
    expect(host.command).toHaveBeenNthCalledWith(
      1,
      "docker",
      ["image", "rm", "--force", imageV2],
      expect.objectContaining({ artifactName: "cleanup-trusted-exdev-image-v2" }),
    );
    expect(host.command).toHaveBeenNthCalledWith(
      2,
      "docker",
      ["image", "rm", "--force", imageV1],
      expect.objectContaining({ artifactName: "cleanup-trusted-exdev-image-v1" }),
    );
  });
});
