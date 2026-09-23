// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchReadinessRegistryFixture } from "../helpers/launch-readiness-fixture";
import { runWithEnv, testTimeout, writeSandboxRegistry } from "./helpers";
import type { SandboxEntry } from "./helpers";

describe("Docker daemon outage classification (#4428)", () => {
  // Build a fake runtime where OpenShell still reports a present sandbox in a
  // non-ready phase (the reporter's case: cached/transitional state) while the
  // Docker daemon is down. `dockerInfoOk` flips between the outage repro and
  // the genuine-startup-failure control case.
  function setupDockerOutageEnv(
    prefix: string,
    {
      dockerInfoOk,
      phase = "Provisioning",
      driver = "docker",
      logCalls = false,
      dockerInfoError = "Cannot connect to the Docker daemon",
    }: {
      dockerInfoOk: boolean;
      phase?: string;
      driver?: string;
      logCalls?: boolean;
      dockerInfoError?: string;
    },
  ): { callLog: string; home: string; localBin: string; env: Record<string, string> } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const localBin = path.join(home, "bin");
    const callLog = path.join(home, "runtime-calls.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(callLog, "");
    // The Docker-outage reclassification only applies to Docker-driver
    // sandboxes (#4428); record the driver so the gate matches.
    writeSandboxRegistry(home, "v053-baseline", {
      ...launchReadinessRegistryFixture(),
      openshellDriver: driver,
    } as unknown as Partial<SandboxEntry>);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        logCalls ? `printf 'openshell:%s\\n' "$*" >> ${JSON.stringify(callLog)}` : "",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then',
        `  printf "Name: v053-baseline\\nPhase: ${phase}\\nPolicy:\\n"`,
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        `  printf "NAME             STATUS\\nv053-baseline    ${phase}\\n"`,
        "  exit 0",
        "fi",
        // policy get fails so getGatewayPresets() returns null (gateway not
        // queryable), exercising the policy-list reclassification branch.
        'if [ "$1" = "policy" ] && [ "$2" = "get" ]; then exit 1; fi',
        'if [ "$1" = "status" ]; then printf "Gateway: nemoclaw\\nStatus: Connected\\n"; exit 0; fi',
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then echo "Gateway: nemoclaw"; exit 0; fi',
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then exit 1; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const dockerInfoBody = dockerInfoOk
      ? 'echo \'{"ServerVersion":"24.0.0"}\'; exit 0'
      : `printf '%s\\n' '${dockerInfoError.replaceAll("'", "'\\''")}' >&2; exit 1`;
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        logCalls ? `printf 'docker:%s\\n' "$*" >> ${JSON.stringify(callLog)}` : "",
        `if [ "$1" = "info" ]; then ${dockerInfoBody}; fi`,
        // ps lists nothing so the classifier never claims a running container.
        'if [ "$1" = "ps" ]; then exit 0; fi',
        dockerInfoOk ? "exit 0" : "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "sleep"), ["#!/usr/bin/env bash", "exit 0"].join("\n"), {
      mode: 0o755,
    });
    return {
      callLog,
      home,
      localBin,
      env: { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` },
    };
  }

  const DOCKER_DOWN_HEADER = "docker_unreachable";
  const DOCKER_DOWN_HINT = "Run `docker info` to inspect the error";

  it("status names the Docker outage instead of stuck-phase rebuild guidance", () => {
    const { home, env } = setupDockerOutageEnv("nemoclaw-cli-4428-status-down-", {
      dockerInfoOk: false,
    });
    try {
      const r = runWithEnv("v053-baseline status", env);
      expect(r.code).toBe(1);
      expect(r.out).toContain(DOCKER_DOWN_HEADER);
      expect(r.out).toContain("Docker daemon is not reachable");
      expect(r.out).toContain(DOCKER_DOWN_HINT);
      // Must NOT steer the user toward rebuild for a transient daemon outage.
      expect(r.out).not.toContain("is stuck in 'Provisioning' phase");
      expect(r.out).not.toMatch(/rebuild --yes/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("status keeps stuck-phase rebuild guidance when Docker is reachable", () => {
    const { home, env } = setupDockerOutageEnv("nemoclaw-cli-4428-status-up-", {
      dockerInfoOk: true,
    });
    try {
      const r = runWithEnv("v053-baseline status", env);
      // Genuine startup failure: Docker is fine, sandbox is wedged Provisioning.
      expect(r.out).toContain("is stuck in 'Provisioning' phase");
      expect(r.out).toContain("rebuild --yes");
      expect(r.out).not.toContain(DOCKER_DOWN_HEADER);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("status keeps a terminal phase failure visible even when Docker is down", () => {
    // A settled Failed phase is a real sandbox failure; the Docker-outage
    // reclassification must not mask it (#4428 review).
    const { home, env } = setupDockerOutageEnv("nemoclaw-cli-4428-status-failed-down-", {
      dockerInfoOk: false,
      phase: "Failed",
    });
    try {
      const r = runWithEnv("v053-baseline status", env);
      expect(r.out).toContain("is stuck in 'Failed' phase");
      expect(r.out).toContain("rebuild --yes");
      expect(r.out).not.toContain(DOCKER_DOWN_HEADER);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it(
    "connect fails fast with Docker outage guidance instead of waiting out the readiness timeout",
    () => {
      const { home, env } = setupDockerOutageEnv("nemoclaw-cli-4428-connect-down-", {
        dockerInfoOk: false,
      });
      try {
        const startedAt = Date.now();
        // A large connect timeout would be burned entirely pre-fix; the fast
        // path must return well before it.
        const r = runWithEnv("v053-baseline connect", { ...env, NEMOCLAW_CONNECT_TIMEOUT: "120" });
        const elapsedMs = Date.now() - startedAt;
        expect(r.code).toBe(1);
        expect(r.out).toContain(DOCKER_DOWN_HEADER);
        expect(r.out).toContain(DOCKER_DOWN_HINT);
        expect(r.out).not.toContain("Waiting for sandbox");
        expect(r.out).not.toContain("Timed out after");
        expect(elapsedMs).toBeLessThan(30_000);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    testTimeout(40_000),
  );

  it("connect --probe-only also surfaces the Docker outage instead of an opaque probe failure", () => {
    const { home, env } = setupDockerOutageEnv("nemoclaw-cli-4428-probe-down-", {
      dockerInfoOk: false,
    });
    try {
      const r = runWithEnv("v053-baseline connect --probe-only", env);
      expect(r.code).toBe(1);
      expect(r.out).toContain(DOCKER_DOWN_HEADER);
      expect(r.out).toContain(DOCKER_DOWN_HINT);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("start preserves the sandbox when its owning gateway cannot be loaded (#11715)", () => {
    const { callLog, home, env } = setupDockerOutageEnv("nemoclaw-cli-11715-start-down-", {
      dockerInfoOk: false,
      logCalls: true,
    });
    const registryFile = path.join(home, ".nemoclaw", "sandboxes.json");
    const registryBefore = fs.readFileSync(registryFile, "utf8");
    try {
      const r = runWithEnv("v053-baseline start", env);
      expect(r.code).toBe(1);
      expect(r.out).toContain("OpenShell could not start sandbox");
      expect(r.out).toContain("Sandbox state is unverified");
      expect(r.out).toContain("Preserve the sandbox; do not rebuild, destroy, or re-onboard");
      expect(r.out).toContain("Run `docker info` on the owning gateway's host");
      expect(r.out).toContain("v053-baseline status` before retrying");
      expect(r.out).not.toContain(DOCKER_DOWN_HEADER);
      expect(r.out).not.toContain("v053-baseline rebuild");
      expect(fs.readFileSync(registryFile, "utf8")).toBe(registryBefore);
      // CLI capability discovery may read Docker's version, but lifecycle has no engine fallback.
      const calls = fs.readFileSync(callLog, "utf8");
      expect(calls).not.toMatch(/^docker:(?!version(?:\s|$))/mu);
      expect(calls).not.toMatch(
        /^openshell:sandbox (?:start|stop|recover|restart|delete)(?:\s|$)/mu,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    "permission denied while connecting to the Docker socket",
    "context missing: context not found",
    "TLS certificate verification failed",
  ])("status requires Docker diagnosis before remediation for %s", (dockerInfoError) => {
    const { callLog, home, env } = setupDockerOutageEnv("nemoclaw-cli-11715-access-", {
      dockerInfoOk: false,
      dockerInfoError,
      logCalls: true,
    });
    try {
      const r = runWithEnv("v053-baseline status", env);
      expect(r.code).toBe(1);
      expect(r.out).toContain(DOCKER_DOWN_HEADER);
      expect(r.out).toContain(DOCKER_DOWN_HINT);
      expect(r.out).toContain("If the daemon is stopped");
      expect(r.out).toContain("For permission denied");
      expect(r.out).toContain("For context or TLS errors");
      expect(r.out).not.toContain("Start the Docker daemon");
      expect(r.out).not.toContain("Docker runtime outage");
      const calls = fs.readFileSync(callLog, "utf8");
      expect(calls).not.toMatch(/^docker:(?:start|stop|restart|rm|kill|unpause|pause)(?:\s|$)/mu);
      expect(calls).not.toMatch(/^openshell:sandbox (?:start|recover|restart)(?:\s|$)/mu);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("logs names the Docker outage as the unavailable runtime layer", () => {
    const { home, env } = setupDockerOutageEnv("nemoclaw-cli-4428-logs-down-", {
      dockerInfoOk: false,
    });
    try {
      const r = runWithEnv("v053-baseline logs", env);
      expect(r.code).toBe(1);
      expect(r.out).toContain(DOCKER_DOWN_HEADER);
      expect(r.out).toContain(DOCKER_DOWN_HINT);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("policy-list reports the Docker outage instead of a local-state-only warning", () => {
    const { home, env } = setupDockerOutageEnv("nemoclaw-cli-4428-policy-down-", {
      dockerInfoOk: false,
    });
    try {
      const r = runWithEnv("v053-baseline policy-list", env);
      expect(r.out).toContain(DOCKER_DOWN_HEADER);
      expect(r.out).toContain(DOCKER_DOWN_HINT);
      expect(r.out).not.toContain("Could not query gateway — showing local state only");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not misclassify a non-Docker (vm) driver sandbox as a Docker outage", () => {
    // A failing local `docker info` is normal for vm/kubernetes drivers; status
    // must fall through to the existing stuck-phase guidance, not the
    // Docker-outage block (#4428 review).
    const { home, env } = setupDockerOutageEnv("nemoclaw-cli-4428-vm-down-", {
      dockerInfoOk: false,
      driver: "vm",
    });
    try {
      const r = runWithEnv("v053-baseline status", env);
      expect(r.out).not.toContain(DOCKER_DOWN_HEADER);
      expect(r.out).toContain("is stuck in 'Provisioning' phase");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
