// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInstallerSourced } from "../helpers/installer-express-prompt-harness";

describe("non-interactive Station Express selection", () => {
  function select(args: string, environment: NodeJS.ProcessEnv = {}) {
    return runInstallerSourced(
      `
detect_express_platform() { printf '%s' "$EXPRESS_PLATFORM"; }
print_banner() { :; }
validate_installer_docker_target_before_host_changes() { :; }
ensure_station_express_host() { printf 'HOST_PREPARATION\\n'; }
prepare_portable_experimental_runtime_override() { :; }
installer_requires_legacy_docker_bootstrap() { return 1; }
ensure_openshell_build_deps() { :; }
install_nemoclaw_before_onboarding() {
  printf 'AGENT=%s\\n' "\${NEMOCLAW_AGENT:-}"
  printf 'SELECTED=%s|%s|%s|%s|%s|%s|%s|%s\\n' \\
    "\${_STATION_INSTALL_MODE:-}" "\${NEMOCLAW_STATION_EXPRESS:-}" "\${NEMOCLAW_PROVIDER:-}" \\
    "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_MODEL:-}" "\${NEMOCLAW_POLICY_MODE:-}" \\
    "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}" "\${NON_INTERACTIVE:-}"
  exit 0
}
main ${args}
`,
      { EXPRESS_PLATFORM: "DGX Station", ...environment },
    );
  }

  it.each(["openclaw", "hermes", "langchain-deepagents-code"])(
    "preserves the explicitly selected %s agent in headless Express",
    (agent) => {
      const { home, result, output } = select(
        "--express-install --yes-i-accept-third-party-software",
        { NEMOCLAW_AGENT: agent },
      );
      try {
        expect(result.status, output).toBe(0);
        expect(output).toContain(`AGENT=${agent}`);
        expect(output).toContain("SELECTED=express|1|install-vllm|nemotron-3-ultra-550b-a55b|");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
  it.each([
    "--express-install --yes-i-accept-third-party-software",
    "--yes-i-accept-third-party-software --express-install --non-interactive",
  ])("selects the real Ultra Express recipe through main with %s", (args) => {
    const { home, result, output } = select(args);
    try {
      expect(result.status, output).toBe(0);
      expect(output).toContain("HOST_PREPARATION");
      expect(output).toContain(
        "SELECTED=express|1|install-vllm|nemotron-3-ultra-550b-a55b|nvidia/nemotron-3-ultra-550b-a55b|suggested||1",
      );
      expect(output).not.toContain("Run express install with these settings?");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts the existing notice environment variable without a second acceptance mechanism", () => {
    const { home, result, output } = select("--express-install", {
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    });
    try {
      expect(result.status, output).toBe(0);
      expect(output).toContain("SELECTED=express|1|install-vllm|");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps ordinary accepted non-interactive installation outside Express", () => {
    const { home, result, output } = select("--yes-i-accept-third-party-software");
    try {
      expect(result.status, output).toBe(0);
      expect(output).toContain("SELECTED=|||||||1");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    { args: "--express-install", env: {}, error: "requires --yes-i-accept-third-party-software" },
    {
      args: "--express-install --station-deepseek",
      env: {},
      error: "interactive --station-deepseek",
    },
    {
      args: "--express-install --force-station-install",
      env: {},
      error: "interactive --station-deepseek",
    },
    {
      args: "--express-install",
      env: { NEMOCLAW_NO_EXPRESS: "1" },
      error: "NEMOCLAW_NO_EXPRESS=1",
    },
    {
      args: "--express-install",
      env: { NEMOCLAW_PROVIDER: "install-vllm" },
      error: "remove NEMOCLAW_PROVIDER",
    },
    {
      args: "--express-install",
      env: { EXPRESS_PLATFORM: "DGX Spark" },
      error: "requires a supported DGX Station",
    },
    {
      args: "--express-install",
      env: { EXPRESS_PLATFORM: "" },
      error: "requires a supported DGX Station",
    },
    {
      args: "--express-install",
      env: { NEMOCLAW_NON_INTERACTIVE_SUDO_MODE: "prompt" },
      error: "cannot enable sudo prompts",
    },
    {
      args: "--express-install --local-model-runtime=vllm",
      env: {},
      error: "NEMOCLAW_NO_EXPRESS=1",
    },
    {
      args: "--express-install --defer-onboarding",
      env: { NEMOCLAW_AGENT: "hermes" },
      error: "cannot be combined with --defer-onboarding",
    },
  ])("rejects conflicting or incomplete intent: $error ($args, $env)", ({ args, env, error }) => {
    const acceptance = error.startsWith("requires --yes")
      ? {}
      : { NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" };
    const { home, result, output } = select(args, { ...acceptance, ...env });
    try {
      expect(result.status, output).not.toBe(0);
      expect(output).toContain(error);
      expect(output).not.toContain("HOST_PREPARATION");
      expect(output).not.toContain("SELECTED=");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(["express", "provider"])(
    "revalidates %s resume intent produced by the installer",
    (mode) => {
      const { home, result, output } = runInstallerSourced(`
detect_express_platform() { printf 'DGX Station'; }
station_installer_revision() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
_STATION_INSTALL_MODE=${mode}
configure_station_express_model
save_station_express_resume
unset NEMOCLAW_PROVIDER NEMOCLAW_VLLM_MODEL NEMOCLAW_MODEL
EXPRESS_INSTALL=1
ACCEPT_THIRD_PARTY_SOFTWARE=1
maybe_offer_express_install
printf 'RESUMED=%s|%s|%s\\n' "$NEMOCLAW_STATION_EXPRESS" "$NEMOCLAW_VLLM_MODEL" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}"
`);
      try {
        expect(result.status, output).toBe(mode === "express" ? 0 : 1);
        expect(output).toContain(
          mode === "express"
            ? "RESUMED=1|nemotron-3-ultra-550b-a55b|"
            : "resume state was accepted in provider mode; refusing to resume it in express mode",
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.each([0, 1])(
    "requires non-interactive sudo before invoking Station preparation (exit %s)",
    (sudoExit) => {
      const { home, result, output } = runInstallerSourced(`
EXPRESS_INSTALL=1
sudo() { printf '%s\\n' "$*" >>"$HOME/sudo-calls"; return ${sudoExit}; }
bash() { printf 'PREPARE_SUDO_MODE=%s\\n' "$NEMOCLAW_STATION_PREP_SUDO_NONINTERACTIVE"; }
filter_station_host_preparation_output() { cat; }
run_station_host_preparation
`);
      try {
        expect(fs.readFileSync(path.join(home, "sudo-calls"), "utf8")).toBe("-n true\n");
        expect(result.status, output).toBe(sudoExit);
        expect(output).toContain(
          sudoExit === 0 ? "PREPARE_SUDO_MODE=1" : "requires non-interactive sudo",
        );
        expect(output.includes("PREPARE_SUDO_MODE=")).toBe(sudoExit === 0);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
