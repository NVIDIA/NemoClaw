// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { defaultVllmModelForPlatform } from "../../src/lib/inference/vllm-models";
import {
  assertStationExpressInstallerResumeMatches,
  getStationExpressResumeIntent,
  retireStationExpressInstallerResume,
} from "../../src/lib/onboard/station-express-resume";
import { runInstallerSourced } from "../helpers/installer-express-prompt-harness";
import { INSTALLER_PAYLOAD } from "../helpers/installer-sourced-env";

describe("non-interactive Station Express selection", () => {
  it.each(["fresh", "resumed"])(
    "passes automatic Station Express selection to onboarding on %s entry",
    (entry) => {
      const { home, result, output } = runInstallerSourced(
        `
station_installer_revision() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
activate_express_install 'DGX Station'
save_station_express_resume
if [[ "$TEST_ENTRY" == resumed ]]; then
  unset NEMOCLAW_STATION_EXPRESS NEMOCLAW_PROVIDER NEMOCLAW_SANDBOX_NAME
  load_station_express_resume
  resume_loaded_station_install 'DGX Station'
fi
"$TEST_NODE" -e '
  const env = Object.fromEntries(Object.entries(process.env).filter(
    ([name]) => name === "HOME" || name.startsWith("NEMOCLAW_")
  ));
  console.log("ONBOARD_ENV=" + JSON.stringify(env));
'
`,
        { TEST_ENTRY: entry, TEST_NODE: process.execPath },
      );
      onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
      expect(result.status, output).toBe(0);
      const serialized = result.stdout.split("\n").find((line) => line.startsWith("ONBOARD_ENV="));
      expect(serialized, output).toBeDefined();
      const env = JSON.parse(serialized!.slice("ONBOARD_ENV=".length)) as NodeJS.ProcessEnv;
      const receipt = path.join(home, ".nemoclaw/station-express-resume");
      const generation = fs.readFileSync(receipt, "utf8").match(/^generation=(.+)$/mu)?.[1] ?? "";
      expect(getStationExpressResumeIntent(env, env.NEMOCLAW_SANDBOX_NAME ?? null)).toEqual({
        ok: true,
        intent: {
          version: 1,
          model: defaultVllmModelForPlatform("station", "arm64").envValue,
          sandboxName: "my-assistant",
          receiptGeneration: generation,
        },
      });
      assertStationExpressInstallerResumeMatches(generation, env);
      retireStationExpressInstallerResume(generation, { env });
      expect(fs.existsSync(receipt)).toBe(false);
    },
  );

  it.each(["express", "provider"])(
    "leaves the catalog default unforced across %s reboot resume",
    (mode) => {
      const { home, result, output } = runInstallerSourced(`
station_installer_revision() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
_STATION_INSTALL_MODE=${mode}
configure_station_express_model
printf 'INITIAL=%s|%s\\n' "\${NEMOCLAW_VLLM_MODEL-unset}" "\${NEMOCLAW_MODEL-unset}"
save_station_express_resume
load_station_express_resume
configure_station_express_model
printf 'RESUMED=%s|%s\\n' "\${NEMOCLAW_VLLM_MODEL-unset}" "\${NEMOCLAW_MODEL-unset}"
`);
      onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
      expect(result.status, output).toBe(0);
      expect(output).toContain("INITIAL=unset|unset");
      expect(output).toContain("RESUMED=unset|unset");
      expect(
        fs.readFileSync(path.join(home, ".nemoclaw/station-express-resume"), "utf8"),
      ).toContain("\nmodel=auto\n");
    },
  );
  it.each([
    ["", "", "", "0"],
    ["", "peer.example", "nemotron-3-ultra-550b-a55b", "0"],
    ["nemotron-3-ultra-550b-a55b", "", "nemotron-3-ultra-550b-a55b", "1"],
    ["nvidia-nemotron-3.5-super-vl-120b-a12b-nvfp4", "", "nemotron-3.5-super-vl-120b", "1"],
  ])("preserves model intent '%s' with peer '%s'", (model, peer, expected, explicit) => {
    const { home, result, output } = runInstallerSourced(
      `
_STATION_INSTALL_MODE=express
configure_station_express_model
printf 'MODEL=%s|%s\\n' "\${NEMOCLAW_VLLM_MODEL:-}" "$_STATION_EXPRESS_MODEL_WAS_EXPLICIT"
`,
      { NEMOCLAW_VLLM_MODEL: model, NEMOCLAW_DGX_STATION_PEER: peer },
    );
    onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
    expect(result.status, output).toBe(0);
    expect(output).toContain(`MODEL=${expected}|${explicit}`);
  });

  it("retains automatic pair discovery after a catalog-default reboot receipt", () => {
    const { home, result, output } = runInstallerSourced(`
station_installer_revision() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
_STATION_INSTALL_MODE=express
configure_station_express_model
save_station_express_resume
unset NEMOCLAW_VLLM_MODEL NEMOCLAW_MODEL
load_station_express_resume
configure_station_express_model
station_dual_model_requested
printf 'DISCOVERY=%s|%s\\n' "$?" "\${NEMOCLAW_VLLM_MODEL:-}"
`);
    onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
    expect(result.status, output).toBe(0);
    expect(output).toContain("DISCOVERY=0|\n");
  });
  function expectCiQualificationHelp(installer: string) {
    const result = spawnSync("bash", [installer, "--help"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /--express-install\s+Select Station Express for CI qualification \(requires software acceptance\)/u,
    );
  }

  it("describes Station Express as CI qualification in the standalone bootstrap help", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-express-help-"));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const installer = path.join(root, "install.sh");
    fs.copyFileSync(path.resolve(import.meta.dirname, "../../install.sh"), installer);
    expectCiQualificationHelp(installer);
  });

  it("describes Station Express as CI qualification in the versioned payload help", () => {
    expectCiQualificationHelp(INSTALLER_PAYLOAD);
  });

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
        expect(output).toContain("SELECTED=express|1|install-vllm|||suggested||1");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
  it.each([
    "--express-install --yes-i-accept-third-party-software",
    "--yes-i-accept-third-party-software --express-install --non-interactive",
  ])("delegates the Express model to the catalog through main with %s", (args) => {
    const { home, result, output } = select(args);
    try {
      expect(result.status, output).toBe(0);
      expect(output).toContain("HOST_PREPARATION");
      expect(output).toContain("SELECTED=express|1|install-vllm|||suggested||1");
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
printf 'RESUMED=%s|%s|%s\\n' "$NEMOCLAW_STATION_EXPRESS" "\${NEMOCLAW_VLLM_MODEL:-}" "\${NEMOCLAW_NON_INTERACTIVE_SUDO_MODE:-}"
`);
      try {
        expect(result.status, output).toBe(mode === "express" ? 0 : 1);
        expect(output).toContain(
          mode === "express"
            ? "RESUMED=1||"
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
