// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    }: { dockerInfoOk: boolean; phase?: string; driver?: string },
  ): { home: string; localBin: string; env: Record<string, string> } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    // The Docker-outage reclassification only applies to Docker-driver
    // sandboxes (#4428); record the driver so the gate matches.
    writeSandboxRegistry(home, "v053-baseline", {
      policies: ["npm"],
      openshellDriver: driver,
    } as unknown as Partial<SandboxEntry>);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
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
      ? 'echo "24.0.0"; exit 0'
      : 'echo "Cannot connect to the Docker daemon" >&2; exit 1';
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
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
      home,
      localBin,
      env: { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` },
    };
  }

  const DOCKER_DOWN_HEADER = "docker_unreachable";
  const DOCKER_DOWN_HINT = "Start the Docker daemon";

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
