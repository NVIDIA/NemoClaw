// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  assertLocalDockerEnvironment,
  classifyDockerContainerInspection,
  inspectSandboxIdentity,
  listedSandboxNames,
} from "./spark-express-vllm-safety.ts";

const result = (exitCode: number, stdout = "", stderr = "") => ({
  command: ["docker"],
  cwd: "/tmp",
  durationMs: 1,
  exitCode,
  stderr,
  stdout,
});

describe("DGX Spark Express vLLM qualification safety", () => {
  it("accepts only local Docker selectors (#8379)", () => {
    expect(() => assertLocalDockerEnvironment({})).not.toThrow();
    expect(() =>
      assertLocalDockerEnvironment({ DOCKER_HOST: "unix:///var/run/docker.sock" }),
    ).not.toThrow();
    expect(() => assertLocalDockerEnvironment({ DOCKER_HOST: "ssh://spark.example" })).toThrow(
      "local Docker socket",
    );
    expect(() => assertLocalDockerEnvironment({ DOCKER_CONTEXT: "remote-spark" })).toThrow(
      "default local Docker context",
    );
  });

  it("distinguishes an absent container from Docker daemon failures (#8379)", () => {
    expect(classifyDockerContainerInspection(result(0, "[]"))).toBe("present");
    expect(
      classifyDockerContainerInspection(result(1, "", "Error: No such object: nemoclaw-vllm")),
    ).toBe("absent");
    expect(() =>
      classifyDockerContainerInspection(
        result(1, "", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"),
      ),
    ).toThrow("Docker container inspection failed");
  });

  it("refuses to treat a failed sandbox listing as an empty host (#8379)", () => {
    expect(listedSandboxNames(result(0, "alpha\nbeta\n"))).toEqual(new Set(["alpha", "beta"]));
    expect(() => listedSandboxNames(result(1, "", "gateway unavailable"))).toThrow(
      "OpenShell sandbox listing failed",
    );
  });

  it("requires an exact sandbox identity and distinguishes absence from inspection failure (#8379)", () => {
    const id = "05d120e4-484c-47d4-9a59-77a08cbb6e67";
    expect(
      inspectSandboxIdentity(result(0, JSON.stringify({ id, name: "spark-e2e" })), "spark-e2e"),
    ).toEqual({ kind: "present", id });
    expect(inspectSandboxIdentity(result(1, "", "sandbox not found"), "spark-e2e")).toEqual({
      kind: "absent",
    });
    expect(() =>
      inspectSandboxIdentity(result(0, JSON.stringify({ id, name: "replacement" })), "spark-e2e"),
    ).toThrow("expected identity");
    expect(() => inspectSandboxIdentity(result(1, "", "gateway unavailable"), "spark-e2e")).toThrow(
      "sandbox inspection failed",
    );
    expect(() =>
      inspectSandboxIdentity(result(1, "", "gateway 'nemoclaw' not found"), "spark-e2e"),
    ).toThrow("sandbox inspection failed");
  });
});
