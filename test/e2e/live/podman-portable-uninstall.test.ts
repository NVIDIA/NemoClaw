// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  capturePodmanSocketAuthority,
  createPodmanContainerEngine,
} from "../../../src/lib/adapters/podman";
import { portableDemoReceiptPath } from "../../../src/lib/onboard/experimental/portable-runtime-receipt-readiness";
import { expect, test } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { executableOnPath, runCommand, SOCKET_PATH } from "./podman-cpu-lifecycle-helpers.ts";

const BASE_IMAGE =
  "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1";
const SANDBOX_NAME = "podman-uninstall";
const SANDBOX_ID = "proof-alpha";
const UNRELATED_NAME = "nemoclaw-uninstall-unrelated";
const REGISTRY_NAME = "nemoclaw-portable-registry";
const UNINSTALL_ARGS = [
  "uninstall",
  "--all-gateway-ports",
  "--delete-models",
  "--destroy-user-data",
  "--yes",
] as const;
const E2E_PHASES = [
  "pin the current-user Podman authority",
  "create receipt-owned and unrelated resources",
  "project portable selectors",
  "run the exact full uninstall command",
  "verify resource and lifecycle retirement",
  "restart the user Podman socket",
  "begin portable reinstall runtime selection",
] as const;

function sandboxCreateArgs(): string[] {
  return [
    "create",
    "--name",
    `openshell-default--${SANDBOX_NAME}-${SANDBOX_ID}`,
    "--label",
    "openshell.managed=true",
    "--label",
    `openshell.ai/sandbox-id=${SANDBOX_ID}`,
    "--label",
    `openshell.ai/sandbox-name=${SANDBOX_NAME}`,
    "--label",
    "openshell.ai/sandbox-namespace=",
    "--label",
    "openshell.ai/sandbox-workspace=default",
    BASE_IMAGE,
    "sleep",
    "infinity",
  ];
}

function unrelatedCreateArgs(): string[] {
  return [
    "create",
    "--name",
    UNRELATED_NAME,
    "--label",
    "com.nvidia.nemoclaw.e2e-unrelated=1",
    BASE_IMAGE,
    "sleep",
    "infinity",
  ];
}

test(
  "runs full portable uninstall before a clean socket restart and reinstall start (#9189)",
  { meta: { e2ePhases: E2E_PHASES }, timeout: 300_000 },
  async ({ progress, shellProbe }) => {
    progress.phase("pin the current-user Podman authority");
    expect(process.platform).toBe("linux");
    const uid = process.getuid?.() ?? -1;
    expect(uid).toBeGreaterThan(0);
    expect(SOCKET_PATH).toBe(path.join("/run/user", String(uid), "podman", "podman.sock"));
    expect(fs.existsSync("/var/run/docker.sock")).toBe(false);
    const socketAuthority = capturePodmanSocketAuthority(SOCKET_PATH);
    const engine = createPodmanContainerEngine({ operation: "sandbox-lifecycle", socketAuthority });
    expect(engine.capture(["version", "--format", "json"]).status).toBe(0);
    const nemoclawBin = executableOnPath("nemoclaw");

    const homeDir = os.homedir();
    const stateDir = path.join(homeDir, ".nemoclaw");
    const configDir = path.join(homeDir, ".config", "nemoclaw");
    const registryFile = path.join(stateDir, "sandboxes.json");
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(fs.existsSync(configDir)).toBe(false);
    const createdContainerIds: string[] = [];
    let selectorsProjected = false;
    try {
      progress.phase("create receipt-owned and unrelated resources");
      const sandboxCreate = engine.capture(sandboxCreateArgs());
      expect(sandboxCreate.status).toBe(0);
      const sandboxContainerId = sandboxCreate.stdout.trim();
      expect(sandboxContainerId).toMatch(/^[a-f0-9]{64}$/u);
      createdContainerIds.push(sandboxContainerId);

      const unrelatedCreate = engine.capture(unrelatedCreateArgs());
      expect(unrelatedCreate.status).toBe(0);
      const unrelatedContainerId = unrelatedCreate.stdout.trim();
      expect(unrelatedContainerId).toMatch(/^[a-f0-9]{64}$/u);
      createdContainerIds.push(unrelatedContainerId);

      const registryCreate = engine.capture([
        "create",
        "--name",
        REGISTRY_NAME,
        "--label",
        "com.nvidia.nemoclaw.portable=1",
        BASE_IMAGE,
        "sleep",
        "infinity",
      ]);
      expect(registryCreate.status).toBe(0);
      const registryContainerId = registryCreate.stdout.trim();
      expect(registryContainerId).toMatch(/^[a-f0-9]{64}$/u);
      createdContainerIds.push(registryContainerId);
      for (const containerId of createdContainerIds) {
        expect(engine.capture(["start", containerId]).status).toBe(0);
      }

      const runtimeAuthority = {
        schemaVersion: 1,
        kind: "podman",
        ownership: "current-user",
        uid,
        homeDir,
        configHome: path.join(homeDir, ".config"),
        runtimeDir: path.join("/run/user", String(uid)),
        socketPath: SOCKET_PATH,
      } as const;
      const receiptFile = portableDemoReceiptPath(SANDBOX_NAME, stateDir);
      fs.mkdirSync(path.dirname(receiptFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        receiptFile,
        `${JSON.stringify(
          {
            schemaVersion: 4,
            sandboxName: SANDBOX_NAME,
            sandboxId: SANDBOX_ID,
            containerId: sandboxContainerId,
            dashboardPort: 18789,
            registryGeneration: sandboxContainerId,
            runtimeAuthority,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      fs.writeFileSync(
        registryFile,
        `${JSON.stringify(
          {
            defaultSandbox: SANDBOX_NAME,
            sandboxes: {
              [SANDBOX_NAME]: {
                name: SANDBOX_NAME,
                agent: "openclaw",
                gatewayName: "nemoclaw",
                gatewayPort: 8080,
                openshellDriver: "docker",
                lifecycleGeneration: sandboxContainerId,
              },
            },
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      const expectedContainersConf = path.join(
        runtimeAuthority.configHome,
        "nemoclaw",
        "portable",
        "containers.conf",
      );
      fs.mkdirSync(path.dirname(expectedContainersConf), { recursive: true, mode: 0o700 });
      fs.writeFileSync(expectedContainersConf, '[network]\nfirewall_driver = "iptables"\n', {
        mode: 0o600,
      });

      progress.phase("project portable selectors");
      await runCommand(
        shellProbe,
        "systemctl",
        [
          "--user",
          "set-environment",
          `CONTAINERS_CONF=${expectedContainersConf}`,
          "NETAVARK_FW=iptables",
          "CONTAINER_HOST=ssh://user-managed.invalid",
          "CONTAINER_CONNECTION=user-managed",
          `CONTAINER_SSHKEY=${path.join(homeDir, ".ssh", "user-managed")}`,
        ],
        { artifactName: "podman-uninstall-project-selectors" },
      );
      selectorsProjected = true;

      progress.phase("run the exact full uninstall command");
      await runCommand(shellProbe, nemoclawBin, UNINSTALL_ARGS, {
        artifactName: "podman-exact-full-uninstall",
        timeoutMs: 240_000,
      });

      progress.phase("verify resource and lifecycle retirement");
      const postUninstallEngine = createPodmanContainerEngine({
        operation: "sandbox-lifecycle",
        socketAuthority: capturePodmanSocketAuthority(SOCKET_PATH),
      });
      expect(postUninstallEngine.capture(["inspect", sandboxContainerId]).status).not.toBe(0);
      expect(postUninstallEngine.capture(["inspect", registryContainerId]).status).not.toBe(0);
      expect(postUninstallEngine.capture(["inspect", unrelatedContainerId]).status).toBe(0);
      expect(fs.existsSync(receiptFile)).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(false);
      expect(fs.existsSync(configDir)).toBe(false);
      const managerEnvironment = await runCommand(
        shellProbe,
        "systemctl",
        ["--user", "show-environment"],
        { artifactName: "podman-uninstall-selectors-after-full-command" },
      );
      expect(managerEnvironment).not.toContain("CONTAINERS_CONF=");
      expect(managerEnvironment).not.toContain("NETAVARK_FW=");
      expect(managerEnvironment).toContain("CONTAINER_HOST=ssh://user-managed.invalid");
      expect(managerEnvironment).toContain("CONTAINER_CONNECTION=user-managed");
      expect(managerEnvironment).toContain(
        `CONTAINER_SSHKEY=${path.join(homeDir, ".ssh", "user-managed")}`,
      );

      await runCommand(
        shellProbe,
        "systemctl",
        [
          "--user",
          "unset-environment",
          "CONTAINER_HOST",
          "CONTAINER_CONNECTION",
          "CONTAINER_SSHKEY",
        ],
        { artifactName: "podman-uninstall-release-test-selectors" },
      );
      selectorsProjected = false;

      progress.phase("restart the user Podman socket");
      await runCommand(
        shellProbe,
        "bash",
        [
          "-ceu",
          `
socket_path="$1"
systemctl --user stop podman.service
systemctl --user reset-failed podman.service podman.socket
systemctl --user restart podman.socket
for attempt in $(seq 1 30); do
  if podman --url "unix://$socket_path" version --format json >/dev/null; then
    break
  fi
  test "$attempt" -lt 30
  sleep 1
done
systemctl --user is-active --quiet podman.socket
systemctl --user show podman.socket --property=ActiveState --property=Result
`,
          "podman-uninstall-socket-restart",
          SOCKET_PATH,
        ],
        { artifactName: "podman-uninstall-restart-user-socket", timeoutMs: 60_000 },
      );

      progress.phase("begin portable reinstall runtime selection");
      await runCommand(
        shellProbe,
        "env",
        [
          "-u",
          "CONTAINERS_CONF",
          "-u",
          "NETAVARK_FW",
          "-u",
          "CONTAINER_HOST",
          "-u",
          "CONTAINER_CONNECTION",
          "-u",
          "CONTAINER_SSHKEY",
          "bash",
          "-ceu",
          `
source "$1"
export NEMOCLAW_EXPERIMENTAL_PROFILE=portable
prepare_portable_experimental_runtime_override
test "$DOCKER_HOST" = "unix://$2"
`,
          "podman-uninstall-reinstall-start",
          path.join(REPO_ROOT, "scripts", "install.sh"),
          SOCKET_PATH,
        ],
        { artifactName: "podman-uninstall-begin-reinstall", timeoutMs: 60_000 },
      );

      const artifactDir = process.env.E2E_ARTIFACT_DIR;
      if (artifactDir) {
        fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(artifactDir, "portable-uninstall-summary.json"),
          `${JSON.stringify(
            {
              schemaVersion: 1,
              command: ["nemoclaw", ...UNINSTALL_ARGS],
              dockerUnavailable: true,
              rootlessUid: uid,
              sandboxRemoved: true,
              unrelatedContainerPreserved: true,
              registryRemoved: true,
              receiptRetired: true,
              configRetired: true,
              exactSelectorsCleared: true,
              userSelectorsPreserved: true,
              socketRestarted: true,
              reinstallRuntimeSelectionBegan: true,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
      }
    } finally {
      if (selectorsProjected) {
        await runCommand(
          shellProbe,
          "systemctl",
          [
            "--user",
            "unset-environment",
            "CONTAINERS_CONF",
            "NETAVARK_FW",
            "CONTAINER_HOST",
            "CONTAINER_CONNECTION",
            "CONTAINER_SSHKEY",
          ],
          { allowFailure: true, artifactName: "podman-uninstall-clear-selectors" },
        );
      }
      try {
        const cleanupAuthority = capturePodmanSocketAuthority(SOCKET_PATH);
        const cleanupEngine = createPodmanContainerEngine({
          operation: "sandbox-lifecycle",
          socketAuthority: cleanupAuthority,
        });
        for (const containerId of createdContainerIds.reverse()) {
          cleanupEngine.capture(["rm", "--force", containerId]);
        }
      } catch {
        // The workflow's always-run cleanup owns any resources left after a socket failure.
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  },
);
