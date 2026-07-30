// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createPodmanOpenShellWatcherController,
  finalizePodmanManagedSandbox,
  findPodmanManagedSandboxContainerIds,
  type RunQualifiedPodmanCommand,
  recreatePodmanManagedSandbox,
  rollbackPodmanManagedSandbox,
} from "./sandbox-recreate";
import {
  buildPodmanManagedSandboxCreatePlan,
  parsePodmanManagedSandboxInspect,
  podmanImageMountSources,
} from "./sandbox-recreate-spec";
import {
  BACKUP_ID,
  CONTAINER_NAME,
  NETWORK_ID,
  NEW_ID,
  OLD_ID,
  parsedInspect,
  RESTORED_ID,
  ROOT_IMAGE_ID,
  SANDBOX_NAME,
  SECRET_ID,
  SOCKET_AUTHORITY,
  SOCKET_PATH,
  SUPERVISOR_IMAGE,
  SUPERVISOR_IMAGE_ID,
  validInspect,
} from "./sandbox-recreate-test-fixture";

function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1] !== undefined)
      values.push(args[index + 1] as string);
  }
  return values;
}

describe("Podman managed sandbox recreation specification", () => {
  it("pins the full root and supervisor images while preserving the managed container shape", () => {
    const inspect = parsedInspect();
    expect(podmanImageMountSources(inspect)).toEqual([SUPERVISOR_IMAGE]);
    const plan = buildPodmanManagedSandboxCreatePlan({
      command: ["node", "agent.js", "--serve"],
      imagePins: { [SUPERVISOR_IMAGE]: SUPERVISOR_IMAGE_ID },
      inspect,
      requiredUlimits: [
        { name: "nofile", soft: 65_536, hard: 65_536 },
        { name: "memlock", soft: -1, hard: -1 },
      ],
    });

    expect(plan.immutableImage).toBe(`sha256:${ROOT_IMAGE_ID}`);
    expect(plan.args.at(-2)).toBe(`sha256:${ROOT_IMAGE_ID}`);
    expect(plan.args.at(-1)).toBe("--operator-mode");
    expect(flagValues(plan.args, "--env")).toEqual([]);
    expect(flagValues(plan.args, "--env-file")).toEqual(["/dev/stdin"]);
    expect(plan.environmentInput.trimEnd().split("\n")).toEqual([
      "OPENSHELL_SANDBOX=alpha",
      "OPENSHELL_SANDBOX_COMMAND=node agent.js --serve",
      "OPENSHELL_SANDBOX_TOKEN_FILE=/etc/openshell/auth/sandbox.jwt",
      "OPENSHELL_TLS_CA=/etc/openshell/tls/client/ca.crt",
      "OPENSHELL_TLS_CERT=/etc/openshell/tls/client/tls.crt",
      "OPENSHELL_TLS_KEY=/etc/openshell/tls/client/tls.key",
      "USER_VALUE=preserved",
    ]);
    expect(plan.args.some((argument) => argument.includes("USER_VALUE"))).toBe(false);
    expect(plan.args).toContain("--http-proxy=false");
    expect(flagValues(plan.args, "--label")).toEqual([
      "custom.label=preserved",
      "openshell.managed=true",
      "openshell.sandbox-id=sandbox-id",
      "openshell.sandbox-name=alpha",
      "openshell.sandbox-namespace=",
    ]);
    expect(flagValues(plan.args, "--mount")).toEqual(
      expect.arrayContaining([
        "type=volume,source=openshell-sandbox-sandbox-id-workspace,destination=/sandbox,ro=false",
        `type=image,source=sha256:${SUPERVISOR_IMAGE_ID},destination=/opt/openshell/bin,rw=false`,
        "type=bind,source=/run/openshell/tls/tls.key,destination=/etc/openshell/tls/client/tls.key,ro=true,bind-propagation=rprivate",
      ]),
    );
    expect(flagValues(plan.args, "--secret")).toEqual([
      `${SECRET_ID},type=mount,target=/etc/openshell/auth/sandbox.jwt,uid=0,gid=0,mode=0400`,
    ]);
    expect(flagValues(plan.args, "--ulimit")).toEqual(["memlock=-1:-1", "nofile=65536:65536"]);
    expect(flagValues(plan.args, "--network")).toEqual([NETWORK_ID]);
    expect(flagValues(plan.args, "--publish")).toEqual(["127.0.0.1:41022:22/tcp"]);
    expect(flagValues(plan.args, "--health-cmd")).toEqual([
      '["CMD","/opt/openshell/bin/openshell-sandbox","__healthcheck"]',
    ]);
    expect(flagValues(plan.args, "--tmpfs")).toEqual(["/run/netns:rw,nosuid,nodev"]);
    expect(flagValues(plan.args, "--cap-add")).toEqual(["CAP_SYS_ADMIN", "CAP_NET_ADMIN"]);
    expect(flagValues(plan.args, "--security-opt")).toEqual([
      "no-new-privileges",
      "seccomp=unconfined",
    ]);
    expect(flagValues(plan.args, "--cpu-period")).toEqual(["100000"]);
    expect(flagValues(plan.args, "--cpu-quota")).toEqual(["200000"]);
    expect(flagValues(plan.args, "--memory")).toEqual(["4294967296"]);
    expect(flagValues(plan.args, "--pids-limit")).toEqual(["256"]);
    expect(flagValues(plan.args, "--add-host")).toEqual([
      "host.containers.internal:host-gateway",
      "host.openshell.internal:host-gateway",
    ]);
  });

  it.each([
    {
      label: "short container IDs",
      mutate: (value: Record<string, unknown>) => {
        value.Id = "abc123";
      },
      message: "full immutable SHA-256",
    },
    {
      label: "missing exact managed label",
      mutate: (value: Record<string, unknown>) => {
        (value.Config as Record<string, unknown>).Labels = {
          "openshell.managed": "true",
          "openshell.sandbox-name": "other",
        };
      },
      message: "missing exact label",
    },
    {
      label: "multiple inspect records",
      mutate: (value: Record<string, unknown>) => {
        value.__multiple = true;
      },
      message: "exactly one",
    },
  ])("rejects $label before planning", ({ mutate, message }) => {
    const value = validInspect();
    mutate(value);
    const payload = value.__multiple ? [value, value] : [value];
    expect(() =>
      parsePodmanManagedSandboxInspect(JSON.stringify(payload), {
        containerId: String(value.Id),
        name: CONTAINER_NAME,
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow(message);
  });

  it.each([
    "openshell.sandbox-id",
    "openshell.sandbox-namespace",
  ])("requires the exact v0.0.85 %s identity label", (label) => {
    const value = validInspect();
    delete ((value.Config as Record<string, unknown>).Labels as Record<string, unknown>)[label];
    expect(() => parsedInspect(value)).toThrow(`missing exact label ${label}`);
  });

  it.each([
    {
      label: "workspace mount",
      mutate: (value: Record<string, unknown>) => {
        value.Mounts = (value.Mounts as unknown[]).slice(1);
      },
      message: "workspace",
    },
    {
      label: "workspace identity",
      mutate: (value: Record<string, unknown>) => {
        const workspace = (value.Mounts as Array<Record<string, unknown>>).find(
          (mount) => mount.Destination === "/sandbox",
        );
        if (workspace) workspace.Name = "openshell-sandbox-other-workspace";
      },
      message: "workspace",
    },
    {
      label: "supervisor image mount",
      mutate: (value: Record<string, unknown>) => {
        value.Mounts = (value.Mounts as Array<Record<string, unknown>>).filter(
          (mount) => mount.Type !== "image",
        );
      },
      message: "supervisor image",
    },
    {
      label: "TLS bind evidence",
      mutate: (value: Record<string, unknown>) => {
        value.Mounts = (value.Mounts as Array<Record<string, unknown>>).filter(
          (mount) => mount.Destination !== "/etc/openshell/tls/client/tls.key",
        );
      },
      message: "TLS mount",
    },
    {
      label: "token secret evidence",
      mutate: (value: Record<string, unknown>) => {
        (value.Config as Record<string, unknown>).Secrets = [];
      },
      message: "token secret",
    },
    {
      label: "token secret sandbox identity",
      mutate: (value: Record<string, unknown>) => {
        const secrets = (value.Config as Record<string, unknown>).Secrets as Array<
          Record<string, unknown>
        >;
        if (secrets[0]) secrets[0].Name = "openshell-token-other-id";
      },
      message: "exact OpenShell sandbox ID",
    },
    {
      label: "deterministic secret target",
      mutate: (value: Record<string, unknown>) => {
        (value.Config as Record<string, unknown>).Secrets = [
          { Name: "arbitrary-secret", ID: SECRET_ID, UID: 0, GID: 0, Mode: 0o400 },
        ];
      },
      message: "no deterministic OpenShell target",
    },
    {
      label: "single network",
      mutate: (value: Record<string, unknown>) => {
        const settings = value.NetworkSettings as Record<string, unknown>;
        settings.Networks = { openshell: {}, second: {} };
      },
      message: "exactly one attached",
    },
    {
      label: "immutable network identity",
      mutate: (value: Record<string, unknown>) => {
        const settings = value.NetworkSettings as Record<string, unknown>;
        const networks = settings.Networks as Record<string, Record<string, unknown>>;
        delete networks.openshell?.NetworkID;
      },
      message: "network 'openshell' ID",
    },
    {
      label: "unsupported device inference",
      mutate: (value: Record<string, unknown>) => {
        (value.HostConfig as Record<string, unknown>).Devices = [{ PathOnHost: "/dev/nvidia0" }];
      },
      message: "devices cannot be reproduced",
    },
    {
      label: "redacted env secrets",
      mutate: (value: Record<string, unknown>) => {
        (value.Config as Record<string, unknown>).Env = ["SECRET=*******"];
      },
      message: "env-type secrets",
    },
    {
      label: "non-neutral memory swappiness",
      mutate: (value: Record<string, unknown>) => {
        (value.HostConfig as Record<string, unknown>).MemorySwappiness = 1;
      },
      message: "non-neutral memory swappiness",
    },
  ])("fails closed without faithful $label", ({ mutate, message }) => {
    const value = validInspect();
    mutate(value);
    const inspect = parsedInspect(value);
    expect(() =>
      buildPodmanManagedSandboxCreatePlan({
        command: ["node", "agent.js"],
        imagePins: { [SUPERVISOR_IMAGE]: SUPERVISOR_IMAGE_ID },
        inspect,
      }),
    ).toThrow(message);
  });

  it("requires every image mount to be resolved to a full immutable image ID", () => {
    expect(() =>
      buildPodmanManagedSandboxCreatePlan({
        command: ["node", "agent.js"],
        imagePins: {},
        inspect: parsedInspect(),
      }),
    ).toThrow("was not pinned");
  });

  it.each([-1, 0])("accepts Podman v5 rootless cgroup-v2 neutral swappiness %s", (value) => {
    const raw = validInspect();
    (raw.HostConfig as Record<string, unknown>).MemorySwappiness = value;
    expect(() =>
      buildPodmanManagedSandboxCreatePlan({
        command: ["node", "agent.js"],
        imagePins: { [SUPERVISOR_IMAGE]: SUPERVISOR_IMAGE_ID },
        inspect: parsedInspect(raw),
      }),
    ).not.toThrow();
  });
});

type FakePodmanOptions = {
  discovery?: "normal" | "multiple" | "none";
  fail?: {
    action: string;
    afterEffect?: boolean;
    occurrence?: number;
    status: number | null;
    stderr?: string;
  };
  dropReplacementUlimits?: boolean;
  failedCreateLeavesUnowned?: boolean;
  mutateOldUserOnSecondInspect?: boolean;
  omitCidFile?: boolean;
  oldRestartsWhenReplacementStarts?: boolean;
  oldExitsAfterStart?: boolean;
  replacementCommandValue?: string;
  replacementUser?: string;
  throwCreateMessage?: string;
  throwCreateAfterEffectMessage?: string;
};

function fakePodman(options: FakePodmanOptions = {}) {
  let watcherStopped = false;
  let oldExists = true;
  let oldName = CONTAINER_NAME;
  let oldRunning = true;
  let backupExists = false;
  let backupRunning = false;
  let backupName = "";
  let restoredExists = false;
  let restoredRunning = false;
  let newExists = false;
  let newRunning = false;
  let backupEnvironment: string[] | null = null;
  let backupUlimits: Array<{ Hard: number; Name: string; Soft: number }> | null = null;
  let backupUser = "0:0";
  let replacementEnvironment: string[] | null = null;
  let replacementUlimits: Array<{ Hard: number; Name: string; Soft: number }> | null = null;
  let replacementUser = options.replacementUser ?? "0:0";
  let oldInspectCount = 0;
  const calls: Array<{
    args: readonly string[];
    command: string;
    input?: string;
    watcherStopped: boolean;
  }> = [];
  const failureCounts = new Map<string, number>();
  const fail = (action: string) => {
    const occurrence = (failureCounts.get(action) ?? 0) + 1;
    failureCounts.set(action, occurrence);
    return options.fail?.action === action &&
      (options.fail.occurrence === undefined || options.fail.occurrence === occurrence)
      ? { status: options.fail.status, stderr: options.fail.stderr ?? `${action} failed` }
      : null;
  };
  const inspect = (id: string) => {
    const old = id === OLD_ID;
    const backup = id === BACKUP_ID;
    const restored = id === RESTORED_ID;
    const raw = validInspect({
      Id: id,
      Name: old ? oldName : backup ? backupName : CONTAINER_NAME,
      State: {
        Running: old
          ? oldRunning
          : backup
            ? backupRunning
            : restored
              ? restoredRunning
              : newRunning,
      },
    });
    if (old && options.mutateOldUserOnSecondInspect && oldInspectCount >= 2) {
      (raw.Config as Record<string, unknown>).User = "1000:1000";
    } else if (backup) {
      const config = raw.Config as Record<string, unknown>;
      config.Labels = { "custom.label": "preserved" };
      config.User = backupUser;
      if (backupEnvironment) config.Env = backupEnvironment;
      if (backupUlimits) (raw.HostConfig as Record<string, unknown>).Ulimits = backupUlimits;
    } else if (!old) {
      const config = raw.Config as Record<string, unknown>;
      config.User = restored ? "0:0" : replacementUser;
      if (restored && backupEnvironment) {
        config.Env = backupEnvironment;
      } else if (replacementEnvironment) {
        config.Env = replacementEnvironment.map((entry) =>
          options.replacementCommandValue !== undefined &&
          entry.startsWith("OPENSHELL_SANDBOX_COMMAND=")
            ? `OPENSHELL_SANDBOX_COMMAND=${options.replacementCommandValue}`
            : entry,
        );
      }
      if (restored && backupUlimits) {
        (raw.HostConfig as Record<string, unknown>).Ulimits = backupUlimits;
      } else if (replacementUlimits && !options.dropReplacementUlimits) {
        (raw.HostConfig as Record<string, unknown>).Ulimits = replacementUlimits;
      }
    }
    const settings = raw.NetworkSettings as Record<string, unknown>;
    const networks = settings.Networks as Record<string, Record<string, unknown>>;
    networks.openshell = {
      ...(networks.openshell ?? {}),
      Aliases: [id, id.slice(0, 12), old ? oldName : backup ? backupName : CONTAINER_NAME],
    };
    return JSON.stringify([raw]);
  };
  const create = (podmanArgs: readonly string[], inputValue: unknown) => {
    const name = flagValues(podmanArgs, "--name")[0] ?? "";
    const input = typeof inputValue === "string" ? inputValue.trimEnd().split("\n") : [];
    const isBackup = name !== CONTAINER_NAME;
    const isRestore =
      !isBackup && input.some((entry) => entry === "OPENSHELL_SANDBOX_COMMAND=sleep infinity");
    if (isRestore && newExists) return { status: 125, stderr: "name is in use" };
    if (!isBackup && !isRestore && options.throwCreateMessage) {
      throw new Error(options.throwCreateMessage);
    }
    const failed = isBackup || isRestore ? null : fail("create-new");
    if (failed && !options.fail?.afterEffect) {
      if (options.failedCreateLeavesUnowned) {
        newExists = true;
        newRunning = true;
      }
      return failed;
    }
    const cidFile = flagValues(podmanArgs, "--cidfile")[0];
    if (!cidFile) throw new Error("Fake Podman create requires --cidfile.");
    const ulimits = flagValues(podmanArgs, "--ulimit").map((entry) => {
      const [name = "", limits = ""] = entry.split("=", 2);
      const [soft = "", hard = ""] = limits.split(":", 2);
      return { Hard: Number(hard), Name: name, Soft: Number(soft) };
    });
    const createdId = isBackup ? BACKUP_ID : isRestore ? RESTORED_ID : NEW_ID;
    if (isBackup) {
      backupExists = true;
      backupName = name;
      backupEnvironment = input;
      backupUlimits = ulimits;
    } else if (isRestore) {
      restoredExists = true;
    } else {
      replacementEnvironment = input;
      replacementUlimits = ulimits;
      newExists = true;
    }
    if (!options.omitCidFile || isBackup || isRestore) {
      writeFileSync(cidFile, `${createdId}\n`, "utf-8");
    }
    if (!isBackup && !isRestore && options.throwCreateAfterEffectMessage) {
      throw new Error(options.throwCreateAfterEffectMessage);
    }
    return failed
      ? { ...failed, stdout: `${createdId}\n` }
      : { status: 0, stdout: `${createdId}\n` };
  };
  const run: RunQualifiedPodmanCommand = vi.fn((command, args, spawnOptions) => {
    calls.push({
      command,
      args: [...args],
      input: typeof spawnOptions.input === "string" ? spawnOptions.input : undefined,
      watcherStopped,
    });
    expect(command).toBe("podman");
    expect(args.slice(0, 2)).toEqual(["--url", `unix://${SOCKET_PATH}`]);
    const podmanArgs = args.slice(2);
    if (podmanArgs[0] === "ps") {
      const failed = fail("discover");
      if (failed) return failed;
      if (options.discovery === "none") return { status: 0, stdout: "" };
      const visible = newExists
        ? `${NEW_ID}\t${CONTAINER_NAME}`
        : restoredExists
          ? `${RESTORED_ID}\t${CONTAINER_NAME}`
          : oldExists && oldName === CONTAINER_NAME
            ? `${OLD_ID}\t${oldName}`
            : "";
      return {
        status: 0,
        stdout:
          options.discovery === "multiple"
            ? `${visible}\n${"e".repeat(64)}\t${CONTAINER_NAME}`
            : `${visible}\n`,
      };
    }
    if (podmanArgs[0] === "info") {
      const failed = fail("info");
      if (failed) return failed;
      return {
        status: 0,
        stdout: JSON.stringify({
          host: { security: { rootless: true } },
          store: {
            graphRoot: "/home/test/.local/share/containers/storage",
            runRoot: "/run/user/1000/containers",
          },
        }),
      };
    }
    if (podmanArgs[0] === "container" && podmanArgs[1] === "inspect") {
      const id = String(podmanArgs[2]);
      const failed = fail(id === NEW_ID ? "inspect-new" : id === OLD_ID ? "inspect-old" : "");
      if (failed) return failed;
      if (
        (id === OLD_ID && !oldExists) ||
        (id === BACKUP_ID && !backupExists) ||
        (id === RESTORED_ID && !restoredExists) ||
        (id === NEW_ID && !newExists)
      ) {
        return { status: 125, stderr: "no such container" };
      }
      if (![OLD_ID, BACKUP_ID, RESTORED_ID, NEW_ID].includes(id)) {
        return { status: 125, stderr: "no such container" };
      }
      if (id === OLD_ID) oldInspectCount += 1;
      return { status: 0, stdout: inspect(id) };
    }
    if (podmanArgs[0] === "container" && podmanArgs[1] === "exists") {
      const id = String(podmanArgs[2]);
      return {
        status:
          (id === OLD_ID && oldExists) ||
          (id === BACKUP_ID && backupExists) ||
          (id === RESTORED_ID && restoredExists) ||
          (id === NEW_ID && newExists)
            ? 0
            : 1,
      };
    }
    if (podmanArgs[0] === "image" && podmanArgs[1] === "inspect") {
      const failed = fail("pin-image");
      return failed ?? { status: 0, stdout: `sha256:${SUPERVISOR_IMAGE_ID}\n` };
    }
    if (podmanArgs[0] === "stop") {
      const id = String(podmanArgs[1]);
      const failed = fail(
        id === OLD_ID
          ? "stop-old"
          : id === BACKUP_ID
            ? "stop-backup"
            : id === NEW_ID
              ? "stop-new"
              : "stop-restored",
      );
      if (failed && !options.fail?.afterEffect) return failed;
      if (id === OLD_ID) oldRunning = false;
      else if (id === BACKUP_ID) backupRunning = false;
      else if (id === RESTORED_ID) restoredRunning = false;
      else newRunning = false;
      return failed ?? { status: 0 };
    }
    if (podmanArgs[0] === "create") {
      return create(podmanArgs, spawnOptions.input);
    }
    if (podmanArgs[0] === "start") {
      const id = String(podmanArgs[1]);
      const failed = fail(
        id === NEW_ID ? "start-new" : id === RESTORED_ID ? "start-old" : "start-backup",
      );
      if (failed && !options.fail?.afterEffect) return failed;
      if (id === OLD_ID) oldRunning = !options.oldExitsAfterStart;
      else if (id === RESTORED_ID) restoredRunning = !options.oldExitsAfterStart;
      else if (id === BACKUP_ID) backupRunning = true;
      else {
        newRunning = true;
        if (options.oldRestartsWhenReplacementStarts) backupRunning = true;
      }
      return failed ?? { status: 0 };
    }
    if (podmanArgs[0] === "rm") {
      const id = String(podmanArgs[1]);
      const failed = fail(
        id === BACKUP_ID ? "remove-backup" : id === NEW_ID ? "remove-new" : "remove-original",
      );
      if (failed && !options.fail?.afterEffect) return failed;
      if (
        (id === OLD_ID && oldRunning) ||
        (id === BACKUP_ID && backupRunning) ||
        (id === RESTORED_ID && restoredRunning) ||
        (id === NEW_ID && newRunning)
      ) {
        return { status: 125, stderr: "container is running" };
      }
      if (id === NEW_ID) newExists = false;
      else if (id === BACKUP_ID) backupExists = false;
      else if (id === RESTORED_ID) restoredExists = false;
      else oldExists = false;
      return failed ?? { status: 0 };
    }
    throw new Error(`Unexpected fake Podman call: ${podmanArgs.join(" ")}`);
  });
  return {
    calls,
    run,
    setReplacementUser: (value: string) => {
      replacementUser = value;
    },
    setBackupUser: (value: string) => {
      backupUser = value;
    },
    setOldRunning: (value: boolean) => {
      if (backupExists) backupRunning = value;
      else if (restoredExists) restoredRunning = value;
      else oldRunning = value;
    },
    setWatcherStopped: (value: boolean) => {
      watcherStopped = value;
    },
    removeReplacement: () => {
      newExists = false;
      newRunning = false;
    },
    state: () => ({
      backupExists,
      backupName,
      backupRunning,
      newExists,
      newRunning,
      oldExists,
      oldName,
      oldRunning,
      restoredExists,
      restoredRunning,
      watcherStopped,
    }),
  };
}

function watcherController(fake: ReturnType<typeof fakePodman>) {
  return createPodmanOpenShellWatcherController({
    stopAndProve: () => {
      fake.setWatcherStopped(true);
      return { stopped: true };
    },
    assertStopped: () => {
      if (!fake.state().watcherStopped) throw new Error("watcher is not stopped");
    },
    resumeAndProve: () => {
      fake.setWatcherStopped(false);
    },
  });
}

function recreateWith(fake: ReturnType<typeof fakePodman>, assertSocketAuthority = vi.fn()) {
  return recreatePodmanManagedSandbox(
    {
      command: ["node", "agent.js"],
      requiredUlimits: [{ name: "nofile", soft: 65_536, hard: 65_536 }],
      sandboxName: SANDBOX_NAME,
      socketAuthority: SOCKET_AUTHORITY,
      socketPath: SOCKET_PATH,
      watcherController: watcherController(fake),
    },
    {
      assertSocketAuthority,
      now: () => new Date(1_700_000_000_000),
      run: fake.run,
    },
  );
}

describe("Podman managed sandbox recreation lifecycle", () => {
  it("rejects a mismatched socket authority before the first Podman discovery call", () => {
    const run = vi.fn<RunQualifiedPodmanCommand>();
    expect(() =>
      findPodmanManagedSandboxContainerIds("/run/user/1000/podman/replaced.sock", SANDBOX_NAME, {
        assertSocketAuthority: vi.fn(),
        run,
        socketAuthority: SOCKET_AUTHORITY,
      }),
    ).toThrow("socket authority does not match");
    expect(run).not.toHaveBeenCalled();
  });

  it("requires a watcher controller before any Podman operation", () => {
    const fake = fakePodman();
    expect(() =>
      recreatePodmanManagedSandbox(
        {
          command: ["node", "agent.js"],
          sandboxName: SANDBOX_NAME,
          socketAuthority: SOCKET_AUTHORITY,
          socketPath: SOCKET_PATH,
          watcherController: undefined as never,
        },
        { assertSocketAuthority: vi.fn(), run: fake.run },
      ),
    ).toThrow("watcher controller");
    expect(fake.calls).toHaveLength(0);
  });

  it("qualifies every operation to the exact socket and starts a pinned replacement", () => {
    const fake = fakePodman();
    const assertSocketAuthority = vi.fn();
    const transaction = recreateWith(fake, assertSocketAuthority);
    expect(transaction).toMatchObject({
      applied: true,
      backupContainerId: BACKUP_ID,
      backupContainerName: "openshell-sandbox-alpha-nemoclaw-backup-1700000000000",
      backupSemanticDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      command: ["node", "agent.js"],
      driverName: "podman",
      immutableImage: `sha256:${ROOT_IMAGE_ID}`,
      newContainerId: NEW_ID,
      oldContainerId: OLD_ID,
      originalLabels: {
        "custom.label": "preserved",
        "openshell.managed": "true",
        "openshell.sandbox-id": "sandbox-id",
        "openshell.sandbox-name": SANDBOX_NAME,
        "openshell.sandbox-namespace": "",
      },
      originalName: CONTAINER_NAME,
      originalSemanticDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      requiredUlimits: [{ name: "nofile", soft: 65_536, hard: 65_536 }],
      sandboxName: SANDBOX_NAME,
      semanticDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      socketPath: SOCKET_PATH,
    });
    expect(fake.state()).toMatchObject({
      backupExists: true,
      backupName: transaction.backupContainerName,
      backupRunning: false,
      newExists: true,
      newRunning: true,
      oldExists: false,
      oldRunning: false,
      watcherStopped: false,
    });
    expect(fake.calls.every((call) => call.args[0] === "--url")).toBe(true);
    expect(fake.calls.every((call) => call.args[1] === `unix://${SOCKET_PATH}`)).toBe(true);
    expect(assertSocketAuthority).toHaveBeenCalledTimes(fake.calls.length + 1);
    expect(fake.calls.map((call) => call.command)).not.toContain("docker");
    expect(fake.calls.map((call) => call.args.slice(2, 4))).toContainEqual(["start", NEW_ID]);
    const createCall = fake.calls.find(
      (call) =>
        call.args[2] === "create" && flagValues(call.args.slice(2), "--name")[0] === CONTAINER_NAME,
    );
    expect(createCall?.args.some((argument) => argument.includes("USER_VALUE=preserved"))).toBe(
      false,
    );
    expect(createCall?.input).toContain("USER_VALUE=preserved");
    const backupCreateCall = fake.calls.find(
      (call) =>
        call.args[2] === "create" &&
        flagValues(call.args.slice(2), "--name")[0] === transaction.backupContainerName,
    );
    expect(flagValues(backupCreateCall?.args.slice(2) ?? [], "--label")).toEqual([
      "custom.label=preserved",
    ]);
    expect(backupCreateCall?.watcherStopped).toBe(false);
    expect(
      flagValues(backupCreateCall?.args.slice(2) ?? [], "--label").some((label) =>
        label.startsWith("openshell."),
      ),
    ).toBe(false);
    expect(
      fake.calls.find((call) => call.args[2] === "rm" && call.args[3] === OLD_ID)?.watcherStopped,
    ).toBe(true);
  });

  it("does not send the first destructive command after socket authority changes", () => {
    const baseline = fakePodman();
    recreateWith(baseline);
    const stopIndex = baseline.calls.findIndex(
      (call) => call.args[2] === "stop" && call.args[3] === OLD_ID,
    );
    expect(stopIndex).toBeGreaterThan(0);

    const fake = fakePodman();
    let validations = 0;
    expect(() =>
      recreateWith(
        fake,
        vi.fn(() => {
          validations += 1;
          if (validations >= stopIndex + 2) {
            throw new Error("socket path replaced");
          }
        }),
      ),
    ).toThrow();

    expect(fake.calls.some((call) => call.args[2] === "stop" && call.args[3] === OLD_ID)).toBe(
      false,
    );
    expect(fake.state()).toMatchObject({
      oldExists: true,
      oldRunning: true,
      watcherStopped: false,
    });
  });

  it("recovers the watcher and leaves the managed original untouched when stop proof fails", () => {
    const fake = fakePodman();
    const controller = createPodmanOpenShellWatcherController({
      stopAndProve: () => {
        fake.setWatcherStopped(true);
        return { stopped: true };
      },
      assertStopped: () => {
        throw new Error("stop receipt rejected");
      },
      resumeAndProve: () => {
        fake.setWatcherStopped(false);
      },
    });
    expect(() =>
      recreatePodmanManagedSandbox(
        {
          command: ["node", "agent.js"],
          sandboxName: SANDBOX_NAME,
          socketAuthority: SOCKET_AUTHORITY,
          socketPath: SOCKET_PATH,
          watcherController: controller,
        },
        {
          assertSocketAuthority: vi.fn(),
          now: () => new Date(1_700_000_000_000),
          run: fake.run,
        },
      ),
    ).toThrow("stop proof failed");
    expect(fake.calls.some((call) => call.args[2] === "rm" && call.args[3] === OLD_ID)).toBe(false);
    expect(fake.state()).toMatchObject({
      backupExists: false,
      oldExists: true,
      oldRunning: true,
      watcherStopped: false,
    });
  });

  it("recovers before mutation when the exact rootless Podman API proof fails", () => {
    const fake = fakePodman({ fail: { action: "info", status: 125 } });
    let error: unknown;
    try {
      recreateWith(fake);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: true });
    expect(String(error)).toContain("cutover preflight failed");
    expect(fake.calls.some((call) => call.args[2] === "rm" && call.args[3] === OLD_ID)).toBe(false);
    expect(fake.state()).toMatchObject({
      backupExists: false,
      oldExists: true,
      oldRunning: true,
      watcherStopped: false,
    });
  });

  it.each([
    { occurrence: 3, restoredContainer: "old" },
    { occurrence: 4, restoredContainer: "recreated" },
  ])("restores service when Podman proof $occurrence fails after mutation begins", ({
    occurrence,
    restoredContainer,
  }) => {
    const fake = fakePodman({
      fail: { action: "info", occurrence, status: 125 },
    });
    let error: unknown;
    try {
      recreateWith(fake);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: true });
    expect(fake.state()).toMatchObject({
      backupExists: false,
      oldRunning: restoredContainer === "old",
      restoredRunning: restoredContainer === "recreated",
      watcherStopped: false,
    });
  });

  it("rolls back under the held lease when the first watcher restart attempt fails", () => {
    const fake = fakePodman();
    let resumeAttempts = 0;
    const controller = createPodmanOpenShellWatcherController({
      stopAndProve: () => {
        fake.setWatcherStopped(true);
        return { stopped: true };
      },
      assertStopped: () => {
        if (!fake.state().watcherStopped) throw new Error("watcher is not stopped");
      },
      resumeAndProve: () => {
        resumeAttempts += 1;
        if (resumeAttempts === 1) throw new Error("watcher restart unavailable");
        fake.setWatcherStopped(false);
      },
    });
    let error: unknown;
    try {
      recreatePodmanManagedSandbox(
        {
          command: ["node", "agent.js"],
          sandboxName: SANDBOX_NAME,
          socketAuthority: SOCKET_AUTHORITY,
          socketPath: SOCKET_PATH,
          watcherController: controller,
        },
        {
          assertSocketAuthority: vi.fn(),
          now: () => new Date(1_700_000_000_000),
          run: fake.run,
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: true });
    expect(resumeAttempts).toBe(2);
    expect(
      fake.calls.find((call) => call.args[2] === "rm" && call.args[3] === NEW_ID)?.watcherStopped,
    ).toBe(true);
    expect(fake.state()).toMatchObject({
      backupExists: false,
      newExists: false,
      restoredExists: true,
      restoredRunning: true,
      watcherStopped: false,
    });
  });

  it("retains rollback evidence and fails closed when watcher restart cannot be proven", () => {
    const fake = fakePodman();
    const controller = createPodmanOpenShellWatcherController({
      stopAndProve: () => {
        fake.setWatcherStopped(true);
        return { stopped: true };
      },
      assertStopped: () => {
        if (!fake.state().watcherStopped) throw new Error("watcher is not stopped");
      },
      resumeAndProve: () => {
        throw new Error("watcher restart unavailable");
      },
    });
    let error: unknown;
    try {
      recreatePodmanManagedSandbox(
        {
          command: ["node", "agent.js"],
          sandboxName: SANDBOX_NAME,
          socketAuthority: SOCKET_AUTHORITY,
          socketPath: SOCKET_PATH,
          watcherController: controller,
        },
        {
          assertSocketAuthority: vi.fn(),
          now: () => new Date(1_700_000_000_000),
          run: fake.run,
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: false });
    expect(fake.state()).toMatchObject({
      backupExists: true,
      newExists: false,
      restoredExists: true,
      restoredRunning: true,
      watcherStopped: true,
    });
  });

  it.each([null, 1])("does not mutate when stop leaves the original running (%s)", (status) => {
    const fake = fakePodman({ fail: { action: "stop-old", status } });
    expect(() => recreateWith(fake)).toThrow("remains running");
    expect(fake.state()).toMatchObject({
      backupExists: false,
      oldExists: true,
      oldName: CONTAINER_NAME,
      oldRunning: true,
      watcherStopped: false,
    });
    expect(fake.calls.some((call) => call.args[2] === "rename")).toBe(false);
  });

  it.each([
    "stop-old",
    "remove-original",
    "start-new",
  ])("reconciles an unavailable %s status from exact inspect state", (action) => {
    const fake = fakePodman({ fail: { action, afterEffect: true, status: null } });
    expect(recreateWith(fake)).toMatchObject({ applied: true, newContainerId: NEW_ID });
    expect(fake.state()).toMatchObject({
      backupExists: true,
      backupName: "openshell-sandbox-alpha-nemoclaw-backup-1700000000000",
      newRunning: true,
      oldExists: false,
      oldRunning: false,
      watcherStopped: false,
    });
  });

  it("restores the exact original when stop-state inspection is temporarily unavailable", () => {
    const fake = fakePodman({
      fail: { action: "inspect-old", occurrence: 3, status: null },
    });
    let error: unknown;
    try {
      recreateWith(fake);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: true });
    expect(fake.state()).toMatchObject({
      oldExists: true,
      oldRunning: true,
      watcherStopped: false,
    });
    expect(fake.calls.some((call) => call.args[2] === "rename")).toBe(false);
  });

  it("rejects an in-place semantic change on the pinned original before mutation", () => {
    const fake = fakePodman({ mutateOldUserOnSecondInspect: true });
    expect(() => recreateWith(fake)).toThrow("pinned recreation semantics");
    expect(fake.calls.some((call) => call.args[2] === "stop")).toBe(false);
    expect(fake.state()).toMatchObject({
      oldName: CONTAINER_NAME,
      oldRunning: true,
    });
  });

  it.each([
    {
      label: "container user",
      options: { replacementUser: "1000:1000" },
    },
    {
      label: "startup command environment",
      options: { replacementCommandValue: "wrong command" },
    },
    {
      label: "required ulimit",
      options: { dropReplacementUlimits: true },
    },
  ])("rolls back before start when Podman changes the replacement $label", ({ options }) => {
    const fake = fakePodman(options);
    let error: unknown;
    try {
      recreateWith(fake);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: true });
    expect(fake.calls.map((call) => call.args.slice(2, 4))).not.toContainEqual(["start", NEW_ID]);
    expect(fake.state()).toMatchObject({
      newExists: false,
      restoredExists: true,
      restoredRunning: true,
      watcherStopped: false,
    });
  });

  it("removes a cidfile-owned replacement and redacts env values when create throws", () => {
    const fake = fakePodman({
      throwCreateAfterEffectMessage: "create wrapper exposed USER_VALUE=preserved",
    });
    let error: unknown;
    try {
      recreateWith(fake);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: true });
    expect(String(error)).not.toContain("preserved");
    expect(String(error)).toContain("[REDACTED]");
    expect(fake.state()).toMatchObject({
      newExists: false,
      restoredExists: true,
      restoredRunning: true,
      watcherStopped: false,
    });
  });

  it("uses unambiguous stdout ownership when create status is unavailable", () => {
    const fake = fakePodman({
      fail: { action: "create-new", afterEffect: true, status: null },
      omitCidFile: true,
    });
    let error: unknown;
    try {
      recreateWith(fake);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: true });
    expect(fake.state()).toMatchObject({
      newExists: false,
      restoredExists: true,
      restoredRunning: true,
      watcherStopped: false,
    });
  });

  it("never deletes a concurrent exact-name container without create ownership evidence", () => {
    const fake = fakePodman({
      fail: { action: "create-new", status: 125 },
      failedCreateLeavesUnowned: true,
    });
    let error: unknown;
    try {
      recreateWith(fake);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: false });
    expect(
      fake.calls.some(
        (call) => ["stop", "rm"].includes(String(call.args[2])) && call.args[3] === NEW_ID,
      ),
    ).toBe(false);
    expect(fake.state()).toMatchObject({
      backupExists: true,
      backupName: "openshell-sandbox-alpha-nemoclaw-backup-1700000000000",
      newExists: true,
      newRunning: true,
      oldExists: false,
      restoredExists: false,
      watcherStopped: false,
    });
  });

  it("does not report rollback complete when the restored original exits immediately", () => {
    const fake = fakePodman({
      fail: { action: "create-new", status: 125 },
      oldExitsAfterStart: true,
    });
    let error: unknown;
    try {
      recreateWith(fake);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: false });
    expect(fake.state()).toMatchObject({
      restoredExists: true,
      restoredRunning: false,
      watcherStopped: false,
    });
  });

  it("rolls back if the pinned backup restarts while the replacement is verified", () => {
    const fake = fakePodman({ oldRestartsWhenReplacementStarts: true });
    let error: unknown;
    try {
      recreateWith(fake);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: true });
    expect(fake.state()).toMatchObject({
      newExists: false,
      restoredExists: true,
      restoredRunning: true,
      watcherStopped: false,
    });
  });

  it("restores the original when replacement startup fails", () => {
    const fake = fakePodman({ fail: { action: "start-new", status: 125 } });
    let error: unknown;
    try {
      recreateWith(fake);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: true });
    expect(fake.state()).toMatchObject({
      backupExists: false,
      newExists: false,
      newRunning: false,
      oldExists: false,
      restoredExists: true,
      restoredRunning: true,
      watcherStopped: false,
    });
  });

  it("reports a rollback failure at the first non-zero cleanup gate", () => {
    const fake = fakePodman({ fail: { action: "stop-new", status: null } });
    const transaction = recreateWith(fake);
    expect(
      rollbackPodmanManagedSandbox(
        { transaction, watcherController: watcherController(fake) },
        { assertSocketAuthority: vi.fn(), run: fake.run },
      ),
    ).toEqual({
      originalRecreated: false,
      originalStarted: false,
      replacementRemoved: false,
      rolledBack: false,
    });
    expect(fake.state()).toMatchObject({
      backupExists: true,
      newExists: true,
      watcherStopped: false,
    });
  });

  it("restores the backup when the pinned replacement was already removed", () => {
    const fake = fakePodman();
    const transaction = recreateWith(fake);
    fake.removeReplacement();
    expect(
      rollbackPodmanManagedSandbox(
        { transaction, watcherController: watcherController(fake) },
        { assertSocketAuthority: vi.fn(), run: fake.run },
      ),
    ).toEqual({
      originalRecreated: true,
      originalStarted: true,
      replacementRemoved: true,
      rolledBack: true,
    });
    expect(fake.state()).toMatchObject({
      backupExists: false,
      newExists: false,
      restoredExists: true,
      restoredRunning: true,
      watcherStopped: false,
    });
  });

  it("resumes the watcher without removing the replacement when backup proof fails", () => {
    const fake = fakePodman();
    const transaction = recreateWith(fake);
    fake.setBackupUser("1000:1000");
    let error: unknown;
    try {
      rollbackPodmanManagedSandbox(
        { transaction, watcherController: watcherController(fake) },
        { assertSocketAuthority: vi.fn(), run: fake.run },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ rolledBack: false });
    expect(String(error)).toContain("rollback failed");
    expect(fake.calls.map((call) => call.args.slice(2))).not.toContainEqual(["rm", NEW_ID]);
    expect(fake.state()).toMatchObject({
      backupExists: true,
      newExists: true,
      newRunning: true,
      restoredExists: false,
      watcherStopped: false,
    });
  });

  it("refuses rollback without a proven watcher controller", () => {
    const fake = fakePodman();
    const transaction = recreateWith(fake);
    const callsBefore = fake.calls.length;
    expect(() =>
      rollbackPodmanManagedSandbox(
        { transaction, watcherController: undefined as never },
        { assertSocketAuthority: vi.fn(), run: fake.run },
      ),
    ).toThrow("watcher controller");
    expect(fake.calls).toHaveLength(callsBefore);
  });

  it("rolls back instead of deleting the backup when the replacement is not ready", () => {
    const fake = fakePodman();
    const transaction = recreateWith(fake);
    expect(
      finalizePodmanManagedSandbox(
        {
          replacementReady: false,
          transaction,
          watcherController: watcherController(fake),
        },
        { assertSocketAuthority: vi.fn(), run: fake.run },
      ),
    ).toEqual({ backupRemoved: false, rolledBack: true });
    expect(fake.state()).toMatchObject({
      backupExists: false,
      newExists: false,
      newRunning: false,
      restoredExists: true,
      restoredRunning: true,
      watcherStopped: false,
    });
  });

  it("removes the pinned backup only after readiness and reports the exact rm status", () => {
    const green = fakePodman();
    const greenTransaction = recreateWith(green);
    expect(
      finalizePodmanManagedSandbox(
        {
          replacementReady: true,
          transaction: greenTransaction,
        },
        { assertSocketAuthority: vi.fn(), run: green.run },
      ),
    ).toEqual({ backupRemoved: true, rolledBack: false });
    expect(green.calls.map((call) => call.args.slice(2))).toContainEqual(["rm", BACKUP_ID]);
    expect(
      green.calls.find((call) => call.args[2] === "rm" && call.args[3] === BACKUP_ID)
        ?.watcherStopped,
    ).toBe(false);
    expect(green.calls.at(-1)?.args.slice(2)).toEqual(["container", "exists", BACKUP_ID]);

    const leaking = fakePodman({ fail: { action: "remove-backup", status: 1 } });
    const leakingTransaction = recreateWith(leaking);
    expect(
      finalizePodmanManagedSandbox(
        {
          replacementReady: true,
          transaction: leakingTransaction,
        },
        { assertSocketAuthority: vi.fn(), run: leaking.run },
      ),
    ).toEqual({ backupRemoved: false, rolledBack: false });

    const uncertain = fakePodman({
      fail: { action: "remove-backup", afterEffect: true, status: null },
    });
    const uncertainTransaction = recreateWith(uncertain);
    expect(
      finalizePodmanManagedSandbox(
        {
          replacementReady: true,
          transaction: uncertainTransaction,
        },
        { assertSocketAuthority: vi.fn(), run: uncertain.run },
      ),
    ).toEqual({ backupRemoved: true, rolledBack: false });
  });

  it("retains the backup when replacement semantics drift before finalize", () => {
    const fake = fakePodman();
    const transaction = recreateWith(fake);
    fake.setReplacementUser("1000:1000");
    expect(() =>
      finalizePodmanManagedSandbox(
        { replacementReady: true, transaction },
        { assertSocketAuthority: vi.fn(), run: fake.run },
      ),
    ).toThrow("pinned recreation semantics");
    expect(fake.calls.map((call) => call.args.slice(2))).not.toContainEqual(["rm", BACKUP_ID]);
    expect(fake.state()).toMatchObject({
      backupExists: true,
      backupName: transaction.backupContainerName,
    });
  });

  it("retains a backup that is running when finalize is requested", () => {
    const fake = fakePodman();
    const transaction = recreateWith(fake);
    fake.setOldRunning(true);
    expect(() =>
      finalizePodmanManagedSandbox(
        { replacementReady: true, transaction },
        { assertSocketAuthority: vi.fn(), run: fake.run },
      ),
    ).toThrow("backup is running");
    expect(fake.calls.map((call) => call.args.slice(2))).not.toContainEqual(["rm", BACKUP_ID]);
    expect(fake.state().backupExists).toBe(true);
  });

  it.each([
    "none",
    "multiple",
  ] as const)("rejects %s exact-name discovery before inspect or mutation", (discovery) => {
    const fake = fakePodman({ discovery });
    expect(() => recreateWith(fake)).toThrow("exactly one");
    expect(fake.calls).toHaveLength(1);
  });
});
