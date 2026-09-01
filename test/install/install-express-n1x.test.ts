// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runInstallerSourced } from "../helpers/installer-express-prompt-harness";
import { runExpressPromptWithTty } from "../helpers/installer-express-prompt-pty-harness";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

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

  it("stops before onboarding when the Deferred preview is declined (#8574)", () => {
    // Model curl | bash: stdin is the script pipe, while the reply reaches the controlling /dev/tty.
    const result = runExpressPromptWithTty("n\n", "pipe", "N1x");
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(output).toMatch(/N1x onboarding currently requires the Deferred managed-vLLM preview/);
    expect(output).toMatch(/accept the preview, or set NEMOCLAW_PROVIDER=install-vllm/);
    expect(output).not.toMatch(/Continuing with interactive flow/);
    expect(output).not.toMatch(/RESULT /);
  });

  it("rejects NEMOCLAW_NO_EXPRESS without explicit managed-vLLM intent (#8574)", () => {
    const result = runExpressPromptWithTty("", "pipe", "N1x", {
      NEMOCLAW_NO_EXPRESS: "1",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(output).toMatch(/explicit Deferred managed-vLLM preview intent/);
    expect(output).toMatch(/Remove NEMOCLAW_NO_EXPRESS=1 and accept the preview/);
    expect(output).toMatch(/set NEMOCLAW_PROVIDER=install-vllm/);
    expect(output).not.toMatch(/RESULT /);
  });

  it("allows the N1x prompt bypass with explicit managed-vLLM intent (#8574)", () => {
    const result = runExpressPromptWithTty("", "pipe", "N1x", {
      NEMOCLAW_NO_EXPRESS: "1",
      NEMOCLAW_PROVIDER: "install-vllm",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(/Skipping express prompt \(NEMOCLAW_NO_EXPRESS=1\)/);
    expect(output).toMatch(/RESULT .*PROVIDER=install-vllm/);
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

  it.each([
    ["exact marker", 'NAME="DGX SPARK FASTOS"\nVERSION="1.23.0"\n', "81a4:0:0:644:64:1:2", "file", "DGX Spark"],
    ["unquoted marker", "NAME=DGX SPARK FASTOS\n", "81a4:0:0:644:64:1:2", "file", ""],
    ["duplicate marker", 'NAME="DGX SPARK FASTOS"\nNAME="DGX SPARK FASTOS"\n', "81a4:0:0:644:64:1:2", "file", ""],
    ["unknown marker", 'NAME="OTHER FASTOS"\n', "81a4:0:0:644:64:1:2", "file", ""],
    ["non-root-owned marker", 'NAME="DGX SPARK FASTOS"\n', "81a4:1000:0:644:64:1:2", "file", ""],
    ["writable marker", 'NAME="DGX SPARK FASTOS"\n', "81a4:0:0:666:64:1:2", "file", ""],
    ["oversized marker", 'NAME="DGX SPARK FASTOS"\n'.padEnd(4097, "x"), "81a4:0:0:644:4097:1:2", "file", ""],
    ["linked marker", 'NAME="DGX SPARK FASTOS"\n', "81a4:0:0:644:64:1:2", "link", ""],
  ] as const)("routes an OEM FastOS marker only when trusted: %s (#10717)", (_scenario, contents, metadata, markerKind, expected) => {
    const result = runInstallerSourced(`
test_marker="$HOME/fastos-release"
test_target="$HOME/fastos-release-target"
printf '%s' "$MARKER_CONTENT" >"$test_target"
if [ "$MARKER_KIND" = "link" ]; then
  ln -s "$test_target" "$test_marker"
else
  cp "$test_target" "$test_marker"
fi
function [ {
  if [[ "$#" -eq 3 && "$1" = "-r" && "$2" = "/sys/class/dmi/id/product_name" && "$3" = "]" ]]; then
    return 0
  fi
  builtin [ "$@"
}
cat() {
  if [[ "$#" -eq 1 && "$1" = "/sys/class/dmi/id/product_name" ]]; then
    printf "OEM GB10 system"
    return
  fi
  command cat "$@"
}
stat() { printf '%s' "$MARKER_METADATA"; }
is_wsl_host() { return 1; }
n1x_fastos_release_path() { printf '%s' "$test_marker"; }
detect_express_platform
`, { MARKER_CONTENT: contents, MARKER_KIND: markerKind, MARKER_METADATA: metadata });

    expect(result.result.stdout).toBe(expected);
  });

  it("preserves harness-owned environment paths", () => {
    const result = runInstallerSourced(
      `printf '%s\n%s\n%s\n' "$HOME" "$PATH" "$INSTALLER_UNDER_TEST"`,
      { HOME: "/forbidden", PATH: "/forbidden", INSTALLER_UNDER_TEST: "/forbidden" },
    );

    expect(result.result.status, result.output).toBe(0);
    expect(result.result.stdout).toBe(
      `${result.home}\n${TEST_SYSTEM_PATH}\n${INSTALLER_PAYLOAD}\n`,
    );
  });

  it.each([
    "a1ff:0:0:777:24:1:2",
    "81a4:1000:0:644:116:1:2",
    "81a4:0:1000:644:116:1:2",
    "81b6:0:0:666:116:1:2",
    "81a4:0:0:644:4097:1:2",
  ])("validates bounded root-owned FastOS metadata [%s] (#8574)", (metadata) => {
    const accepted = runInstallerSourced(
      `n1x_fastos_release_metadata_is_trusted "81a4:0:0:644:116:1:2"`,
    );
    expect(accepted.result.status, accepted.output).toBe(0);

    const rejected = runInstallerSourced(
      `if n1x_fastos_release_metadata_is_trusted "${metadata}"; then exit 9; fi`,
    );
    expect(rejected.result.status, `${metadata}: ${rejected.output}`).toBe(0);
  });

  it("collects numeric FastOS metadata under a non-C locale (#8574)", () => {
    const result = runInstallerSourced(`
test_marker="$HOME/n1x-fastos-release"
printf 'NAME="N1x FASTOS"\\n' >"$test_marker"
n1x_fastos_release_path() { printf "%s" "$test_marker"; }
stat() {
  [ "\${LC_ALL:-}" = "de_DE.UTF-8" ] || return 96
  [ "\${2:-}" = '%f:%u:%g:%a:%s:%d:%i' ] || return 97
  case "\${1:-}:\${3:-}" in
    -c:"$test_marker"|-Lc:/proc/self/fd/*) ;;
    *) return 98 ;;
  esac
  printf '81a4:0:0:644:18:1:2'
}
LC_ALL=de_DE.UTF-8 n1x_fastos_release_is_trusted
`);

    expect(result.result.status, result.output).toBe(0);
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

  it("accepts an NVIDIA display device without pinning its PCI device ID (#10076)", () => {
    const result = runInstallerSourced(`
test_pci_root="$HOME/n1x-pci"
mkdir -p "$test_pci_root/000f:01:00.0"
printf '0x10de\n' >"$test_pci_root/000f:01:00.0/vendor"
printf '0x030000\n' >"$test_pci_root/000f:01:00.0/class"
n1x_pci_devices_path() { printf "%s" "$test_pci_root"; }
n1x_has_pci_gpu || exit 8
if n1x_pci_identity_is_valid 0x1234 0x030000; then exit 9; fi
if n1x_pci_identity_is_valid 0x10de 0x020000; then exit 10; fi
`);

    expect(result.result.status, result.output).toBe(0);
  });
});
