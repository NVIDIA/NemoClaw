// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureOpenshellResult } from "../../src/lib/adapters/openshell/client";
import {
  ONBOARD_CREATED_SANDBOX_ID,
  mockCreatedSandboxIdentityList,
  mockStructuredOpenShellCaptureFromRunner,
} from "./onboard-script-mocks.cjs";

const require = createRequire(import.meta.url);
const selector = `ai.nvidia.nemoclaw.create-attempt=${"a".repeat(62)}`;
const exactCreateQuery = [
  "openshell",
  "sandbox",
  "list",
  "-g",
  "nemoclaw-test",
  "--selector",
  selector,
  "--output",
  "json",
  "--limit",
  "2",
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mockCreatedSandboxIdentityList", () => {
  it("publishes identity for the exact gateway-scoped create-attempt query (#9833)", () => {
    expect(
      mockCreatedSandboxIdentityList(exactCreateQuery, {
        gatewayName: "nemoclaw-test",
        sandboxName: "my-assistant",
      }),
    ).toContain('"name":"my-assistant"');
  });

  it("publishes identity through the Linux process-tree timeout wrapper (#10238, #9833)", () => {
    expect(
      mockCreatedSandboxIdentityList(
        [
          "/usr/bin/timeout",
          "--signal=KILL",
          "29.75s",
          "/opt/openshell",
          ...exactCreateQuery.slice(1),
        ],
        {
          gatewayName: "nemoclaw-test",
          sandboxName: "my-assistant",
        },
      ),
    ).toContain('"name":"my-assistant"');
  });

  it.each([
    [
      "an unscoped query",
      ["openshell", "sandbox", "list", "--selector", selector, "--output", "json", "--limit", "2"],
    ],
    [
      "a different gateway",
      [...exactCreateQuery.slice(0, 4), "wrong-gateway", ...exactCreateQuery.slice(5)],
    ],
    [
      "missing JSON output",
      exactCreateQuery.filter((part) => part !== "--output" && part !== "json"),
    ],
    [
      "a different output format",
      exactCreateQuery.map((part) => (part === "json" ? "yaml" : part)),
    ],
    [
      "missing the two-row bound",
      exactCreateQuery.filter((part) => part !== "--limit" && part !== "2"),
    ],
    ["a different row bound", exactCreateQuery.map((part) => (part === "2" ? "3" : part))],
    [
      "an untrusted timeout wrapper",
      [
        "/usr/bin/timeout",
        "--signal=TERM",
        "29.75s",
        "/opt/openshell",
        ...exactCreateQuery.slice(1),
      ],
    ],
  ])("rejects %s (#9833)", (_case, command) => {
    expect(mockCreatedSandboxIdentityList(command, { gatewayName: "nemoclaw-test" })).toBeNull();
  });
});

describe("mockStructuredOpenShellCaptureFromRunner", () => {
  let client: {
    captureOpenshellCommand: (
      binary: string,
      args: readonly string[],
      options?: { includeStreams?: boolean },
    ) => CaptureOpenshellResult;
  };
  let restoreCapture: () => void;

  beforeEach(() => {
    const runner = require("../../src/lib/runner.ts") as {
      runCapture: (command: readonly string[]) => string;
    };
    client = require("../../src/lib/adapters/openshell/client.ts");
    vi.spyOn(runner, "runCapture").mockReturnValue("");
    restoreCapture = mockStructuredOpenShellCaptureFromRunner();
    mockCreatedSandboxIdentityList(exactCreateQuery, {
      gatewayName: "nemoclaw-test",
      sandboxName: "my-assistant",
    });
  });

  afterEach(() => {
    restoreCapture();
  });

  it("clears a published identity when a new fixture is installed (#9833)", () => {
    const restoreSecondCapture = mockStructuredOpenShellCaptureFromRunner();
    try {
      const result = client.captureOpenshellCommand(
        "/opt/openshell",
        ["sandbox", "get", "-g", "nemoclaw-test", "my-assistant"],
        { includeStreams: true },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
    } finally {
      restoreSecondCapture();
    }
  });

  it("synthesizes exact gateway-scoped JSON authority queries (#9833)", () => {
    expect(
      client.captureOpenshellCommand("/opt/openshell", ["gateway", "info", "-g", "nemoclaw-test"], {
        includeStreams: true,
      }).stdout,
    ).toContain("Gateway endpoint:");
    expect(
      client.captureOpenshellCommand(
        "/opt/openshell",
        ["policy", "get", "-g", "nemoclaw-test", "--full", "--output", "json", "my-assistant"],
        { includeStreams: true },
      ).stdout,
    ).toContain('"scope":"sandbox"');
    expect(
      client.captureOpenshellCommand(
        "/opt/openshell",
        ["policy", "list", "-g", "nemoclaw-test", "--global", "--limit", "1"],
        { includeStreams: true },
      ).stderr,
    ).toContain("No global policy history found");
    expect(
      client.captureOpenshellCommand(
        "/opt/openshell",
        ["sandbox", "get", "-g", "nemoclaw-test", "my-assistant"],
        { includeStreams: true },
      ).stdout,
    ).toContain(`Id: ${ONBOARD_CREATED_SANDBOX_ID}`);
  });

  it.each([
    ["an unscoped gateway read", ["gateway", "info"]],
    ["a different gateway read", ["gateway", "info", "-g", "wrong-gateway"]],
    ["an unscoped policy read", ["policy", "get", "--full", "--output", "json", "my-assistant"]],
    [
      "a non-JSON policy read",
      ["policy", "get", "-g", "nemoclaw-test", "--full", "--output", "yaml", "my-assistant"],
    ],
    [
      "a different global gateway",
      ["policy", "list", "-g", "wrong-gateway", "--global", "--limit", "1"],
    ],
    ["an unscoped sandbox read", ["sandbox", "get", "my-assistant"]],
  ])("does not synthesize %s (#9833)", (_case, args) => {
    expect(
      client.captureOpenshellCommand("/opt/openshell", args, { includeStreams: true }).stdout,
    ).toBe("");
  });
});
