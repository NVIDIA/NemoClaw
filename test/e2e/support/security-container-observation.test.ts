// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { observeSecurityContainerPair } from "../fixtures/security-posture-containers.ts";
import { OPENSHELL_V015_QUALIFICATION } from "../fixtures/openshell-v0116-qualification.ts";

const WORKLOAD = "a".repeat(64);
const SUPERVISOR = "b".repeat(64);
const IMAGE = "c".repeat(64);

function harness(provider = "docker") {
  const common = {
    running: true,
    paused: false,
    pid: 100,
    startedAt: "2026-10-15T00:00:00Z",
    privileged: false,
    capAdd: null,
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges:true"],
    name: "sandbox",
    sandboxId: "sandbox-id",
    namespace: "",
    managed: provider === "docker" ? "openshell" : "true",
    effectiveCaps: null,
    boundingCaps: null,
  };
  const workload: Record<string, unknown> = {
    ...common,
    id: WORKLOAD,
    image: `sha256:${"d".repeat(64)}`,
    user: "998:999",
    role: "sandbox",
    entrypoint: [
      provider === "docker"
        ? "/.openshell/runtime/openshell-sandbox"
        : "/opt/openshell/bin/openshell-sandbox",
    ],
    command: ["--bootstrap", "/.openshell/channel/sandbox/bootstrap.json"],
    network: "none",
    readonlyRootfs: false,
  };
  const supervisor: Record<string, unknown> = {
    ...common,
    id: SUPERVISOR,
    image: `sha256:${IMAGE}`,
    user: provider === "docker" ? "65534:65534" : "998:999",
    role: "supervisor",
    entrypoint: ["/openshell-supervisor"],
    network: "host",
    readonlyRootfs: provider === "docker",
  };
  const state = { discovery: `${SUPERVISOR}\n`, health: 0, reads: 0, restart: false };
  const capture = vi.fn((args: readonly string[]) => {
    const operation = args[0];
    expect(["container", "ps", "image", "exec"]).toContain(operation);
    state.reads += Number(operation === "container");
    const observation = args.at(-1) === WORKLOAD ? workload : supervisor;
    const stdoutByOperation: Record<string, string> = {
      container: JSON.stringify(
        state.restart && state.reads > 2 ? { ...observation, pid: 200 } : observation,
      ),
      ps: state.discovery,
      image: JSON.stringify({ id: `sha256:${IMAGE}` }),
      exec: "",
    };
    const stdout = stdoutByOperation[operation ?? ""] ?? "";
    return { status: args[0] === "exec" ? state.health : 0, stdout, stderr: "not-for-diagnostics" };
  });
  const run = () =>
    observeSecurityContainerPair(
      capture,
      { providerId: provider, resourceHandle: WORKLOAD },
      "sandbox",
      { uid: 998, gid: 999 },
    );
  return { capture, workload, supervisor, state, run };
}

describe("OpenShell security container observations", () => {
  it.each(["docker", "podman"])(
    "binds %s launch metadata and native health to the pinned pair",
    (provider) => {
      const { capture, run } = harness(provider);
      const result = run();
      expect(result).toMatchObject({
        evidence: "container-launch-configuration-and-supervisor-health",
        workload: { id: WORKLOAD, user: "998:999" },
        supervisor: {
          id: SUPERVISOR,
          image: IMAGE,
          user: provider === "docker" ? "65534:65534" : "998:999",
        },
      });
      expect(capture.mock.calls.map(([args]) => args[0])).toEqual([
        "container",
        "ps",
        "container",
        "image",
        "exec",
        "container",
        "container",
      ]);
      expect(capture.mock.calls[3]?.[0].at(-1)).toBe(OPENSHELL_V015_QUALIFICATION.supervisorImage);
      expect(capture.mock.calls[4]?.[0]).toEqual([
        "exec",
        SUPERVISOR,
        "/openshell-supervisor",
        "health",
        "--socket",
        provider === "docker"
          ? "/run/openshell/health.sock"
          : "/run/openshell/supervisor-health.sock",
      ]);
      const formats = capture.mock.calls
        .filter(([args]) => args[0] === "container")
        .map(([args]) => args[3]);
      expect(formats.join(" ")).not.toMatch(/\.Env|\.Args|\.Mounts|\.Health|\.Config\}\}/u);
      expect(formats[1]).not.toContain(".Config.Cmd");
    },
  );

  it.each([
    ["root workload", "workload", "user", "0:0"],
    ["root supervisor", "supervisor", "user", "0:0"],
    ["stopped supervisor", "supervisor", "running", false],
    ["paused workload", "workload", "paused", true],
    ["wrong namespace", "supervisor", "namespace", "other"],
    ["wrong sandbox ID", "supervisor", "sandboxId", "other"],
    ["wrong image", "supervisor", "image", `sha256:${"e".repeat(64)}`],
    ["wrong entrypoint", "workload", "entrypoint", ["/bin/sh"]],
    ["wrong bootstrap", "workload", "command", ["--bootstrap", "/tmp/untrusted.json"]],
    ["privileged supervisor", "supervisor", "privileged", true],
    ["added capability", "supervisor", "capAdd", ["SYS_ADMIN"]],
    ["missing capability drop", "workload", "capDrop", []],
    ["missing no-new-privileges", "supervisor", "securityOpt", []],
    ["host-network workload", "workload", "network", "host"],
    ["writable Docker supervisor root", "supervisor", "readonlyRootfs", false],
  ] as const)("rejects %s", (_name, target, field, value) => {
    const fixture = harness();
    fixture[target][field] = value;
    expect(fixture.run).toThrow(/container security observation/u);
  });

  it("rejects nonempty effective Podman capabilities", () => {
    const fixture = harness("podman");
    fixture.supervisor.effectiveCaps = ["CAP_NET_ADMIN"];
    expect(fixture.run).toThrow(/container security observation/u);
  });

  it.each(["", `${SUPERVISOR}\n${"e".repeat(64)}\n`, WORKLOAD, "--host=attacker"])(
    "rejects missing or ambiguous companion identity: %s",
    (discovery) => {
      const fixture = harness();
      fixture.state.discovery = discovery;
      expect(fixture.run).toThrow(/container security observation/u);
      expect(fixture.capture.mock.calls).toHaveLength(2);
    },
  );

  it.each(["health", "restart"] as const)(
    "rejects %s failure without printing engine diagnostics",
    (failure) => {
      const fixture = harness();
      Object.assign(fixture.state, failure === "health" ? { health: 1 } : { restart: true });
      expect(fixture.run).toThrow("OpenShell container security observation failed");
    },
  );

  it.each(["malformed", "error", "oversized"])(
    "rejects %s metadata without exposing output",
    (failure) => {
      const capture = vi.fn(() => ({
        status: failure === "error" ? 1 : 0,
        stdout: failure === "oversized" ? "x".repeat(16_384) : "sensitive-invalid-json",
        stderr: "secret",
      }));
      expect(() =>
        observeSecurityContainerPair(
          capture,
          { providerId: "docker", resourceHandle: WORKLOAD },
          "sandbox",
          { uid: 998, gid: 999 },
        ),
      ).toThrow(/OpenShell container security observation/u);
      expect(capture).toHaveBeenCalledOnce();
    },
  );
});
