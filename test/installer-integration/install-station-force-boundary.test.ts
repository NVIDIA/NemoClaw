// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInstallerSourced } from "../helpers/installer-express-prompt-harness";
import { runExpressPromptWithTty } from "../helpers/installer-express-prompt-pty-harness";

describe("DGX Station forced validation boundary", () => {
  it.each([
    ["environment notice acceptance", { NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1" }, []],
    ["the CLI notice-acceptance flag", {}, ["--yes-i-accept-third-party-software"]],
  ])("validates then stops the forced Station flow through main with %s", (_name, env, args) => {
    const result = runExpressPromptWithTty(
      "\n",
      "pipe",
      "DGX Station",
      {
        ...env,
        EXPRESS_RELEASE_STATE: "unsupported-dgx-os",
        NEMOCLAW_VLLM_MODEL: "deepseek-v4-flash",
      },
      "accepted-station-main",
      ["--force-station-install", ...args],
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("Run validation-only Station checks with these settings?");
    expect(output).toContain("Using validation-only Station checks");
    expect(output).toMatch(
      /factory-runtime validation completed[\s\S]*Station Express remains blocked/,
    );
    expect(output).not.toMatch(/PROVIDER=install-vllm/);
  });

  it("stops after successful validation when the software profile remains unqualified (#10928)", () => {
    const { home, result, output } = runInstallerSourced(`
_SELECTED_EXPRESS_PLATFORM='DGX Station'
NEMOCLAW_VLLM_MODEL='deepseek-v4-flash'
FORCE_STATION_INSTALL=1
classify_dgx_station_release() { printf 'unsupported-dgx-os'; }
station_installer_revision() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }
station_express_resume_generation() { printf '0123456789abcdef0123456789abcdef'; }
run_station_host_preparation() { return 0; }
ensure_station_express_host
printf 'ONBOARDING_REACHED\n'
`);

    expect(result.status, output).toBe(0);
    expect(output).toContain("factory-runtime validation completed");
    expect(output).toContain("Station Express remains blocked");
    expect(output).toContain("rerun the installer without --force-station-install");
    expect(output).not.toContain("ONBOARDING_REACHED");
    expect(fs.existsSync(path.join(home, ".nemoclaw", "station-express-resume"))).toBe(false);
  });
});
