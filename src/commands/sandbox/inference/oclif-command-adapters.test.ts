// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runInferenceGet: vi.fn(),
  runInferenceSet: vi.fn(),
}));

vi.mock("../../../lib/actions/inference-set", () => ({
  InferenceSetError: class InferenceSetError extends Error {
    exitCode: number;

    constructor(message: string, exitCode = 1) {
      super(message);
      this.name = "InferenceSetError";
      this.exitCode = exitCode;
    }
  },
  runInferenceSet: mocks.runInferenceSet,
}));

vi.mock("../../../lib/actions/inference-get", () => ({
  InferenceGetError: class InferenceGetError extends Error {
    exitCode: number;

    constructor(message: string, exitCode = 1) {
      super(message);
      this.name = "InferenceGetError";
      this.exitCode = exitCode;
    }
  },
  runInferenceGet: mocks.runInferenceGet,
}));

import { InferenceGetError } from "../../../lib/actions/inference-get";
import { InferenceSetError } from "../../../lib/actions/inference-set";
import SandboxInferenceGetCommand from "./get";
import SandboxInferenceSetCommand from "./set";

const rootDir = process.cwd();

describe("sandbox inference oclif command adapters (#5977)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runInferenceSet.mockResolvedValue({
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "nvidia/model-a",
      primaryModelRef: "inference/nvidia/model-a",
      providerKey: "inference",
      configChanged: true,
      sessionUpdated: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the positional sandbox name and custom-provider flags to runInferenceSet", async () => {
    await SandboxInferenceSetCommand.run(
      [
        "alpha",
        "--provider",
        "compatible-endpoint",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
        "--no-verify",
        "--endpoint-url",
        "https://example.test/v1",
        "--credential-env",
        "COMPATIBLE_API_KEY",
        "--inference-api",
        "openai-completions",
      ],
      rootDir,
    );

    expect(mocks.runInferenceSet).toHaveBeenCalledWith({
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-super-120b-a12b",
      sandboxName: "alpha",
      noVerify: true,
      endpointUrl: "https://example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      inferenceApi: "openai-completions",
    });
  });

  it("prints the missing-flags redirect without calling runInferenceSet", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await expect(SandboxInferenceSetCommand.run(["alpha"], rootDir)).resolves.toBeUndefined();

      expect(mocks.runInferenceSet).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("inference set requires --provider and --model"),
      );
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it("rejects an empty --provider before runInferenceSet is called", async () => {
    await expect(
      SandboxInferenceSetCommand.run(
        ["alpha", "--provider", "   ", "--model", "nvidia/model-a"],
        rootDir,
      ),
    ).rejects.toThrow(/provider name cannot be empty/i);

    expect(mocks.runInferenceSet).not.toHaveBeenCalled();
  });

  it("rejects an empty --model before runInferenceSet is called (#5977)", async () => {
    await expect(
      SandboxInferenceSetCommand.run(
        ["alpha", "--provider", "nvidia-prod", "--model", "   "],
        rootDir,
      ),
    ).rejects.toThrow(/model id .* cannot be empty/i);

    expect(mocks.runInferenceSet).not.toHaveBeenCalled();
  });

  it("maps the sandbox inference get --json output into oclif JSON handling", async () => {
    mocks.runInferenceGet.mockResolvedValueOnce({
      provider: "nvidia-prod",
      model: "nvidia/model-a",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await SandboxInferenceGetCommand.run(["alpha", "--json"], rootDir);

      expect(mocks.runInferenceGet).toHaveBeenCalledWith({ quiet: true });
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("surfaces the 'route not configured' get failure with its message and exit code (#5977)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      mocks.runInferenceGet.mockRejectedValueOnce(
        new InferenceGetError("OpenShell inference route is not configured.", 1),
      );

      await expect(SandboxInferenceGetCommand.run(["alpha"], rootDir)).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith("OpenShell inference route is not configured.");
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it("surfaces a typed set validation failure (unsupported provider) with its exit code (#5977)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      mocks.runInferenceSet.mockRejectedValueOnce(
        new InferenceSetError("Unsupported inference provider 'bogus-provider'.", 2),
      );

      await expect(
        SandboxInferenceSetCommand.run(
          ["alpha", "--provider", "bogus-provider", "--model", "nvidia/model-a"],
          rootDir,
        ),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(error).toHaveBeenCalledWith("Unsupported inference provider 'bogus-provider'.");
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it("surfaces a typed set validation failure (unsafe model id) with its exit code (#5977)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      mocks.runInferenceSet.mockRejectedValueOnce(
        new InferenceSetError("Unsafe model id 'nvidia/model a'.", 2),
      );

      await expect(
        SandboxInferenceSetCommand.run(
          ["alpha", "--provider", "nvidia-prod", "--model", "nvidia/model a"],
          rootDir,
        ),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(error).toHaveBeenCalledWith("Unsafe model id 'nvidia/model a'.");
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it("surfaces typed endpoint-url validation failures from the action layer with exit code 2 (#5977)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      mocks.runInferenceSet.mockRejectedValueOnce(
        new InferenceSetError("Custom endpoint URL must use http(s).", 2),
      );
      await expect(
        SandboxInferenceSetCommand.run(
          [
            "alpha",
            "--provider",
            "compatible-endpoint",
            "--model",
            "m",
            "--endpoint-url",
            "ftp://x",
          ],
          rootDir,
        ),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(error).toHaveBeenLastCalledWith("Custom endpoint URL must use http(s).");

      mocks.runInferenceSet.mockRejectedValueOnce(
        new InferenceSetError("Custom endpoint URL must not embed credentials.", 2),
      );
      await expect(
        SandboxInferenceSetCommand.run(
          [
            "alpha",
            "--provider",
            "compatible-endpoint",
            "--model",
            "m",
            "--endpoint-url",
            "https://u:p@x/v1",
          ],
          rootDir,
        ),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(error).toHaveBeenLastCalledWith("Custom endpoint URL must not embed credentials.");

      mocks.runInferenceSet.mockRejectedValueOnce(
        new InferenceSetError("Custom endpoint URL must include a scheme.", 2),
      );
      await expect(
        SandboxInferenceSetCommand.run(
          ["alpha", "--provider", "compatible-endpoint", "--model", "m", "--endpoint-url", "x/v1"],
          rootDir,
        ),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(error).toHaveBeenLastCalledWith("Custom endpoint URL must include a scheme.");
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it("surfaces typed credential-env, inference-api, and metadata validation failures with exit code 2 (#5977)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      mocks.runInferenceSet.mockRejectedValueOnce(
        new InferenceSetError(
          "credential-env must be COMPATIBLE_API_KEY for compatible-endpoint.",
          2,
        ),
      );
      await expect(
        SandboxInferenceSetCommand.run(
          [
            "alpha",
            "--provider",
            "compatible-endpoint",
            "--model",
            "m",
            "--credential-env",
            "SOME_OTHER_KEY",
          ],
          rootDir,
        ),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(error).toHaveBeenLastCalledWith(
        "credential-env must be COMPATIBLE_API_KEY for compatible-endpoint.",
      );

      mocks.runInferenceSet.mockRejectedValueOnce(
        new InferenceSetError("inference-api 'bogus-api' is not supported.", 2),
      );
      await expect(
        SandboxInferenceSetCommand.run(
          [
            "alpha",
            "--provider",
            "compatible-endpoint",
            "--model",
            "m",
            "--inference-api",
            "bogus-api",
          ],
          rootDir,
        ),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(error).toHaveBeenLastCalledWith("inference-api 'bogus-api' is not supported.");

      mocks.runInferenceSet.mockRejectedValueOnce(
        new InferenceSetError(
          "Custom endpoint metadata is only allowed for compatible providers.",
          2,
        ),
      );
      await expect(
        SandboxInferenceSetCommand.run(
          ["alpha", "--provider", "nvidia-prod", "--model", "m", "--endpoint-url", "https://x/v1"],
          rootDir,
        ),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(error).toHaveBeenLastCalledWith(
        "Custom endpoint metadata is only allowed for compatible providers.",
      );
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it("records typed inference action failures without throwing oclif ExitError", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      mocks.runInferenceGet.mockRejectedValueOnce(new InferenceGetError("route missing", 3));
      mocks.runInferenceSet.mockRejectedValueOnce(new InferenceSetError("route rejected", 4));

      await expect(SandboxInferenceGetCommand.run(["alpha"], rootDir)).resolves.toBeUndefined();
      expect(process.exitCode).toBe(3);
      expect(error).toHaveBeenCalledWith("route missing");

      await expect(
        SandboxInferenceSetCommand.run(
          ["alpha", "--provider", "nvidia-prod", "--model", "nvidia/model-a"],
          rootDir,
        ),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(4);
      expect(error).toHaveBeenCalledWith("route rejected");
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });
});
