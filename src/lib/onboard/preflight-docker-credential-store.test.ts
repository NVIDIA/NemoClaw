// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runFatalOnboardRuntimePreflight,
  runOnboardRuntimeEffectfulPreflightChecks,
} from "./fatal-runtime-preflight";
import { assessHost, type HostAssessment, planHostAdvisories } from "./preflight";

const CREDENTIAL_STORE_ADVISORY_ID = "docker_desktop_credential_store_headless";
const DOCKER_DESKTOP_INFO = JSON.stringify({
  ServerVersion: "29.0.0",
  OperatingSystem: "Docker Desktop",
});

function raiseEnoent(filePath: string): never {
  const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
  (error as NodeJS.ErrnoException).code = "ENOENT";
  throw error;
}

function assessWithDockerConfig(
  env: NodeJS.ProcessEnv,
  configJson: string | undefined,
  commandOutputs: Record<string, string> = {},
  dockerInfoOutput = DOCKER_DESKTOP_INFO,
): HostAssessment {
  const files: Record<string, string | undefined> = {
    "/fake/docker-config/config.json": configJson,
  };
  return assessHost({
    platform: "linux",
    env: { DOCKER_CONFIG: "/fake/docker-config", ...env },
    release: "5.15.0-generic",
    procVersion: "",
    dockerInfoOutput,
    commandExistsImpl: (name: string) => name === "docker",
    runCaptureImpl: (command: readonly string[]) => commandOutputs[command.join(" ")] ?? "",
    gpuProbeImpl: () => false,
    readFileImpl: (filePath: string) => files[filePath] ?? raiseEnoent(filePath),
  });
}

function headlessDockerDesktopHost(): HostAssessment {
  return {
    platform: "linux",
    isWsl: false,
    runtime: "docker-desktop",
    dockerInstalled: true,
    dockerRunning: true,
    dockerReachable: true,
    nodeInstalled: true,
    openshellInstalled: true,
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: false,
    isHeadlessLikely: true,
    isSshSession: true,
    dockerCredsStore: "desktop.exe",
    hasNvidiaGpu: false,
    dockerCdiSpecDirs: [],
    cdiNvidiaGpuSpecMissing: false,
    nvidiaContainerToolkitInstalled: false,
    notes: [],
  };
}

describe("assessHost Docker credential store detection (#9457)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records credsStore from the Docker client config under DOCKER_CONFIG", () => {
    const assessment = assessWithDockerConfig(
      { SSH_CONNECTION: "203.0.113.5 52014 203.0.113.9 22" },
      JSON.stringify({ auths: {}, credsStore: "desktop.exe" }),
    );

    expect(assessment.dockerCredsStore).toBe("desktop.exe");
    expect(assessment.dockerCredsStorePath).toBe("$DOCKER_CONFIG/config.json");
    expect(assessment.isSshSession).toBe(true);
  });

  it.each([
    ["a missing Docker client config", undefined],
    ["a malformed Docker client config", "{ not json"],
    ["a config without credsStore", JSON.stringify({ auths: {} })],
  ] as const)("records no credential store for %s", (_label, configJson) => {
    const assessment = assessWithDockerConfig({}, configJson);

    expect(assessment.dockerCredsStore).toBeUndefined();
  });

  it("degrades to no credential store when the home directory is unresolvable (#9457)", () => {
    vi.spyOn(os, "homedir").mockImplementation(() => {
      throw new Error("uv_os_homedir returned ENOENT");
    });

    const assessment = assessHost({
      platform: "linux",
      env: {},
      release: "5.15.0-generic",
      procVersion: "",
      dockerInfoOutput: "",
      commandExistsImpl: (name: string) => name === "docker",
      runCaptureImpl: () => "",
      gpuProbeImpl: () => false,
      readFileImpl: raiseEnoent,
    });

    expect(assessment.dockerCredsStore).toBeUndefined();
  });

  it.each([
    ["an unresponsive helper", "", true],
    ["a helper with malformed output", "not json", true],
    ["a responding helper", '{"https://index.docker.io/v1/":"user"}', false],
  ] as const)(
    "probes the Docker Desktop credential helper on WSL with %s (#9457)",
    (_label, probeOutput, unresponsive) => {
      const assessment = assessWithDockerConfig(
        { WSL_DISTRO_NAME: "Ubuntu", DISPLAY: ":0" },
        JSON.stringify({ credsStore: "desktop.exe" }),
        { "docker-credential-desktop.exe list": probeOutput },
      );

      expect(assessment.dockerCredentialHelperUnresponsive).toBe(unresponsive);
    },
  );

  it("does not probe the credential helper outside WSL (#9457)", () => {
    const assessment = assessWithDockerConfig({}, JSON.stringify({ credsStore: "desktop" }));

    expect(assessment.dockerCredentialHelperUnresponsive).toBeUndefined();
  });
});

describe("docker_desktop_credential_store_headless advisory (#9457)", () => {
  it.each([
    [
      "credsStore desktop.exe in an SSH session",
      "desktop.exe",
      { SSH_CONNECTION: "203.0.113.5 52014 203.0.113.9 22" },
    ],
    [
      "credsStore desktop in an SSH session with X forwarding",
      "desktop",
      { SSH_TTY: "/dev/pts/0", DISPLAY: "localhost:10.0" },
    ],
    ["credsStore desktop in a session without GUI markers", "desktop", {}],
  ] as const)("warns for %s", (_label, credsStore, env) => {
    const assessment = assessWithDockerConfig(env, JSON.stringify({ credsStore }));

    const ids = planHostAdvisories(assessment).map((advisory) => advisory.id);
    expect(ids).toContain(CREDENTIAL_STORE_ADVISORY_ID);
  });

  it("warns on WSL when the helper probe fails even though WSLg sets DISPLAY (#9457)", () => {
    const assessment = assessWithDockerConfig(
      { WSL_DISTRO_NAME: "Ubuntu", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" },
      JSON.stringify({ credsStore: "desktop.exe" }),
      { "docker-credential-desktop.exe list": "" },
    );

    const ids = planHostAdvisories(assessment).map((advisory) => advisory.id);
    expect(ids).toContain(CREDENTIAL_STORE_ADVISORY_ID);
  });

  it("stays silent on WSL when the helper answers, even in a console without GUI markers (#9457)", () => {
    const assessment = assessWithDockerConfig(
      { WSL_DISTRO_NAME: "Ubuntu" },
      JSON.stringify({ credsStore: "desktop.exe" }),
      { "docker-credential-desktop.exe list": "{}" },
    );

    const ids = planHostAdvisories(assessment).map((advisory) => advisory.id);
    expect(ids).not.toContain(CREDENTIAL_STORE_ADVISORY_ID);
  });

  it("stays silent on Linux Docker Engine with a copied Docker Desktop credsStore (#9457)", () => {
    const assessment = assessWithDockerConfig(
      { SSH_CONNECTION: "203.0.113.5 52014 203.0.113.9 22" },
      JSON.stringify({ credsStore: "desktop" }),
      {},
      JSON.stringify({ ServerVersion: "29.0.0", OperatingSystem: "Docker Engine" }),
    );

    const ids = planHostAdvisories(assessment).map((advisory) => advisory.id);
    expect(assessment.runtime).toBe("docker");
    expect(ids).not.toContain(CREDENTIAL_STORE_ADVISORY_ID);
  });

  it.each([
    ["a GUI session", "desktop", { TERM_PROGRAM: "Apple_Terminal" }],
    [
      "a non-desktop credential store in an SSH session",
      "osxkeychain",
      { SSH_CONNECTION: "203.0.113.5 52014 203.0.113.9 22" },
    ],
  ] as const)("stays silent for %s", (_label, credsStore, env) => {
    const assessment = assessWithDockerConfig(env, JSON.stringify({ credsStore }));

    const ids = planHostAdvisories(assessment).map((advisory) => advisory.id);
    expect(ids).not.toContain(CREDENTIAL_STORE_ADVISORY_ID);
  });
});

describe("onboard preflight credential-store warning (#9457)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns about the headless Docker Desktop credential store before the first image pull and proceeds", () => {
    const events: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      events.push(String(message));
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bridge = vi.fn(() => {
      events.push("bridge-probe");
    });
    const context = {
      nonInteractive: true,
      deferEffectfulChecks: true,
      assessHost: headlessDockerDesktopHost,
      detectGpu: () => null,
      warnIfHostProxyMissesLoopback: vi.fn(),
      assertRuntimeProviderHealthy: bridge,
      validateSandboxGpuPreflight: vi.fn(),
    };
    const result = runFatalOnboardRuntimePreflight({}, context);

    runOnboardRuntimeEffectfulPreflightChecks(result, context);

    const output = events.join("\n");
    expect(output).toContain('credsStore "desktop.exe"');
    expect(output).toContain("(docker_desktop_credential_store_headless)");
    expect(output).toContain("DOCKER_CONFIG=$(mktemp -d) nemoclaw onboard --resume");
    const warningIndex = events.findIndex((event) =>
      event.includes("docker_desktop_credential_store_headless"),
    );
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(events.indexOf("bridge-probe"));
    expect(
      events.filter((event) => event.includes("docker_desktop_credential_store_headless")),
    ).toHaveLength(1);
  });
});
