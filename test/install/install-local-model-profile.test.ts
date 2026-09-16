// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER = path.join(import.meta.dirname, "../..", "scripts", "install.sh");

function runInstallerMain(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const harness = [
    'source "$INSTALLER_UNDER_TEST"',
    "prepare_installer_node_runtime() { printf 'MUTATION_REACHED prepare_installer_node_runtime\\n'; }",
    "prepare_installer_host() { printf 'MUTATION_REACHED prepare_installer_host\\n'; }",
    "install_nemoclaw_before_onboarding() { printf 'MUTATION_REACHED install_nemoclaw_before_onboarding\\n'; }",
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

  it.each(["llama-cpp", "unknown"])(
    "rejects the unsupported %s local model runtime before installer work",
    (runtime) => {
      const result = runInstallerMain([`--local-model-runtime=${runtime}`]);
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).not.toBe(0);
      expect(output).toContain(
        "--local-model-runtime must be vllm; select install-llama-cpp with NEMOCLAW_PROVIDER",
      );
      expect(output).not.toContain("HARNESS_REACHED");
    },
  );

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

  it.each([
    ["vLLM", "NEMOCLAW_VLLM_PORT", "08000"],
    ["Hermes dashboard", "NEMOCLAW_HERMES_DASHBOARD_PORT", "09120"],
    ["Hermes internal dashboard", "NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT", "019120"],
    ["Hermes API", "NEMOCLAW_HERMES_API_PORT", "08642"],
  ])("rejects a noncanonical %s port before installer work", (_label, envName, value) => {
    const result = runInstallerMain(["--local-model-runtime=vllm"], { [envName]: value });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain(`${envName} must be an integer between 1024 and 65535`);
    expect(output).not.toContain("HARNESS_REACHED");
    expect(output).not.toContain("MUTATION_REACHED");
  });
});
