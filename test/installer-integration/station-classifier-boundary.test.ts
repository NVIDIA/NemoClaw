// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseStationDiscoveryHost } from "../../scripts/lib/dgx-station-peer.mts";
import {
  STATION_DISCOVERY_PROBE,
  stationPrepSshArgs,
} from "../../scripts/prepare-dual-dgx-station.mts";
import { strictVllmSshTransportArgs } from "../../src/lib/inference/serving/vllm-ssh-transport-policy.ts";
import { sshBinding } from "../helpers/dgx-station-peer-fixture";
import { runInstallerSourced } from "../helpers/installer-express-prompt-harness";

describe("Station classifier process boundaries", () => {
  it("documents validation-only Station mode in public bootstrap help", () => {
    const result = spawnSync(
      "bash",
      [path.resolve(import.meta.dirname, "../../install.sh"), "--help"],
      {
        encoding: "utf8",
        timeout: 5000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/--force-station-install.*without onboarding/);
  });

  it.each([
    ["preflight_explicit_express_flags", "STATION_DEEPSEEK"],
    ["preflight_explicit_express_flags", "NEMOCLAW_VLLM_MODEL"],
    ["preflight_explicit_express_flags", "NEMOCLAW_MODEL"],
    ["maybe_offer_express_install", "STATION_DEEPSEEK"],
    ["maybe_offer_express_install", "NEMOCLAW_VLLM_MODEL"],
    ["maybe_offer_express_install", "NEMOCLAW_MODEL"],
  ])("%s rejects %s in validation-only mode", (entrypoint, override) => {
    const { home, result, output } = runInstallerSourced(
      `
classify_dgx_station_hardware() { printf station-gb300; }
classify_dgx_station_release() { printf unsupported-dgx-os; }
express_prompt_can_read_tty() { return 0; }
${entrypoint}
printf continued
`,
      {
        FORCE_STATION_INSTALL: "1",
        [override]: override === "STATION_DEEPSEEK" ? "1" : "example/model",
      },
    );
    try {
      expect(result.status, output).toBe(1);
      expect(output).toContain("validation-only");
      expect(output).not.toContain("continued");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("pins the Station preparation endpoint after the strict SSH policy (#9519)", () => {
    const args = stationPrepSshArgs(sshBinding(), "/tmp/nemoclaw-known-hosts", "python3 -");
    expect(args).toEqual([
      ...strictVllmSshTransportArgs(),
      "-o",
      "UserKnownHostsFile=/tmp/nemoclaw-known-hosts",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "HostKeyAlias=10.10.0.2",
      "--",
      "10.10.0.2",
      "python3 -",
    ]);
  });

  it.each([
    ["preflight_explicit_express_flags", "--classify-station-hardware"],
    ["preflight_explicit_express_flags", "--classify-dgx-release"],
    ["maybe_offer_express_install", "--classify-station-hardware"],
    ["maybe_offer_express_install", "--classify-dgx-release"],
  ])("stops %s when the %s helper fails", (entrypoint, failingMode) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-classifier-failure-"));
    try {
      fs.writeFileSync(
        path.join(fixture, "prepare-dgx-station-host.sh"),
        '#!/bin/bash\nif [ "$1" = "$FAILING_MODE" ]; then exit 42; fi\nprintf station-gb300\n',
      );
      const { home, result, output } = runInstallerSourced(
        `
SCRIPT_DIR="$HELPER_DIR"
is_wsl_host() { return 1; }
validate_express_platform_boundary() { touch "$HELPER_DIR/boundary-reached"; }
${entrypoint}
touch "$HELPER_DIR/continued"
`,
        { HELPER_DIR: fixture, FAILING_MODE: failingMode },
      );
      try {
        expect(result.status, output).not.toBe(0);
        expect(fs.existsSync(path.join(fixture, "boundary-reached"))).toBe(false);
        expect(fs.existsSync(path.join(fixture, "continued"))).toBe(false);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each([
    ["station-gb300", "DGX Station"],
    ["conflicting", "Conflicting NVIDIA firmware identity"],
    ["not-station", ""],
  ])("routes the helper's %s result to %s", (hardware, platform) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-classifier-result-"));
    try {
      fs.writeFileSync(
        path.join(fixture, "prepare-dgx-station-host.sh"),
        `#!/bin/bash
printf '%s\\n' "$1" >>"$HELPER_DIR/calls"
case "$1" in
  --classify-station-hardware) printf '%s' "$HARDWARE" ;;
  --classify-dgx-release) printf supported-dgx-os ;;
  *) exit 42 ;;
esac
`,
      );
      const { home, result, output } = runInstallerSourced(
        `
SCRIPT_DIR="$HELPER_DIR"
is_wsl_host() { return 1; }
spark_fastos_release_is_trusted() { return 1; }
is_n1x_host() { return 1; }
detect_express_platform
`,
        { HELPER_DIR: fixture, HARDWARE: hardware },
      );
      try {
        expect(result.status, output).toBe(0);
        expect(result.stdout).toBe(platform);
        expect(fs.readFileSync(path.join(fixture, "calls"), "utf8").trim().split("\n")).toEqual(
          hardware === "station-gb300"
            ? ["--classify-station-hardware", "--classify-dgx-release"]
            : ["--classify-station-hardware"],
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("produces a discovery payload accepted by the pair consumer", () => {
    const result = spawnSync("python3", ["-"], {
      input: STATION_DISCOVERY_PROBE,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(parseStationDiscoveryHost(payload)).toEqual(payload);
  });
});
