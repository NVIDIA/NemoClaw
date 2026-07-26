// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildCustomOpenClawRuntimeFailureHints,
  classifyOpenClawRuntimeFailure,
  shouldDiagnoseCustomOpenClawRuntime,
} from "./custom-openclaw-runtime-diagnosis.js";

function probeResult(stdout: string) {
  return { status: 0, stdout, stderr: "" };
}

describe("classifyOpenClawRuntimeFailure", () => {
  it("recognizes a normal managed runtime when startup and config artifacts exist", () => {
    const result = classifyOpenClawRuntimeFailure("my-sandbox", () =>
      probeResult("nemoclaw-runtime-probe-v1 log=0 start=1 config=1"),
    );
    expect(result).toEqual({
      kind: "normal_runtime",
      gatewayLogPresent: false,
      startupScriptPresent: true,
      configPresent: true,
    });
  });

  it("recognizes the base-only image when log, startup, and config artifacts are absent (#6108)", () => {
    const result = classifyOpenClawRuntimeFailure("my-sandbox", () =>
      probeResult("nemoclaw-runtime-probe-v1 log=0 start=0 config=0"),
    );
    expect(result.kind).toBe("base_only_image");
    expect(buildCustomOpenClawRuntimeFailureHints(result)).toMatchObject({
      gateway: expect.stringContaining("sandbox-base"),
      dashboard: expect.stringContaining("cannot start"),
    });
  });

  it.each([
    ["gateway log only", "nemoclaw-runtime-probe-v1 log=1 start=0 config=0"],
    ["startup script only", "nemoclaw-runtime-probe-v1 log=0 start=1 config=0"],
    ["generated config only", "nemoclaw-runtime-probe-v1 log=0 start=0 config=1"],
  ])("keeps a partial managed runtime inconclusive when it has %s", (_name, stdout) => {
    const result = classifyOpenClawRuntimeFailure("my-sandbox", () => probeResult(stdout));
    expect(result.kind).toBe("inconclusive");
    expect(buildCustomOpenClawRuntimeFailureHints(result)).toBeNull();
  });

  it("preserves an unreachable classification when sandbox exec fails", () => {
    const result = classifyOpenClawRuntimeFailure("my-sandbox", () => null);
    expect(result.kind).toBe("sandbox_unreachable");
  });

  it("recognizes OpenShell-framed probe output", () => {
    const result = classifyOpenClawRuntimeFailure("my-sandbox", () =>
      probeResult(
        "OpenShell sandbox exec output:\r\nstdout: nemoclaw-runtime-probe-v1 log=0 start=0 config=0\r\n",
      ),
    );
    expect(result.kind).toBe("base_only_image");
  });

  it.each([
    [
      "nonzero probe",
      { status: 1, stdout: "nemoclaw-runtime-probe-v1 log=0 start=0 config=0", stderr: "" },
    ],
    ["malformed output", probeResult("not a runtime probe frame")],
    [
      "ANSI-prefixed output",
      probeResult("\u001b[31mnemoclaw-runtime-probe-v1 log=0 start=0 config=0"),
    ],
    ["tab-prefixed output", probeResult("\tnemoclaw-runtime-probe-v1 log=0 start=0 config=0")],
    [
      "form-feed-prefixed output",
      probeResult("\fnemoclaw-runtime-probe-v1 log=0 start=0 config=0"),
    ],
    ["case-altered marker", probeResult("NEMOCLAW-runtime-probe-v1 log=0 start=0 config=0")],
  ])("keeps a %s inconclusive", (_name, probe) => {
    const result = classifyOpenClawRuntimeFailure("my-sandbox", () => probe);
    expect(result).toEqual({
      kind: "inconclusive",
      gatewayLogPresent: null,
      startupScriptPresent: null,
      configPresent: null,
    });
  });
});

describe("shouldDiagnoseCustomOpenClawRuntime", () => {
  it.each([
    ["custom OpenClaw Dockerfile", "/tmp/Dockerfile", "openclaw", true],
    ["stock OpenClaw image", null, "openclaw", false],
    ["custom Hermes Dockerfile", "/tmp/Dockerfile", "hermes", false],
  ])("returns the expected gate for a %s", (_name, dockerfile, agent, expected) => {
    expect(shouldDiagnoseCustomOpenClawRuntime(dockerfile, agent)).toBe(expected);
  });
});
