// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  ensureOpenClawGeminiRuntimeImage,
  OPENCLAW_GEMINI_IMAGE_INSPECT_TIMEOUT_MS,
  OPENCLAW_GEMINI_IMAGE_PULL_TIMEOUT_MS,
  type DockerImageSetupRunner,
} from "./helpers/openclaw-gemini-runtime-image";

const PINNED_IMAGE = `ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:${"a".repeat(64)}`;

function result(
  status: number | null,
  options: { stderr?: string; stdout?: string } = {},
): ReturnType<DockerImageSetupRunner> {
  return {
    error: undefined,
    signal: null,
    status,
    stderr: options.stderr ?? "",
    stdout: options.stdout ?? "",
  };
}

describe("OpenClaw Gemini runtime image setup", () => {
  it("pulls one cold pinned image before the runtime probe (#9944)", () => {
    const runDocker = vi
      .fn<DockerImageSetupRunner>()
      .mockReturnValueOnce(result(1))
      .mockReturnValueOnce(result(0));

    expect(ensureOpenClawGeminiRuntimeImage(PINNED_IMAGE, runDocker)).toBe("pulled");
    expect(runDocker).toHaveBeenNthCalledWith(1, ["image", "inspect", PINNED_IMAGE], {
      stdio: "ignore",
      timeout: OPENCLAW_GEMINI_IMAGE_INSPECT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    expect(runDocker).toHaveBeenNthCalledWith(
      2,
      ["pull", PINNED_IMAGE],
      expect.objectContaining({
        timeout: OPENCLAW_GEMINI_IMAGE_PULL_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }),
    );
    expect(runDocker).toHaveBeenCalledTimes(2);
  });

  it("skips the pull when the pinned image is cached (#9944)", () => {
    const runDocker = vi.fn<DockerImageSetupRunner>().mockReturnValue(result(0));

    expect(ensureOpenClawGeminiRuntimeImage(PINNED_IMAGE, runDocker)).toBe("cached");
    expect(runDocker).toHaveBeenCalledOnce();
  });

  it("stops setup with a bounded pull diagnostic before the runtime probe (#9944)", () => {
    const runDocker = vi
      .fn<DockerImageSetupRunner>()
      .mockReturnValueOnce(result(1))
      .mockReturnValueOnce(result(1, { stderr: `first failure\n${"x".repeat(8 * 1024)}` }));
    const runtimeProbe = vi.fn();

    let failure: Error | undefined;
    try {
      ensureOpenClawGeminiRuntimeImage(PINNED_IMAGE, runDocker);
      runtimeProbe();
    } catch (error) {
      failure = error as Error;
    }

    expect(failure?.message).toContain("Pinned OpenClaw runtime image pull exited with status 1");
    expect(failure?.message).toContain("[diagnostic truncated]");
    const diagnostic = failure?.message.split("\n").slice(1).join("\n") ?? "";
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(runtimeProbe).not.toHaveBeenCalled();
    expect(runDocker).toHaveBeenCalledTimes(2);
  });
});
