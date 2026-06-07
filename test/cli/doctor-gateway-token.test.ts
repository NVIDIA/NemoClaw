// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createCloudflaredServiceDir,
  createDoctorTestSetup,
  runWithEnv,
  testTimeoutOptions,
  writeSandboxRegistry,
} from "./helpers";

describe("CLI dispatch", () => {
  it("gateway-token help uses native oclif usage", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-token-help-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha gateway-token --help", { HOME: home });

    expect(r.code).toBe(0);
    expect(r.out).toContain("$ nemoclaw sandbox gateway token <name> [--quiet|-q]");
    expect(r.out).toContain("Print the OpenClaw gateway auth token");
  });

  it("doctor fails a present sandbox that is not Ready", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-not-ready-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "sandbox list") printf "NAME STATUS\\nalpha Creating\\n"; exit 0 ;;',
      '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
      "esac",
    ]);

    const r = setup.runDoctor();

    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as {
      checks: Array<{ label: string; status: string; detail: string }>;
    };
    const liveSandbox = report.checks.find((check) => check.label === "Live sandbox");
    expect(liveSandbox).toEqual(
      expect.objectContaining({
        status: "fail",
        detail: expect.stringContaining("Creating"),
      }),
    );
  });

  it("doctor does not inspect the legacy k3s gateway container in Docker-driver mode", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-docker-driver-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "sandbox list") printf "NAME STATUS\\nalpha Ready\\n"; exit 0 ;;',
      '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
      "esac",
    ]);
    // Docker-driver sandbox: no legacy `openshell-cluster-*` container exists.
    writeSandboxRegistry(setup.home, "alpha", { openshellDriver: "docker" });
    // Record docker argv and make `docker inspect` fail like an absent legacy
    // container would. The doctor must not even attempt the inspect, so this
    // should never produce a failure — and we assert the call was skipped, not
    // merely that its failure was tolerated.
    const dockerCalls = path.join(setup.home, "docker-calls");
    fs.writeFileSync(
      path.join(setup.localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(dockerCalls)}`,
        'if [ "$1" = "info" ]; then echo "24.0.0"; exit 0; fi',
        'if [ "$1" = "inspect" ]; then echo "Error: No such object: $3" >&2; exit 1; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    // Healthy curl so the unrelated provider-health probe does not fail the
    // report and mask the gateway-only assertions below.
    fs.writeFileSync(
      path.join(setup.localBin, "curl"),
      ["#!/usr/bin/env bash", 'echo "{}"', "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const r = setup.runDoctor("alpha doctor --json");

    expect(r.out).not.toContain("openshell-cluster");
    const report = JSON.parse(r.out) as {
      status: string;
      checks: Array<{ group: string; label: string; status: string; detail: string }>;
    };
    expect(report.checks.find((check) => check.label === "Docker container")).toBeUndefined();
    // Core contract: the legacy k3s container inspect must be skipped entirely,
    // not attempted-and-ignored.
    const recordedDockerCalls = fs.existsSync(dockerCalls)
      ? fs.readFileSync(dockerCalls, "utf8")
      : "";
    expect(recordedDockerCalls).not.toMatch(/\binspect\b/);
    const openshellStatus = report.checks.find((check) => check.label === "OpenShell status");
    expect(openshellStatus).toEqual(
      expect.objectContaining({ group: "Gateway", status: "ok", detail: "connected to nemoclaw" }),
    );
    // The Docker-driver gateway is healthy, so no Gateway check should fail.
    expect(report.checks.filter((c) => c.group === "Gateway" && c.status === "fail")).toEqual([]);
    expect(report.status).toBe("ok");
    expect(r.code).toBe(0);
  });

  it("doctor still inspects the legacy k3s gateway container for the kubernetes driver", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-k8s-driver-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "sandbox list") printf "NAME STATUS\\nalpha Ready\\n"; exit 0 ;;',
      '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
      "esac",
    ]);
    writeSandboxRegistry(setup.home, "alpha", { openshellDriver: "kubernetes" });

    const r = setup.runDoctor("alpha doctor --json");

    const report = JSON.parse(r.out) as {
      checks: Array<{ group: string; label: string; status: string; detail: string }>;
    };
    const dockerContainer = report.checks.find((check) => check.label === "Docker container");
    expect(dockerContainer).toEqual(
      expect.objectContaining({
        group: "Gateway",
        status: "ok",
        detail: expect.stringContaining("openshell-cluster-nemoclaw"),
      }),
    );
  });

  it(
    "doctor reports fresh shields state as not configured instead of down",
    testTimeoutOptions(30_000),
    () => {
      const setup = createDoctorTestSetup("nemoclaw-cli-doctor-shields-default-", [
        'case "$*" in',
        '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        '  "sandbox list") printf "NAME STATUS\\nalpha Ready\\n"; exit 0 ;;',
        '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        "esac",
      ]);

      const r = setup.runDoctor("alpha doctor --json");

      const report = JSON.parse(r.out) as {
        checks: Array<{ label: string; status: string; detail: string; hint?: string }>;
      };
      const shields = report.checks.find((check) => check.label === "Shields");
      expect(shields).toEqual(
        expect.objectContaining({
          status: "info",
          detail: "not configured (default mutable state)",
        }),
      );
      expect(shields?.detail).not.toBe("down");
    },
  );

  it("doctor does not query sandbox state from a different active gateway", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-wrong-gateway-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: other\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "gateway select nemoclaw") exit 1 ;;',
      '  "gateway start --name nemoclaw --port 8080") exit 1 ;;',
      '  "sandbox list") echo "queried wrong gateway sandbox list" >> "$marker_file"; exit 0 ;;',
      "esac",
    ]);

    const r = setup.runDoctor("alpha doctor");

    expect(r.code).toBe(1);
    expect(r.out).toContain("OpenShell status");
    expect(r.out).toContain("Gateway: other");
    expect(setup.readCalls().some((call) => /^sandbox list(\s|$)/.test(call))).toBe(false);
  });

  it("doctor treats a live non-cloudflared PID as stale", () => {
    const { sandboxName, serviceDir } = createCloudflaredServiceDir("doctorpid-");
    const setup = createDoctorTestSetup(
      "nemoclaw-cli-doctor-wrong-cloudflared-pid-",
      [
        'case "$*" in',
        '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        `  "sandbox list") printf "NAME STATUS\\n${sandboxName} Ready\\n"; exit 0 ;;`,
        '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        "esac",
      ],
      sandboxName,
    );
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const sleeperPid = sleeper.pid;
    if (typeof sleeperPid !== "number") {
      throw new Error("expected spawned helper process to have a PID");
    }

    try {
      fs.writeFileSync(path.join(serviceDir, "cloudflared.pid"), String(sleeperPid));
      const r = setup.runDoctor(`${sandboxName} doctor --json`);

      const report = JSON.parse(r.out) as {
        checks: Array<{ label: string; status: string; detail: string }>;
      };
      const cloudflared = report.checks.find((check) => check.label === "cloudflared");
      expect(cloudflared).toEqual(
        expect.objectContaining({
          status: "warn",
          detail: `stale PID ${sleeperPid}`,
        }),
      );
    } finally {
      sleeper.kill();
      fs.rmSync(serviceDir, { recursive: true, force: true });
    }
  });

  it("doctor accepts a live cloudflared PID", testTimeoutOptions(35_000), () => {
    const { sandboxName, serviceDir } = createCloudflaredServiceDir("doctorcloudflared-");
    const setup = createDoctorTestSetup(
      "nemoclaw-cli-doctor-cloudflared-pid-",
      [
        'case "$*" in',
        '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        `  "sandbox list") printf "NAME STATUS\\n${sandboxName} Ready\\n"; exit 0 ;;`,
        '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        "esac",
      ],
      sandboxName,
    );
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-shim-"));
    const cloudflaredBin = path.join(shimDir, "cloudflared");
    fs.symlinkSync(process.execPath, cloudflaredBin);
    const sleeper = spawn(cloudflaredBin, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const sleeperPid = sleeper.pid;
    if (typeof sleeperPid !== "number") {
      throw new Error("expected spawned helper process to have a PID");
    }

    try {
      fs.writeFileSync(path.join(serviceDir, "cloudflared.pid"), String(sleeperPid));
      const r = setup.runDoctor(`${sandboxName} doctor --json`);

      const report = JSON.parse(r.out) as {
        checks: Array<{ label: string; status: string; detail: string }>;
      };
      const cloudflared = report.checks.find((check) => check.label === "cloudflared");
      expect(cloudflared).toEqual(
        expect.objectContaining({
          status: "ok",
          detail: `running (PID ${sleeperPid})`,
        }),
      );
    } finally {
      sleeper.kill();
      fs.rmSync(serviceDir, { recursive: true, force: true });
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

});
