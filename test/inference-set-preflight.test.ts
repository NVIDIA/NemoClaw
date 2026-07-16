// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { InferenceSetError, readInSandboxConfigOrFail } from "../src/lib/actions/inference-set";
import type { AgentConfigTarget } from "../src/lib/sandbox/config";
import { SandboxConfigError } from "../src/lib/sandbox/config";
import type { ConfigObject } from "../src/lib/security/credential-filter";

const TARGET = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
} as unknown as AgentConfigTarget;

describe("readInSandboxConfigOrFail pre-flight gate (#6997)", () => {
  it("returns the config when the sandbox is readable", () => {
    const config = { model: "old" } as unknown as ConfigObject;
    const readSandboxConfig = vi.fn(() => config);

    const result = readInSandboxConfigOrFail({ readSandboxConfig }, "box", TARGET);

    expect(result).toBe(config);
    expect(readSandboxConfig).toHaveBeenCalledWith("box", TARGET);
  });

  it("converts a stopped-sandbox SandboxConfigError into an actionable InferenceSetError", () => {
    const readSandboxConfig = vi.fn(() => {
      throw new SandboxConfigError(
        [
          "  Cannot read openclaw config (/sandbox/.openclaw/openclaw.json).",
          "  Is the sandbox running?",
        ],
        3,
      );
    });

    let thrown: unknown;
    try {
      readInSandboxConfigOrFail({ readSandboxConfig }, "box", TARGET);
    } catch (error) {
      thrown = error;
    }

    // Must be the command-layer error type so it is handled cleanly (no raw stack).
    expect(thrown).toBeInstanceOf(InferenceSetError);
    const err = thrown as InferenceSetError;
    // Preserves the original diagnostic lines and the recorded exit code...
    expect(err.message).toContain("Is the sandbox running?");
    expect(err.exitCode).toBe(3);
    // ...and adds the actionable next step.
    expect(err.message).toContain("Start the sandbox and retry");
  });

  it("omits the start-sandbox hint for a non-stopped config error (e.g. parse failure)", () => {
    // A corrupt/unparseable config raises SandboxConfigError too, but starting
    // the sandbox would not fix it — the start hint must not be appended.
    const readSandboxConfig = vi.fn(() => {
      throw new SandboxConfigError(["  Failed to parse openclaw config: unexpected token."], 1);
    });

    let thrown: unknown;
    try {
      readInSandboxConfigOrFail({ readSandboxConfig }, "box", TARGET);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InferenceSetError);
    const err = thrown as InferenceSetError;
    expect(err.message).toContain("Failed to parse");
    expect(err.message).not.toContain("Start the sandbox and retry");
  });

  it("does not swallow unrelated errors", () => {
    const boom = new TypeError("unexpected");
    const readSandboxConfig = vi.fn(() => {
      throw boom;
    });

    expect(() => readInSandboxConfigOrFail({ readSandboxConfig }, "box", TARGET)).toThrow(boom);
  });
});
