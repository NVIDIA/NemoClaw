// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runFatalOnboardRuntimePreflight,
  runOnboardRuntimeEffectfulPreflightChecks,
} from "./fatal-runtime-preflight";
import { assessHost, type HostAssessment, planHostAdvisories } from "./preflight";
import { warnIfHeadlessDockerDesktopCredentialStore } from "./preflight-messages";

const CREDENTIAL_STORE_ADVISORY_ID = "docker_desktop_credential_store_headless";

function raiseEnoent(filePath: string): never {
  const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
  (error as NodeJS.ErrnoException).code = "ENOENT";
  throw error;
}

function assessWithDockerConfig(
  env: NodeJS.ProcessEnv,
  configJson: string | undefined,
): HostAssessment {
  const files: Record<string, string | undefined> = {
    "/fake/docker-config/config.json": configJson,
  };
  return assessHost({
    platform: "linux",
    env: { DOCKER_CONFIG: "/fake/docker-config", ...env },
    release: "5.15.0-generic",
    procVersion: "",
    dockerInfoOutput: "",
    commandExistsImpl: (name: string) => name === "docker",
    runCaptureImpl: () => "",
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
  it("records credsStore from the Docker client config under DOCKER_CONFIG", () => {
    const assessment = assessWithDockerConfig(
      { SSH_CONNECTION: "203.0.113.5 52014 203.0.113.9 22" },
      JSON.stringify({ auths: {}, credsStore: "desktop.exe" }),
    );

    expect(assessment.dockerCredsStore).toBe("desktop.exe");
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bridge = vi.fn();
    const context = {
      nonInteractive: true,
      deferEffectfulChecks: true,
      assessHost: headlessDockerDesktopHost,
      detectGpu: () => null,
      warnIfHostProxyMissesLoopback: vi.fn(),
      assertDockerBridgeAndContainerDnsHealthy: bridge,
      validateSandboxGpuPreflight: vi.fn(),
    };
    const result = runFatalOnboardRuntimePreflight({}, context);

    runOnboardRuntimeEffectfulPreflightChecks(result, context);

    const output = warn.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(output).toContain('credsStore "desktop.exe"');
    expect(output).toContain("DOCKER_CONFIG=$(mktemp -d) docker pull");
    expect(bridge).toHaveBeenCalledOnce();
  });

  it("prints nothing for a host without headless or SSH markers", () => {
    const warn = vi.fn();

    const warned = warnIfHeadlessDockerDesktopCredentialStore(
      { ...headlessDockerDesktopHost(), isHeadlessLikely: false, isSshSession: false },
      warn,
    );

    expect(warned).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
