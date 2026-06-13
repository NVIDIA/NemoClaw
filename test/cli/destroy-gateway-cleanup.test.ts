// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithEnv, testTimeoutOptions } from "./helpers";

describe("CLI dispatch", () => {
  it("preserves the gateway runtime by default when the last sandbox is destroyed (#2166)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy -y", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const openshellOutput = fs.readFileSync(openshellLog, "utf8");
    expect(openshellOutput).toContain("sandbox delete alpha");
    expect(openshellOutput).toContain("NAME STATUS");
    // Gateway preservation is now the default. `--yes` confirms only the
    // sandbox; the shared NemoClaw gateway must stay up so the next
    // `nemoclaw onboard` reuses it.
    expect(openshellOutput).not.toContain("forward stop 18789");
    expect(openshellOutput).not.toContain("gateway destroy -g nemoclaw");
    expect(openshellOutput).not.toContain("gateway remove nemoclaw");
    expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
  });

  it(
    "tears down the gateway runtime when --cleanup-gateway is passed (#2166)",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-cleanup-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const openshellLog = path.join(home, "openshell.log");
      const bashLog = path.join(home, "docker.log");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
              gatewayName: "nemoclaw-8081",
              gatewayPort: 8081,
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          `log_file=${JSON.stringify(openshellLog)}`,
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "NAME STATUS\\n" >> "$log_file"',
          "  exit 0",
          "fi",
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "docker"),
        [
          "#!/bin/sh",
          `log_file=${JSON.stringify(bashLog)}`,
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const r = runWithEnv(
        "alpha destroy -y --cleanup-gateway",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        30_000,
      );

      expect(r.code, r.out).toBe(0);
      const openshellOutput = fs.readFileSync(openshellLog, "utf8");
      expect(openshellOutput).toContain("sandbox delete alpha");
      expect(openshellOutput).toContain("forward stop 18789");
      expect(openshellOutput).toContain(
        process.platform === "linux"
          ? "gateway remove nemoclaw-8081"
          : "gateway destroy -g nemoclaw-8081",
      );
      expect(fs.readFileSync(bashLog, "utf8")).toContain(
        "volume ls -q --filter name=openshell-cluster-nemoclaw-8081",
      );
    },
  );

  it(
    "honours NEMOCLAW_CLEANUP_GATEWAY=1 as the env-driven opt-in (#2166)",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-env-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const openshellLog = path.join(home, "openshell.log");
      const bashLog = path.join(home, "docker.log");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          `log_file=${JSON.stringify(openshellLog)}`,
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "NAME STATUS\\n" >> "$log_file"',
          "  exit 0",
          "fi",
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "docker"),
        [
          "#!/bin/sh",
          `log_file=${JSON.stringify(bashLog)}`,
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const r = runWithEnv(
        "alpha destroy -y",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          NEMOCLAW_CLEANUP_GATEWAY: "1",
        },
        30_000,
      );

      expect(r.code, r.out).toBe(0);
      const openshellOutput = fs.readFileSync(openshellLog, "utf8");
      expect(openshellOutput).toContain("forward stop 18789");
      expect(openshellOutput).toContain(
        process.platform === "linux" ? "gateway remove nemoclaw" : "gateway destroy -g nemoclaw",
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "clears only the per-port host gateway PID file when destroying nemoclaw-<port>",
    testTimeoutOptions(30_000),
    () => {
      // A `nemoclaw-8081` sandbox's destroy must read and clear its own
      // `openshell-docker-gateway-8081/openshell-gateway.pid`, NOT the default
      // instance's `openshell-docker-gateway/openshell-gateway.pid`. Otherwise
      // destroying a non-default sandbox tears down the default instance's
      // tracked host gateway process.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-perport-pid-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const defaultStateDir = path.join(home, ".local/state/nemoclaw/openshell-docker-gateway");
      const perPortStateDir = path.join(
        home,
        ".local/state/nemoclaw/openshell-docker-gateway-8081",
      );
      const defaultPidFile = path.join(defaultStateDir, "openshell-gateway.pid");
      const perPortPidFile = path.join(perPortStateDir, "openshell-gateway.pid");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.mkdirSync(defaultStateDir, { recursive: true });
      fs.mkdirSync(perPortStateDir, { recursive: true });
      // PIDs that are guaranteed to be dead so stopHostGatewayProcesses takes
      // the clearRuntimeFiles branch without trying to kill anything.
      fs.writeFileSync(defaultPidFile, "999998\n");
      fs.writeFileSync(perPortPidFile, "999999\n");
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
              gatewayName: "nemoclaw-8081",
              gatewayPort: 8081,
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "NAME STATUS\\n"',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(localBin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const r = runWithEnv(
        "alpha destroy -y --cleanup-gateway",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        30_000,
      );

      expect(r.code, r.out).toBe(0);
      expect(fs.existsSync(perPortPidFile)).toBe(false);
      expect(fs.existsSync(defaultPidFile)).toBe(true);
      expect(fs.readFileSync(defaultPidFile, "utf8").trim()).toBe("999998");
    },
  );

  it("keeps the gateway runtime when other sandboxes still exist", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
            gatewayName: "nemoclaw-8081",
            gatewayPort: 8081,
          },
          beta: {
            name: "beta",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nbeta Ready\\n" >> "$log_file"',
        '  printf "NAME STATUS\\nbeta Ready\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway remove nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
    }
  });

  it("keeps the gateway runtime when the live gateway still reports sandboxes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-live-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nbeta Ready\\n" >> "$log_file"',
        '  printf "NAME STATUS\\nbeta Ready\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("beta Ready");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway remove nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
    }
  });

  it("selects the sandbox persisted gateway before provider cleanup and delete", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-select-gateway-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const activeGateway = path.join(home, "active-gateway");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(activeGateway, "other-gateway\n");
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
            gatewayName: "nemoclaw-8081",
            gatewayPort: 8081,
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        `active_gateway=${JSON.stringify(activeGateway)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        'if [ "$1" = "gateway" ] && [ "$2" = "select" ]; then',
        '  printf "%s\\n" "$3" > "$active_gateway"',
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  active="$(cat "$active_gateway")"',
        '  if [ "$active" != "nemoclaw-8081" ]; then',
        '    printf "wrong gateway: %s\\n" "$active" >&2',
        "    exit 42",
        "  fi",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  active="$(cat "$active_gateway")"',
        '  if [ "$active" != "nemoclaw-8081" ]; then',
        '    printf "wrong list gateway: %s\\n" "$active" >&2',
        "    exit 43",
        "  fi",
        '  printf "NAME STATUS\\n"',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code, r.out).toBe(0);
    const lines = fs.readFileSync(openshellLog, "utf8").trim().split("\n");
    const selectIndex = lines.indexOf("gateway select nemoclaw-8081");
    const deleteIndex = lines.indexOf("sandbox delete alpha");
    expect(selectIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(selectIndex);
    expect(lines.slice(deleteIndex + 1)).toContain("sandbox list");
  });

  it("fails destroy when openshell sandbox delete returns a real error", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-failure-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  echo "transport error: gateway unavailable" >&2',
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("transport error: gateway unavailable");
    expect(r.out).toContain("Failed to destroy sandbox 'alpha'.");
    expect(r.out).not.toContain("Sandbox 'alpha' destroyed");

    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
    );
    expect(registryAfter.sandboxes.alpha).toBeTruthy();
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway remove nemoclaw");
  });

  it("treats an already-missing sandbox as destroyed and clears the stale registry entry", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-missing-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  printf \'%s\\n\' "$*" >> "$log_file"',
        '  echo "Error: status: Not Found, message: \\"sandbox not found\\"" >&2',
        "  exit 1",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        '  printf "NAME STATUS\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("already absent from the live gateway");
    expect(r.out).toContain("Sandbox 'alpha' destroyed");

    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
    );
    expect(registryAfter.sandboxes.alpha).toBeFalsy();
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
  });

  it("deletes messaging providers when destroying a sandbox", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-providers-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const log = fs.readFileSync(openshellLog, "utf8");
    expect(log).toContain("provider delete alpha-telegram-bridge");
    expect(log).toContain("provider delete alpha-discord-bridge");
    expect(log).toContain("provider delete alpha-slack-bridge");
    expect(log).toContain("provider delete alpha-slack-app");
  });
});
