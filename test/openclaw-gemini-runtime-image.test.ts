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
  options: {
    error?: NodeJS.ErrnoException;
    signal?: NodeJS.Signals | null;
    stderr?: string;
    stdout?: string;
  } = {},
): ReturnType<DockerImageSetupRunner> {
  return {
    error: options.error,
    signal: options.signal ?? null,
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
    const authorizationSecret = "registry-authorization-secret";
    const cookieSecret = "registry-cookie-secret";
    const urlPassword = "registry-url-password";
    const querySecret = "registry-query-secret";
    const runDocker = vi
      .fn<DockerImageSetupRunner>()
      .mockReturnValueOnce(result(1))
      .mockReturnValueOnce(
        result(1, {
          stderr: [
            "x".repeat(8 * 1024),
            "pull access denied",
            `\u001b[31mAuthorization: Bearer ${authorizationSecret}\u001b[0m`,
            `Cookie: session=${cookieSecret}`,
            `https://registry-user:${urlPassword}@registry.example/v2/image?token=${querySecret}`,
            "\u001b]0;forged-title\u0007::warning::forged-command\u000b",
          ].join("\r\n"),
        }),
      );
    const runtimeProbe = vi.fn();

    let failure: Error | undefined;
    try {
      ensureOpenClawGeminiRuntimeImage(PINNED_IMAGE, runDocker);
      runtimeProbe();
    } catch (error) {
      failure = error as Error;
    }

    expect(failure?.message).toContain("Pinned OpenClaw runtime image pull exited with status 1");
    expect(failure?.message).toContain("pull access denied");
    expect(failure?.message).toContain("<REDACTED>");
    expect(failure?.message).toContain("[diagnostic truncated]");
    expect(failure?.message).not.toContain(authorizationSecret);
    expect(failure?.message).not.toContain(cookieSecret);
    expect(failure?.message).not.toContain(urlPassword);
    expect(failure?.message).not.toContain(querySecret);
    expect(failure?.message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
    const diagnostic = failure?.message.split("\n").slice(1).join("\n") ?? "";
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(runtimeProbe).not.toHaveBeenCalled();
    expect(runDocker).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      expected: "timed out",
      inspect: result(null, {
        error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }),
      }),
      scenario: "times out",
    },
    {
      expected: "terminated by SIGKILL",
      inspect: result(null, { signal: "SIGKILL" }),
      scenario: "is terminated",
    },
    {
      expected: "exited with status null",
      inspect: result(null),
      scenario: "has no normal exit status",
    },
  ])("fails without pulling when image inspection $scenario (#9944)", ({ expected, inspect }) => {
    const runDocker = vi.fn<DockerImageSetupRunner>().mockReturnValue(inspect);

    expect(() => ensureOpenClawGeminiRuntimeImage(PINNED_IMAGE, runDocker)).toThrow(
      `Pinned OpenClaw runtime image inspection ${expected}`,
    );
    expect(runDocker).toHaveBeenCalledOnce();
  });
});
