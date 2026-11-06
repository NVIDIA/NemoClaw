// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeHermesConfigNatively } from "./hermes-native-config";

const execute = vi.fn<typeof import("../adapters/openshell/client").runOpenshellCommand>();
const content = "model:\n  api_key: private-input\n";
const digest = "a".repeat(64);

describe("native Hermes configuration transport", () => {
  beforeEach(() => {
    execute.mockReturnValue({
      status: 0,
      stdout: "updated=1\n",
      stderr: "",
      signal: null,
      pid: 1,
      output: [],
    });
  });

  it("sends private configuration only through stdin to the selected gateway", () => {
    writeHermesConfigNatively(
      "/pinned/openshell",
      "hermes",
      "selected-gateway",
      digest,
      content,
      execute,
    );
    const [binary, argv, options] = execute.mock.calls[0]!;
    expect(binary).toBe("/pinned/openshell");
    expect(argv.slice(0, 6)).toEqual([
      "-g",
      "selected-gateway",
      "sandbox",
      "exec",
      "--name",
      "hermes",
    ]);
    expect(argv.at(-1)).toBe(digest);
    expect(argv.join(" ")).not.toContain("private-input");
    expect(options).toMatchObject({ input: content, stdio: "pipe", timeout: 650_000 });
  });

  it("uses the supplied runtime environment without merging ambient selectors", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/ambient/tls");
    vi.stubEnv("OPENSHELL_TOKEN", "ambient-token");
    writeHermesConfigNatively(
      "/pinned/openshell",
      "hermes",
      "recorded-gateway",
      digest,
      content,
      execute,
      { env: { OPENSHELL_GATEWAY: "recorded-gateway", OPENSHELL_WORKSPACE: "recorded-workspace" } },
    );
    const [, argv, options] = execute.mock.calls[0]!;
    expect(argv.slice(0, 2)).toEqual(["-g", "recorded-gateway"]);
    expect(options).toMatchObject({
      replaceEnv: true,
      env: {
        OPENSHELL_GATEWAY: "recorded-gateway",
        OPENSHELL_WORKSPACE: "recorded-workspace",
      },
    });
    expect(options?.env).not.toHaveProperty("OPENSHELL_LOCAL_TLS_DIR");
    expect(options?.env).not.toHaveProperty("OPENSHELL_TOKEN");
  });

  it.each([
    { status: 1, stdout: "", stderr: "private-input" },
    { status: 0, stdout: "unexpected", stderr: "private-input" },
    { status: null, signal: "SIGTERM" as const, stdout: "", stderr: "private-input" },
  ])("rejects an unconfirmed write without exposing private diagnostics %j", (result) => {
    execute.mockReturnValue({ signal: null, pid: 1, output: [], ...result });
    expect(() =>
      writeHermesConfigNatively("openshell", "hermes", "gateway", digest, content, execute),
    ).toThrow(
      "Native Hermes configuration transaction failed; configuration application was not confirmed.",
    );
  });
});
