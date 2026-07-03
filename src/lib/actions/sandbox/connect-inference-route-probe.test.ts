// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildSandboxInferenceRouteProbeArgs } from "./connect-inference-route-probe";

const INFERENCE_ROUTE_PROBE_SCRIPT = [
  "OUT=/tmp/nemoclaw-inference-route-probe.out",
  "HTTP_CODE=$(curl -sk -o \"$OUT\" -w '%{http_code}' --connect-timeout 3 --max-time 8 https://inference.local/v1/models 2>/dev/null) || HTTP_CODE=000",
  'case "$HTTP_CODE" in 000|5*) printf \'BROKEN %s \' "$HTTP_CODE"; head -c 160 "$OUT" 2>/dev/null || true ;; *) printf \'OK %s\' "$HTTP_CODE" ;; esac',
].join("; ");

describe("sandbox connect inference route probe argv", () => {
  it("uses the dcode login-shell proxy contract without inherited proxy variables (#6191)", () => {
    const args = buildSandboxInferenceRouteProbeArgs("deep-code", {
      name: "langchain-deepagents-code",
    });

    expect(args).toEqual([
      "sandbox",
      "exec",
      "--name",
      "deep-code",
      "--",
      "env",
      "-u",
      "HTTP_PROXY",
      "-u",
      "HTTPS_PROXY",
      "-u",
      "http_proxy",
      "-u",
      "https_proxy",
      "-u",
      "NO_PROXY",
      "-u",
      "no_proxy",
      "-u",
      "ALL_PROXY",
      "-u",
      "all_proxy",
      "HOME=/sandbox",
      "bash",
      "-lc",
      INFERENCE_ROUTE_PROBE_SCRIPT,
    ]);
    expect(args.every((arg) => !/[\r\n]/.test(arg))).toBe(true);
  });

  it.each([
    null,
    { name: "openclaw" },
    { name: "hermes" },
  ])("preserves the plain sh probe for non-dcode agents (%j)", (agent) => {
    expect(buildSandboxInferenceRouteProbeArgs("alpha", agent)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
      "sh",
      "-c",
      INFERENCE_ROUTE_PROBE_SCRIPT,
    ]);
  });
});
