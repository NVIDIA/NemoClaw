// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runInstallerSourced } from "./helpers/installer-express-prompt-harness";
import { runExpressPromptWithTty } from "./helpers/installer-express-prompt-pty-harness";

describe("installer N1x Express preview", () => {
  it("offers one single-host managed-vLLM path (#8574)", () => {
    const result = runExpressPromptWithTty("y\n", "pipe", "N1x");
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Detected N1x/);
    expect(output).not.toMatch(/Choose the DGX Spark inference setup/);
    expect(output).toMatch(/N1x Express is a Deferred preview/);
    expect(output).toMatch(/explicit preview intent, not a supported-platform claim/);
    expect(output).toMatch(/Run the Deferred N1x preview with these settings/);
    expect(output).toMatch(
      /The Deferred N1x preview will configure managed local vLLM with Qwen3\.6 35B-A3B NVFP4/,
    );
    expect(output).toMatch(
      /does not activate DGX Spark cluster discovery or fixed catalog behavior/,
    );
    expect(output).toMatch(/existing CUDA and CDI readiness checks pass/);
    expect(output).toMatch(/Using the Deferred N1x preview/);
    expect(output).toMatch(
      /RESULT NON_INTERACTIVE=1 SUDO_MODE=prompt PROVIDER=install-vllm MODEL= VLLM_MODEL= POLICY=suggested YES=1 SANDBOX=my-assistant STATION_EXPRESS= PROFILE_GATE= PROFILE_RUNTIME= SPARK_SELECTION=/,
    );
  });

  it("detects N1x only when FastOS and PCI identity both qualify (#8574)", () => {
    const detectN1x = (fastOsQualified: boolean, pciQualified: boolean) =>
      runInstallerSourced(`
function [ {
  if [[ "$#" -eq 3 && "$1" = "-r" && "$2" = "/sys/class/dmi/id/product_name" && "$3" = "]" ]]; then
    return 0
  fi
  builtin [ "$@"
}
cat() {
  if [[ "$#" -eq 1 && "$1" = "/sys/class/dmi/id/product_name" ]]; then
    printf "SKU 1"
    return
  fi
  command cat "$@"
}
is_wsl_host() { return 1; }
uname() { if [ "$1" = "-s" ]; then printf "Linux"; else printf "aarch64"; fi; }
n1x_fastos_release_is_trusted() { return ${fastOsQualified ? "0" : "1"}; }
n1x_has_pci_gpu() { return ${pciQualified ? "0" : "1"}; }
detect_express_platform
`);

    expect(detectN1x(true, true).result.stdout).toBe("N1x");
    expect(detectN1x(true, false).result.stdout).toBe("");
    expect(detectN1x(false, true).result.stdout).toBe("");
  });

  it("validates bounded root-owned FastOS metadata (#8574)", () => {
    const accepted = runInstallerSourced(
      `n1x_fastos_release_metadata_is_trusted "regular file:0:0:644:116:1:2"`,
    );
    expect(accepted.result.status, accepted.output).toBe(0);

    for (const metadata of [
      "symbolic link:0:0:777:24:1:2",
      "regular file:1000:0:644:116:1:2",
      "regular file:0:1000:644:116:1:2",
      "regular file:0:0:666:116:1:2",
      "regular file:0:0:644:4097:1:2",
    ]) {
      const rejected = runInstallerSourced(
        `if n1x_fastos_release_metadata_is_trusted "${metadata}"; then exit 9; fi`,
      );
      expect(rejected.result.status, `${metadata}: ${rejected.output}`).toBe(0);
    }
  });

  it("parses the FastOS name without executing marker text (#8574)", () => {
    const result = runInstallerSourced(`
marker=$'NAME="N1x FASTOS"\\nVERSION="1.23.0"\\nPAYLOAD="$(touch $HOME/n1x-marker-payload)"'
n1x_fastos_release_contents_are_valid "$marker"
[ ! -e "$HOME/n1x-marker-payload" ]
if n1x_fastos_release_contents_are_valid $'NAME="N1x FASTOS"\\nNAME="N1x FASTOS"'; then exit 9; fi
if n1x_fastos_release_contents_are_valid $'NAME=N1x FASTOS'; then exit 10; fi
if n1x_fastos_release_contents_are_valid $'NAME="N1x FASTOS"\\nNAME=N1x FASTOS'; then exit 11; fi
if n1x_fastos_release_contents_are_valid $'NAME="N1x FASTOS"\\nVERSION="1.23.0"\\r\\n'; then exit 12; fi
`);

    expect(result.result.status, result.output).toBe(0);
  });

  it("rejects a NUL byte before the FastOS marker enters a shell variable (#8574)", () => {
    const result = runInstallerSourced(`
marker="$HOME/n1x-fastos-with-nul"
printf 'NAME="N1x FASTOS"\\0\\n' >"$marker"
exec 9<"$marker"
n1x_opened_fastos_release_has_nul
status=$?
exec 9<&-
[ "$status" -eq 0 ]
`);

    expect(result.result.status, result.output).toBe(0);
  });

  it("accepts only the NVIDIA display PCI identity (#8574)", () => {
    const result = runInstallerSourced(`
n1x_pci_identity_is_valid 0x10DE 0x2E2A 0x030000
if n1x_pci_identity_is_valid 0x10de 0x2e2b 0x030000; then exit 9; fi
if n1x_pci_identity_is_valid 0x10de 0x2e2a 0x020000; then exit 10; fi
`);

    expect(result.result.status, result.output).toBe(0);
  });
});
