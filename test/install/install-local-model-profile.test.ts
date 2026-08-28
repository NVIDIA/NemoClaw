// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER = path.join(import.meta.dirname, "../..", "scripts", "install.sh");

function runInstallerMain(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const harness = [
    'source "$INSTALLER_UNDER_TEST"',
    "load_station_vllm_conflict_helpers() {",
    '  printf \'HARNESS_REACHED runtime=%s gate=%s no_express=%s non_interactive=%s source=%s\\n\' "$NEMOCLAW_LOCAL_MODEL_RUNTIME" "$NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE" "$NEMOCLAW_NO_EXPRESS" "$NON_INTERACTIVE" "$NON_INTERACTIVE_SOURCE"',
    "  exit 0",
    "}",
    'main "$@"',
  ].join("\n");
  return spawnSync("bash", ["-c", harness, "installer-test", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      INSTALLER_UNDER_TEST: INSTALLER,
      NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE: "",
      NEMOCLAW_LOCAL_MODEL_RUNTIME: "",
      NEMOCLAW_MODEL: "",
      NEMOCLAW_NO_EXPRESS: "",
      NEMOCLAW_PROVIDER: "",
      NEMOCLAW_VLLM_PORT: "",
      ...env,
    },
  });
}

describe("local model installer gate", () => {
  it("selects the dedicated vLLM onboarding path", () => {
    const result = runInstallerMain(["--local-model-runtime=vllm"]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("HARNESS_REACHED runtime=vllm gate=1 no_express=1");
    expect(output).toContain("non_interactive=1 source=the --local-model-runtime flag");
  });

  it.each([
    "llama-cpp",
    "unknown",
  ])("rejects the unsupported %s local model runtime before installer work", (runtime) => {
    const result = runInstallerMain([`--local-model-runtime=${runtime}`]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain(
      "--local-model-runtime must be vllm; select install-llama-cpp with NEMOCLAW_PROVIDER",
    );
    expect(output).not.toContain("HARNESS_REACHED");
  });

  it.each([
    ["provider", { NEMOCLAW_PROVIDER: "install-vllm" }],
    ["model", { NEMOCLAW_MODEL: "catalog/model" }],
  ])("rejects the %s override before installer work", (_label, env) => {
    const result = runInstallerMain(["--local-model-runtime=vllm"], env);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("HARNESS_REACHED");
  });

  it("accepts a vLLM host port override", () => {
    const result = runInstallerMain(["--local-model-runtime=vllm"], {
      NEMOCLAW_VLLM_PORT: "9000",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("HARNESS_REACHED runtime=vllm gate=1 no_express=1");
  });
});
