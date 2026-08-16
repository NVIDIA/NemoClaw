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
import {
  cleanupPodmanLifecycle,
  executableOnPath,
  inspectContainer,
  runCommand,
  SOCKET_PATH,
} from "./podman-cpu-lifecycle-helpers.ts";

const BASE_IMAGE =
  "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1";
const UNRELATED_IMAGE =
  "docker.io/library/ubuntu@sha256:019e8eb29a85e74d64925745884f2ec79aa27e3feab36353d24656f4d6b89467";
const UNUSED_IMAGE =
  "docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const SANDBOX_NAME = "podman-uninstall";
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
  "authenticate the workflow-owned pinned OpenShell gateway",
  "create receipt-owned and unrelated resources",
  "project portable selectors",
  "run the exact full uninstall command",
  "verify resource and lifecycle retirement",
  "restart the user Podman socket",
  "begin portable reinstall runtime selection",
] as const;

function sandboxCreateArgs(): string[] {
  return [
    "sandbox",
    "create",
    "-g",
    "nemoclaw",
    "--name",
    SANDBOX_NAME,
    "--from",
    BASE_IMAGE,
    "--policy",
    path.join(REPO_ROOT, "test/e2e/live/podman-cpu-lifecycle-policy.yaml"),
    "--no-tty",
    "--",
    "/bin/sh",
    "-lc",
    "true",
  ];
}

function unrelatedCreateArgs(): string[] {
  return [
    "create",
    "--name",
    UNRELATED_NAME,
    "--label",
    "com.nvidia.nemoclaw.e2e-unrelated=1",
    UNRELATED_IMAGE,
    "sleep",
    "infinity",
  ];
}

function writePortableUninstallSummary(artifactDir: string | undefined, uid: number): void {
  const writeSummary = artifactDir
    ? () => {
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
              sandboxImagePreserved: true,
              unrelatedImagesPreserved: true,
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
    : () => undefined;
  writeSummary();
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
    const openshellBin = executableOnPath("openshell");

    const homeDir = os.homedir();
    const stateDir = path.join(homeDir, ".nemoclaw");
    const configDir = path.join(homeDir, ".config", "nemoclaw");
    const registryFile = path.join(stateDir, "sandboxes.json");
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(fs.existsSync(configDir)).toBe(false);
    const gatewayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-uninstall-"));
    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: path.join(gatewayRoot, "cli-config"),
    };
    const previousPortableProfile = process.env.NEMOCLAW_EXPERIMENTAL_PROFILE;
    const createdContainerIds: string[] = [];
    const imageWasPresent = new Map(
      [UNRELATED_IMAGE, UNUSED_IMAGE].map((image) => [
        image,
        engine.capture(["image", "exists", image]).status === 0,
      ]),
    );
    let releaseProjectedSelectors = async (): Promise<void> => undefined;
    try {
      progress.phase("authenticate the workflow-owned pinned OpenShell gateway");
      process.env.NEMOCLAW_EXPERIMENTAL_PROFILE = "portable";
      expect(cliEnv.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR).toBeTruthy();
      expect(cliEnv.OPENSHELL_LOCAL_TLS_DIR).toBeTruthy();
      await runCommand(
        shellProbe,
        openshellBin,
        ["gateway", "add", "https://127.0.0.1:8080", "--local", "--name", "nemoclaw"],
        { artifactName: "podman-uninstall-add-gateway-nemoclaw", env: cliEnv },
      );
      const gatewayInfo = JSON.parse(
        await runCommand(
          shellProbe,
          openshellBin,
          ["gateway", "info", "-g", "nemoclaw", "-o", "json"],
          { artifactName: "podman-uninstall-gateway-info", env: cliEnv, timeoutMs: 10_000 },
        ),
      ) as { compute_drivers?: Array<{ name: string }>; status?: string };
      expect(gatewayInfo).toMatchObject({ status: "healthy" });
      expect(gatewayInfo.compute_drivers).toContainEqual(
        expect.objectContaining({ name: "podman" }),
      );

      progress.phase("create receipt-owned and unrelated resources");
      for (const image of imageWasPresent.keys()) {
        expect(engine.capture(["pull", image]).status).toBe(0);
      }
      await runCommand(shellProbe, openshellBin, sandboxCreateArgs(), {
        artifactName: "podman-uninstall-create-sandbox",
        env: cliEnv,
        timeoutMs: 240_000,
      });
      const sandboxInspection = inspectContainer(engine, SANDBOX_NAME);
      const sandboxContainerId = sandboxInspection.Id;
      const sandboxId = sandboxInspection.Config.Labels["openshell.ai/sandbox-id"];
      expect(sandboxId).toMatch(/^[A-Za-z0-9._:-]{1,256}$/u);
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
            sandboxId,
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
      releaseProjectedSelectors = async () => {
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
      };

      progress.phase("run the exact full uninstall command");
      await runCommand(shellProbe, nemoclawBin, UNINSTALL_ARGS, {
        artifactName: "podman-exact-full-uninstall",
        env: cliEnv,
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
      expect(postUninstallEngine.capture(["image", "exists", BASE_IMAGE]).status).toBe(0);
      expect(postUninstallEngine.capture(["image", "exists", UNRELATED_IMAGE]).status).toBe(0);
      expect(postUninstallEngine.capture(["image", "exists", UNUSED_IMAGE]).status).toBe(0);
      expect(fs.existsSync(receiptFile)).toBe(false);
      const retirementRecord = path.join(stateDir, "portable-uninstall-retirement.json");
      expect(fs.existsSync(retirementRecord)).toBe(true);
      expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(retirementRecord).mode & 0o777).toBe(0o600);
      const residualFiles = fs
        .readdirSync(stateDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .map((entry) => path.join(entry.parentPath, entry.name));
      expect(residualFiles).toEqual([retirementRecord]);
      expect(fs.readdirSync(path.dirname(expectedContainersConf))).toEqual([]);
      expect(fs.statSync(path.dirname(expectedContainersConf)).mode & 0o777).toBe(0o700);
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
      releaseProjectedSelectors = async (): Promise<void> => undefined;

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

      writePortableUninstallSummary(process.env.E2E_ARTIFACT_DIR, uid);
    } finally {
      await releaseProjectedSelectors();
      try {
        const cleanupAuthority = capturePodmanSocketAuthority(SOCKET_PATH);
        const cleanupEngine = createPodmanContainerEngine({
          operation: "sandbox-lifecycle",
          socketAuthority: cleanupAuthority,
        });
        for (const containerId of createdContainerIds.reverse()) {
          cleanupEngine.capture(["rm", "--force", containerId]);
        }
        for (const [image, existed] of imageWasPresent) {
          existed || cleanupEngine.capture(["image", "rm", image]);
        }
      } catch {
        // The workflow's always-run cleanup owns any resources left after a socket failure.
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(configDir, { recursive: true, force: true });
      await cleanupPodmanLifecycle({
        cliEnv,
        completed: true,
        createdSandboxes: [],
        engine,
        gateway: null,
        openshellBin,
        previousPortableProfile,
        root: gatewayRoot,
        shellProbe,
      });
    }
  },
);
