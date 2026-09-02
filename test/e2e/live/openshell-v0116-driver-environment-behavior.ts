// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { OPENSHELL_V0116_QUALIFICATION } from "../fixtures/openshell-v0116-qualification.ts";

type CommandResult = {
  status: number | null;
  stderr: string;
  stdout: string;
};

type CommandRunner = (command: string, args: readonly string[], cwd: string) => CommandResult;

type DriverProbe = {
  driver: "docker" | "podman" | "vm";
  packageName: string;
  tests: readonly {
    claim: "managed-tls" | "normal-environment" | "untrusted-server-name";
    name: string;
  }[];
};

export const OPENSHELL_V0116_DRIVER_ENVIRONMENT_PROBES: readonly DriverProbe[] = Object.freeze([
  {
    driver: "docker",
    packageName: "openshell-driver-docker",
    tests: [
      {
        claim: "untrusted-server-name",
        name: "tests::build_environment_strips_gateway_tls_server_name",
      },
      {
        claim: "normal-environment",
        name: "tests::build_environment_sets_docker_tls_paths",
      },
      {
        claim: "managed-tls",
        name: "tests::build_environment_sets_docker_tls_paths",
      },
    ],
  },
  {
    driver: "podman",
    packageName: "openshell-driver-podman",
    tests: [
      {
        claim: "untrusted-server-name",
        name: "container::tests::build_env_strips_gateway_tls_server_name",
      },
      {
        claim: "normal-environment",
        name: "container::tests::container_spec_sandbox_env_cannot_influence_proxy_argv",
      },
      {
        claim: "managed-tls",
        name: "container::tests::container_spec_includes_tls_mounts_when_configured",
      },
    ],
  },
  {
    driver: "vm",
    packageName: "openshell-driver-vm",
    tests: [
      {
        claim: "untrusted-server-name",
        name: "driver::tests::build_guest_environment_strips_gateway_tls_server_name",
      },
      {
        claim: "normal-environment",
        name: "driver::tests::merged_environment_prefers_spec_values",
      },
      {
        claim: "managed-tls",
        name: "driver::tests::build_guest_environment_includes_tls_paths_for_https_endpoint",
      },
    ],
  },
]);

function run(command: string, args: readonly string[], cwd: string): CommandResult {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CARGO_TERM_COLOR: "never" },
    killSignal: "SIGKILL",
    timeout: 4 * 60_000,
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function commandOutput(result: CommandResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function verifyOpenShellDriverEnvironmentBehavior(
  options: {
    runCommand?: CommandRunner;
    sourceRoot?: string;
  } = {},
): {
  drivers: {
    driver: DriverProbe["driver"];
    passedClaims: DriverProbe["tests"][number]["claim"][];
  }[];
  sourceRevision: string;
  version: string;
} {
  const requestedSourceRoot =
    options.sourceRoot ?? process.env.NEMOCLAW_OPENSHELL_SOURCE_CHECKOUT?.trim();
  if (!requestedSourceRoot) {
    throw new Error("OpenShell behavior checkout is required.");
  }
  const sourceRoot = fs.realpathSync(requestedSourceRoot);
  if (!path.isAbsolute(sourceRoot)) {
    throw new Error("OpenShell behavior checkout must resolve to an absolute path.");
  }
  const runCommand = options.runCommand ?? run;
  const revision = runCommand("git", ["rev-parse", "HEAD"], sourceRoot);
  if (
    revision.status !== 0 ||
    revision.stdout.trim() !== OPENSHELL_V0116_QUALIFICATION.sourceRevision
  ) {
    throw new Error("OpenShell behavior checkout does not match the reviewed v0.0.116 revision.");
  }

  const drivers = OPENSHELL_V0116_DRIVER_ENVIRONMENT_PROBES.map((probe) => {
    const uniqueTests = [...new Set(probe.tests.map(({ name }) => name))];
    for (const testName of uniqueTests) {
      const result = runCommand(
        "cargo",
        ["test", "--locked", "-p", probe.packageName, "--lib", testName, "--", "--exact"],
        sourceRoot,
      );
      const output = commandOutput(result);
      if (result.status !== 0 || !/test result: ok[.] 1 passed;/u.test(output)) {
        throw new Error(
          `OpenShell ${probe.driver} driver environment behavior '${testName}' failed:\n${output.slice(-2000)}`,
        );
      }
    }
    return {
      driver: probe.driver,
      passedClaims: probe.tests.map(({ claim }) => claim),
    };
  });

  return {
    drivers,
    sourceRevision: OPENSHELL_V0116_QUALIFICATION.sourceRevision,
    version: OPENSHELL_V0116_QUALIFICATION.version,
  };
}
