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
    mocks.dockerCapture.mockReset();
  });

  it("accepts only a complete installed runtime contract (#6456)", () => {
    mocks.dockerCapture
      .mockReturnValueOnce("nemoclaw-dcode-runtime-contract-ok\n0.1.55\n")
      .mockReturnValueOnce("0.1.55\n");

    expect(deepAgentsCodeBaseImageMatchesVersion("dcode-base:current", "0.1.55")).toBe(true);
    expect(deepAgentsCodeBaseImageMatchesVersion("dcode-base:stale", "0.1.55")).toBe(false);
  });

  it("rejects a valid runtime contract for a different manifest version (#6456)", () => {
    mocks.dockerCapture.mockReturnValue("nemoclaw-dcode-runtime-contract-ok\n0.1.55\n");

    expect(deepAgentsCodeBaseImageMatchesVersion("dcode-base:mismatched", "0.1.56")).toBe(false);
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
    mocks.dockerCapture
      .mockReturnValueOnce("nemoclaw-dcode-runtime-contract-ok\n9.8.7")
      .mockReturnValueOnce("nemoclaw-dcode-dos2unix-ok")
      .mockReturnValueOnce("nemoclaw-security-inventory-ok");

    expect(options).toMatchObject({
      inputPaths: [
        "/test/root/agents/langchain-deepagents-code/manifest.yaml",
        "/test/root/agents/langchain-deepagents-code/requirements.lock",
        "/test/root/agents/langchain-deepagents-code/validate-runtime-contract.py",
      ],
      validationDescription:
        "deepagents-code==9.8.7 runtime contract, dos2unix, and the immutable security package inventory",
    });
    expect(options?.validateImage?.("dcode-base:manifest-version")).toBe(true);
  });

  it("rejects a matching distribution from a base without dos2unix (#8870)", () => {
    const options = createDeepAgentsCodeBaseImageResolutionOptions(
      makeAgent({
        name: "langchain-deepagents-code",
        displayName: "LangChain Deep Agents Code",
        expectedVersion: "0.1.34",
      }),
      "/test/root/agents/langchain-deepagents-code/Dockerfile.base",
    );
    mocks.dockerCapture
      .mockReturnValueOnce("nemoclaw-dcode-runtime-contract-ok\n0.1.34")
      .mockReturnValueOnce("");

    expect(options?.validateImage?.("dcode-base:missing-dos2unix")).toBe(false);
    expect(mocks.dockerCapture).toHaveBeenCalledTimes(2);
    expect(mocks.dockerCapture.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining([
        "run",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--user",
        "999:999",
        "--entrypoint",
        "/bin/sh",
        "dcode-base:missing-dos2unix",
        "-eu",
        "-c",
      ]),
    );
    expect(mocks.dockerCapture.mock.calls[1]?.[0].at(-1)).toContain("test -x /usr/bin/dos2unix");
    expect(mocks.dockerCapture.mock.calls[1]?.[0].at(-1)).toContain("dos2unix --version");
  });

  it("rejects a matching distribution from a base with an old security inventory (#7809)", () => {
    const options = createDeepAgentsCodeBaseImageResolutionOptions(
      makeAgent({
        name: "langchain-deepagents-code",
        displayName: "LangChain Deep Agents Code",
        expectedVersion: "0.1.55",
      }),
      "/test/root/agents/langchain-deepagents-code/Dockerfile.base",
    );
    mocks.dockerCapture
      .mockReturnValueOnce("nemoclaw-dcode-runtime-contract-ok\n0.1.55")
      .mockReturnValueOnce("nemoclaw-dcode-dos2unix-ok")
      .mockReturnValueOnce("");

    expect(options?.validateImage?.("dcode-base:v0.0.96")).toBe(false);
    expect(mocks.dockerCapture).toHaveBeenCalledTimes(3);
    expect(mocks.dockerCapture.mock.calls[2]?.[0]).toEqual(
      expect.arrayContaining([
        "run",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--entrypoint",
        "/bin/sh",
        "dcode-base:v0.0.96",
        "-c",
      ]),
    );
    expect(mocks.dockerCapture.mock.calls[2]?.[0].at(-1)).toContain(
      `cmp -s - "$security_inventory"`,
    );
  });

  it("runs the runtime contract probe in a locked-down container (#6456)", () => {
    mocks.dockerCapture.mockReturnValue("nemoclaw-dcode-runtime-contract-ok\n0.1.55");

    deepAgentsCodeBaseImageMatchesVersion("dcode-base:current", "0.1.55");

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
        'import importlib.metadata; import runpy; runpy.run_path("/usr/local/lib/nemoclaw/validate-dcode-runtime-contract.py", run_name="__main__"); print(importlib.metadata.version("deepagents-code"))',
      ],
      { ignoreError: true, timeout: 20_000 },
    );
  });

  it("warns and fails closed when the probe returns no contract output (#6456)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.dockerCapture.mockReturnValue("");

    expect(deepAgentsCodeBaseImageMatchesVersion("dcode-base:unreadable", "0.1.55")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "dcode-base:unreadable returned no Deep Agents Code runtime contract output",
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the container or contract validator may have failed"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deepagents-code==0.1.55"));
    warn.mockRestore();
  });
});
