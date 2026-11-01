// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { assessHost, planHostAdvisories } from "./preflight";
import { printRemediationActions } from "./remediation";

const dockerInfoCommand = ["docker", "info", "--format", "{{json .}}"] as const;
const dockerVersionCommand = ["docker", "version", "--format", "{{json .}}"] as const;
const reachableInfoOutput = JSON.stringify({
  ServerVersion: "29.2.1",
  OperatingSystem: "Docker Engine",
});

function commonAssessmentOptions() {
  return {
    platform: "linux" as const,
    commandExistsImpl: (name: string) => name === "docker",
    runCaptureImpl: () => "",
    readFileImpl: () => "",
    readdirImpl: () => [],
    gpuProbeImpl: () => false,
  };
}

describe("Docker preflight timeouts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(
    ["info", "version"].flatMap((command) =>
      [true, false].map((timedOut) => ({
        command,
        timedOut,
        condition: timedOut ? "times out" : "cannot start",
      })),
    ),
  )(
    "prints the assessed endpoint when docker $command $condition (#10645)",
    ({ command, timedOut }) => {
      const endpoint = "unix:///run/user/1000/docker.sock";
      const env = { DOCKER_HOST: endpoint };
      const assessment = assessHost({
        ...commonAssessmentOptions(),
        env,
        statSyncImpl: () => ({ isSocket: () => true }),
        runCaptureExImpl: (argv) =>
          argv[1] === command
            ? { stdout: "", stderr: "", exitCode: null, timedOut }
            : { stdout: reachableInfoOutput, stderr: "", exitCode: 0, timedOut: false },
      });
      env.DOCKER_HOST = "unix:///another/docker.sock";
      vi.stubEnv("DOCKER_HOST", env.DOCKER_HOST);
      const output = vi.spyOn(console, "error").mockImplementation(() => {});

      printRemediationActions(
        planHostAdvisories(assessment).filter(({ id }) => id === "docker_probe_inconclusive"),
      );

      const text = output.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(text).toContain(endpoint);
      expect(text).toContain(
        timedOut
          ? `did not answer \`docker ${command}\` within 15 seconds`
          : `could not start the \`docker ${command}\` readiness probe`,
      );
      expect(text).not.toContain(env.DOCKER_HOST);
    },
  );

  it.each(["info", "version"])(
    "keeps an unknown endpoint generic when docker %s times out",
    (command) => {
      const assessment = assessHost({
        ...commonAssessmentOptions(),
        env: {},
        runCaptureExImpl: (argv) =>
          argv[1] === command
            ? { stdout: "", stderr: "", exitCode: null, timedOut: true }
            : { stdout: reachableInfoOutput, stderr: "", exitCode: 0, timedOut: false },
      });
      vi.stubEnv("DOCKER_HOST", "unix:///another/docker.sock");
      const output = vi.spyOn(console, "error").mockImplementation(() => {});

      printRemediationActions(planHostAdvisories(assessment));

      const text = output.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(text).toContain(`The selected Docker authority did not answer \`docker ${command}\``);
      expect(text).not.toContain("unix://");
    },
  );

  it.each([
    { length: 1024, displayed: true },
    { length: 1025, displayed: false },
  ])("bounds endpoint display at $length characters", ({ length, displayed }) => {
    const endpoint = "unix:///" + "a".repeat(length - "unix:///".length);
    const assessment = assessHost({
      ...commonAssessmentOptions(),
      env: { DOCKER_HOST: endpoint },
      statSyncImpl: () => ({ isSocket: () => true }),
      runCaptureExImpl: () => ({ stdout: "", stderr: "", exitCode: null, timedOut: true }),
    });
    const output = vi.spyOn(console, "error").mockImplementation(() => {});

    printRemediationActions(
      planHostAdvisories(assessment).filter(({ id }) => id === "docker_probe_inconclusive"),
    );

    const text = output.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(text.includes(endpoint)).toBe(displayed);
    expect(text).toContain("selected Docker authority");
    expect(text).toContain("did not answer `docker info` within 15 seconds");
    expect(text.length).toBeLessThan(1600);
  });

  it.each([
    "tcp://127.0.0.1:2375",
    "unix:///run/docker\u001b.sock",
    "unix:///run/docker\u202e.sock",
    "unix:///run/docker'quoted.sock",
  ])("does not probe or print an invalid Docker endpoint %j", (endpoint) => {
    const probe = vi.fn(() => ({ stdout: "", stderr: "", exitCode: null, timedOut: true }));
    const assessment = assessHost({
      ...commonAssessmentOptions(),
      env: { DOCKER_HOST: endpoint },
      runCaptureExImpl: probe,
    });
    const output = vi.spyOn(console, "error").mockImplementation(() => {});

    printRemediationActions(planHostAdvisories(assessment));

    expect(probe).not.toHaveBeenCalled();
    expect(output.mock.calls.map((args) => args.join(" ")).join("\n")).not.toContain(endpoint);
  });

  it("bounds Docker info before reporting an unreachable daemon (#10367)", () => {
    const calls: Array<{
      command: readonly string[];
      timeout: number | undefined;
    }> = [];
    const result = assessHost({
      ...commonAssessmentOptions(),
      env: {},
      runCaptureExImpl: (command, options) => {
        calls.push({ command, timeout: options?.timeout });
        return { stdout: "", stderr: "", exitCode: null, timedOut: true };
      },
    });

    expect(calls.filter(({ command }) => command[0] === "docker")).toEqual([
      { command: dockerInfoCommand, timeout: 15_000 },
    ]);
    expect(result.dockerReachable).toBe(false);
    expect(result.dockerProbeIssue).toBe("info_timeout");
    const advisories = planHostAdvisories(result);
    expect(advisories.map(({ id }) => id)).toContain("docker_probe_inconclusive");
    expect(advisories.find(({ id }) => id === "docker_probe_inconclusive")?.reason).toContain(
      "did not answer `docker info` within 15 seconds",
    );
    expect(advisories.map(({ id }) => id)).not.toContain("start_docker");
    expect(advisories.map(({ id }) => id)).not.toContain("docker_group_permission");
  });

  it("bounds Docker version after Docker info succeeds (#10367)", () => {
    const calls: Array<{
      command: readonly string[];
      timeout: number | undefined;
    }> = [];
    const results = new Map([
      [
        dockerInfoCommand.join("\0"),
        { stdout: reachableInfoOutput, stderr: "", exitCode: 0, timedOut: false },
      ],
    ]);
    const result = assessHost({
      ...commonAssessmentOptions(),
      env: {},
      runCaptureExImpl: (command, options) => {
        calls.push({ command, timeout: options?.timeout });
        return (
          results.get(command.join("\0")) ?? {
            stdout: "",
            stderr: "",
            exitCode: null,
            timedOut: true,
          }
        );
      },
    });

    expect(calls.filter(({ command }) => command[0] === "docker")).toEqual([
      { command: dockerInfoCommand, timeout: 15_000 },
      { command: dockerVersionCommand, timeout: 15_000 },
    ]);
    expect(result.dockerReachable).toBe(true);
    expect(result.dockerProbeIssue).toBe("version_timeout");
    expect(
      planHostAdvisories(result).find(({ id }) => id === "docker_probe_inconclusive")?.reason,
    ).toContain("did not answer `docker version` within 15 seconds");
  });

  it("reports an unavailable Docker info process as inconclusive", () => {
    const result = assessHost({
      ...commonAssessmentOptions(),
      env: {},
      runCaptureExImpl: () => {
        throw new Error("spawn failed");
      },
    });

    expect(result.dockerReachable).toBe(false);
    expect(result.dockerProbeIssue).toBe("info_unavailable");
    const advisoryIds = planHostAdvisories(result).map(({ id }) => id);
    expect(advisoryIds).toContain("docker_probe_inconclusive");
    expect(advisoryIds).not.toContain("start_docker");
    expect(advisoryIds).not.toContain("docker_group_permission");
  });

  it("reports an unavailable Docker version process as inconclusive", () => {
    const result = assessHost({
      ...commonAssessmentOptions(),
      env: {},
      runCaptureExImpl: (command) =>
        command[1] === "info"
          ? { stdout: reachableInfoOutput, stderr: "", exitCode: 0, timedOut: false }
          : { stdout: "", stderr: "", exitCode: null, timedOut: false },
    });

    expect(result.dockerReachable).toBe(true);
    expect(result.dockerProbeIssue).toBe("version_unavailable");
    expect(planHostAdvisories(result).map(({ id }) => id)).toContain("docker_probe_inconclusive");
  });
});
