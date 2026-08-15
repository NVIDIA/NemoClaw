// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { installPortableProfileSystemctlShim } from "../fixtures/portable-profile-systemctl.ts";
import { readYaml, type Workflow, type WorkflowStep } from "../../helpers/e2e-workflow-contract.ts";

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o700 });
}

function portableLaunchProvisionStep(): WorkflowStep {
  const workflow = readYaml<Workflow>(".github/workflows/portable-profile-e2e.yaml");
  const step = workflow.jobs["portable-launch"]?.steps?.find(
    (candidate) => candidate.name === "Provision restricted rootless Linux runtime",
  );
  expect(step).toBeDefined();
  return step!;
}

describe("portable profile systemctl fixture", () => {
  it(
    "installs a mode-0700 shim that reports inactive status, starts the socket, and stays active across try-restart (#9006)",
    {
      timeout: 15_000,
    },
    () => {
      const directory = fs.mkdtempSync("/tmp/portable-systemctl-shim-");
      const binDir = path.join(directory, "bin");
      const runtimeDir = path.join(directory, "runtime");
      fs.mkdirSync(binDir);
      fs.mkdirSync(runtimeDir);
      const shim = installPortableProfileSystemctlShim(binDir);
      expect(fs.statSync(shim).mode & 0o777).toBe(0o700);
      writeExecutable(
        path.join(binDir, "podman"),
        `#!${process.execPath}
const net = require("node:net");
const socketPath = process.argv.at(-1).replace("unix://", "");
const server = net.createServer();
server.listen(socketPath);
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`,
      );
      const env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        XDG_RUNTIME_DIR: runtimeDir,
      };
      const systemctl = (args: string[]) =>
        spawnSync(shim, args, { encoding: "utf8", env, timeout: 15_000 });

      try {
        expect(systemctl(["--user", "is-active", "--quiet", "podman.service"]).status).toBe(3);
        expect(
          systemctl([
            "--user",
            "set-environment",
            "NETAVARK_FW=iptables",
            `CONTAINERS_CONF=${path.join(directory, "containers.conf")}`,
          ]).status,
        ).toBe(0);
        const activation = systemctl(["--user", "start", "podman.socket"]);
        expect(activation.status, activation.stderr).toBe(0);
        expect(systemctl(["--user", "is-active", "--quiet", "podman.service"]).status).toBe(0);
        const refresh = systemctl(["--user", "try-restart", "podman.service"]);
        expect(refresh.status, refresh.stderr).toBe(0);
        expect(systemctl(["--user", "is-active", "--quiet", "podman.service"]).status).toBe(0);
      } finally {
        const pidFile = path.join(runtimeDir, "nemoclaw-podman-service.pid");
        try {
          const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
          expect(pid).toBeGreaterThan(0);
          process.kill(pid, "SIGTERM");
        } catch (error) {
          expect(["ENOENT", "ESRCH"]).toContain((error as NodeJS.ErrnoException).code);
        }
        fs.rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it("rejects an unexpected user-service command (#9006)", () => {
    const directory = fs.mkdtempSync("/tmp/portable-systemctl-shim-");
    const binDir = path.join(directory, "bin");
    const runtimeDir = path.join(directory, "runtime");
    try {
      fs.mkdirSync(binDir);
      fs.mkdirSync(runtimeDir);
      const shim = installPortableProfileSystemctlShim(binDir);
      const result = spawnSync(shim, ["--user", "restart", "podman.socket"], {
        encoding: "utf8",
        env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
      });
      expect(result.status).toBe(64);
      expect(result.stderr).toContain(
        "unexpected user-service command: --user restart podman.socket",
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("binds the portable-launch workflow to the shared systemctl fixture (#9006)", () => {
    const provision = portableLaunchProvisionStep().run ?? "";
    expect(provision).toContain(
      'install -m 700 test/e2e/fixtures/portable-profile-systemctl-shim.sh "$shim_dir/systemctl"',
    );
    expect(provision).toContain("systemctl --user start podman.socket");
  });
});
