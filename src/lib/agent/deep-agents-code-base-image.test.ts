// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeAgent } from "../../../test/helpers/base-image-test-harness";

const mocks = vi.hoisted(() => ({
  dockerCapture: vi.fn(),
}));

vi.mock("../adapters/docker", () => ({
  dockerCapture: mocks.dockerCapture,
}));

import {
  createDeepAgentsCodeBaseImageResolutionOptions,
  deepAgentsCodeBaseImageMatchesVersion,
} from "./deep-agents-code-base-image";

describe("Deep Agents Code base image compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts only the exact installed distribution version (#6456)", () => {
    mocks.dockerCapture.mockReturnValueOnce("0.1.34\n").mockReturnValueOnce("0.1.12\n");

    expect(deepAgentsCodeBaseImageMatchesVersion("dcode-base:current", "0.1.34")).toBe(true);
    expect(deepAgentsCodeBaseImageMatchesVersion("dcode-base:stale", "0.1.34")).toBe(false);
  });

  it("binds the manifest version and source files into resolution options (#6456)", () => {
    const options = createDeepAgentsCodeBaseImageResolutionOptions(
      makeAgent({
        name: "langchain-deepagents-code",
        displayName: "LangChain Deep Agents Code",
        expectedVersion: "9.8.7",
      }),
      "/test/root/agents/langchain-deepagents-code/Dockerfile.base",
    );
    mocks.dockerCapture.mockReturnValue("9.8.7");

    expect(options).toMatchObject({
      inputPaths: [
        "/test/root/agents/langchain-deepagents-code/manifest.yaml",
        "/test/root/agents/langchain-deepagents-code/requirements.lock",
      ],
      validationDescription: "deepagents-code==9.8.7",
    });
    expect(options?.validateImage?.("dcode-base:manifest-version")).toBe(true);
  });

  it("runs the version probe in a locked-down container (#6456)", () => {
    mocks.dockerCapture.mockReturnValue("0.1.34");

    deepAgentsCodeBaseImageMatchesVersion("dcode-base:current", "0.1.34");

    expect(mocks.dockerCapture).toHaveBeenCalledWith(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--entrypoint",
        "/opt/venv/bin/python3",
        "dcode-base:current",
        "-I",
        "-c",
        'import importlib.metadata; print(importlib.metadata.version("deepagents-code"))',
      ],
      { ignoreError: true, timeout: 20_000 },
    );
  });

  it("warns and fails closed when the probe returns no version (#6456)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.dockerCapture.mockReturnValue("");

    expect(deepAgentsCodeBaseImageMatchesVersion("dcode-base:unreadable", "0.1.34")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dcode-base:unreadable returned no Deep Agents Code version output"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the container or metadata probe may have failed"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deepagents-code==0.1.34"));
    warn.mockRestore();
  });
});
