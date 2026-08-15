// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readYaml, type Workflow, type WorkflowStep } from "../../helpers/e2e-workflow-contract.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SHIM_SOURCE = path.join(REPO_ROOT, "test/e2e/fixtures/portable-profile-systemctl-shim.sh");

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
    "reports inactive status, activates the socket, and reports active status (#9006)",
    {
      timeout: 15_000,
    },
    () => {
      const directory = fs.mkdtempSync("/tmp/portable-systemctl-shim-");
      const binDir = path.join(directory, "bin");
      const runtimeDir = path.join(directory, "runtime");
      const shim = path.join(binDir, "systemctl");
      fs.mkdirSync(binDir);
      fs.mkdirSync(runtimeDir);
      fs.copyFileSync(SHIM_SOURCE, shim);
      fs.chmodSync(shim, 0o700);
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
      } finally {
        const pidFile = path.join(runtimeDir, "nemoclaw-podman-service.pid");
        if (fs.existsSync(pidFile)) {
          const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
          if (Number.isInteger(pid)) {
            process.kill(pid, "SIGTERM");
          }
        }
        fs.rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it("rejects an unexpected user-service command (#9006)", () => {
    const runtimeDir = fs.mkdtempSync("/tmp/portable-systemctl-shim-");
    try {
      const result = spawnSync(SHIM_SOURCE, ["--user", "restart", "podman.socket"], {
        encoding: "utf8",
        env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
      });
      expect(result.status).toBe(64);
      expect(result.stderr).toContain(
        "unexpected user-service command: --user restart podman.socket",
      );
    } finally {
      fs.rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("binds both portable profile lanes to the same systemctl fixture (#9006)", () => {
    const provision = portableLaunchProvisionStep().run ?? "";
    expect(provision).toContain(
      'install -m 700 test/e2e/fixtures/portable-profile-systemctl-shim.sh "$shim_dir/systemctl"',
    );
    expect(provision).toContain("systemctl --user start podman.socket");
    expect(
      fs.readFileSync(
        path.join(REPO_ROOT, "test/e2e/live/portable-profile-rootless-linux.test.ts"),
        "utf8",
      ),
    ).toContain('"test/e2e/fixtures/portable-profile-systemctl-shim.sh"');
  });
});
