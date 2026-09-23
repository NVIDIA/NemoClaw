// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeSync } from "node:fs";
import { spawn as spawnHost } from "node:child_process";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { dockerSpawn, dockerSpawnSync } from "../../adapters/docker/exec";
import { fingerprintOpenShellSandboxId } from "../../domain/sandbox/openshell-identity";
import type { SandboxEntry } from "../../state/registry/types";
import type {
  RuntimeProviderSnapshotRestoreSource,
  RuntimeProviderStoppedStateCapture,
  RuntimeProviderStoppedStateProjection,
} from "./contract";

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 120_000;
const INSPECT_FORMAT =
  "[{{json .Id}},{{json .State}},{{json .Config.Labels}},{{json .RestartCount}},{{json .Image}},{{json .Mounts}}]";

// Filter before writing any archive to disk. Machine-local identity, pairing
// state and other undeclared files never enter the retained capture.
const PROJECT_STATE_ARCHIVE = String.raw`import json, pathlib, sys, tarfile
layout = json.loads(sys.argv[1])
directories = set(layout['directories'])
files = set(layout['files'])
prefixes = tuple(layout['prefixes'])
root_seen = False
with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as source:
    with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as target:
        for entry in source:
            parts = pathlib.PurePosixPath(entry.name).parts
            if not parts or '\0' in entry.name or entry.name.startswith('/') or '..' in parts or parts[0] != '.openclaw':
                raise ValueError('invalid stopped state path')
            if len(parts) == 1:
                if root_seen or not entry.isdir(): raise ValueError('state root is not one directory')
                root_seen = True
                entry.name = '.'
                entry.mode = 0o700
            else:
                if not root_seen: raise ValueError('state root header missing')
                top = parts[1]
                directory = top in directories or top.startswith(prefixes)
                state_file = top in files and len(parts) == 2
                if not directory and not state_file: continue
                if state_file and not entry.isfile(): raise ValueError('invalid state file')
                entry.name = '/'.join(parts[1:])
            if not (entry.isfile() or entry.isdir() or entry.issym()) or entry.sparse is not None:
                raise ValueError('unsupported stopped state entry')
            entry.pax_headers = {}
            entry.mode &= 0o777
            target.addfile(entry, source.extractfile(entry) if entry.isfile() else None)
if not root_seen: raise ValueError('state root header missing')
`;

/**
 * Read the OpenClaw state tree from one stopped Docker runtime. This operation
 * never starts or executes in the container and never mutates OpenShell state.
 * The provider owns interpretation of its opaque runtime handle.
 */
export function prepareStoppedDockerStateCapture(
  sandbox: SandboxEntry,
  runtime: RuntimeProviderSnapshotRestoreSource,
  projection: RuntimeProviderStoppedStateProjection,
  dependencies: {
    inspect?: typeof dockerSpawnSync;
    spawn?: typeof dockerSpawn;
  } = {},
): RuntimeProviderStoppedStateCapture {
  if (
    (sandbox.agent ?? "openclaw") !== "openclaw" ||
    sandbox.openshellDriver !== "docker" ||
    !sandbox.lifecycleLiveIdentityFingerprint ||
    runtime.providerId !== "docker" ||
    runtime.lifecycleState !== "stopped" ||
    runtime.runtime.providerId !== "docker" ||
    runtime.runtime.runtime.kind !== "docker-container" ||
    !/^[a-f0-9]{64}$/u.test(runtime.runtime.runtime.handle)
  ) {
    throw new Error("Stopped state capture requires an identified Docker OpenClaw sandbox.");
  }
  if (
    [...projection.directories, ...projection.prefixes, ...projection.files].some(
      (name) => !/^[A-Za-z0-9._-]+$/u.test(name) || name === "." || name === "..",
    )
  )
    throw new Error("Stopped state projection contains an invalid declared path.");
  const encodedProjection = JSON.stringify(projection);
  const containerId = runtime.runtime.runtime.handle;
  const inspect = dependencies.inspect ?? dockerSpawnSync;
  const spawn = dependencies.spawn ?? dockerSpawn;
  const observe = (): unknown => {
    const result = inspect(
      ["inspect", "--type", "container", "--format", INSPECT_FORMAT, containerId],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.status !== 0 || result.error || result.signal) {
      throw new Error("Could not verify the stopped source container.");
    }
    let fields: unknown;
    try {
      fields = JSON.parse(String(result.stdout));
    } catch {
      throw new Error("The stopped source container returned invalid identity evidence.");
    }
    if (!Array.isArray(fields) || fields.length !== 6) {
      throw new Error("The stopped source container returned invalid identity evidence.");
    }
    const [id, state, labels, restarts, image, mounts] = fields;
    if (
      id !== containerId ||
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      !["exited", "created"].includes(state.Status) ||
      state.Running !== false ||
      state.Paused !== false ||
      state.Restarting !== false ||
      typeof state.StartedAt !== "string" ||
      typeof state.FinishedAt !== "string" ||
      !labels ||
      typeof labels !== "object" ||
      Array.isArray(labels) ||
      labels["openshell.ai/managed-by"] !== "openshell" ||
      labels["openshell.ai/sandbox-name"] !== sandbox.name ||
      fingerprintOpenShellSandboxId(labels["openshell.ai/sandbox-id"]) !==
        sandbox.lifecycleLiveIdentityFingerprint ||
      !Number.isSafeInteger(restarts) ||
      restarts < 0 ||
      typeof image !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(image) ||
      !Array.isArray(mounts) ||
      mounts.some((mount) => {
        if (!mount || typeof mount.Destination !== "string") return true;
        const destination = path.posix.normalize(mount.Destination).replace(/\/$/u, "");
        const source = "/sandbox/.openclaw";
        return (
          destination === source ||
          destination.startsWith(`${source}/`) ||
          source.startsWith(`${destination}/`)
        );
      })
    ) {
      throw new Error("The source container is no longer the stopped registered sandbox.");
    }
    return [id, state.Status, state.StartedAt, state.FinishedAt, labels, restarts, image, mounts];
  };
  const initial = observe();
  const assertCurrent = (): void => {
    if (!isDeepStrictEqual(observe(), initial)) {
      throw new Error("The stopped source container changed during recovery capture.");
    }
  };
  return {
    assertCurrent,
    async capture(archiveFd) {
      assertCurrent();
      await new Promise<void>((resolve, reject) => {
        // No -L or trailing '/.': an agent-replaced root symlink stays a link
        // in the archive and the state owner rejects it instead of following it.
        const child = spawn(["cp", `${containerId}:/sandbox/.openclaw`, "-"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const filter = spawnHost(
          "python3",
          ["-I", "-c", PROJECT_STATE_ARCHIVE, encodedProjection],
          {
            env: { PATH: process.env.PATH ?? "" },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let inputBytes = 0;
        let outputBytes = 0;
        let completed = 0;
        let failure: Error | undefined;
        const fail = (message: string): void => {
          failure ??= new Error(message);
          child.kill("SIGKILL");
          filter.kill("SIGKILL");
        };
        const timer = setTimeout(
          () => fail("Stopped state capture timed out."),
          CAPTURE_TIMEOUT_MS,
        );
        child.stdout?.on("data", (chunk: Buffer) => {
          inputBytes += chunk.length;
          if (inputBytes > MAX_ARCHIVE_BYTES)
            fail("Stopped state exceeds the one GiB recovery archive limit.");
        });
        child.stdout?.pipe(filter.stdin!);
        filter.stdin?.on("error", () => fail("Stopped state archive projection failed."));
        filter.stdout?.on("data", (chunk: Buffer) => {
          if (failure) return;
          outputBytes += chunk.length;
          if (outputBytes > MAX_ARCHIVE_BYTES) {
            fail("Stopped state exceeds the one GiB recovery archive limit.");
            return;
          }
          try {
            let offset = 0;
            while (offset < chunk.length) {
              const written = writeSync(archiveFd, chunk, offset, chunk.length - offset);
              if (written <= 0) throw new Error("short write");
              offset += written;
            }
          } catch {
            fail("Could not write the private stopped-state archive.");
          }
        });
        // Never echo Docker or tar diagnostics: they can contain private source paths.
        for (const producer of [child, filter]) {
          producer.stderr?.resume();
          producer.on("error", () =>
            fail("Could not read and filter the stopped source container."),
          );
          producer.once("close", (code, signal) => {
            if (code !== 0 || signal) fail("Stopped state capture did not complete.");
            completed += 1;
            if (completed !== 2) return;
            clearTimeout(timer);
            if (failure) reject(failure);
            else if (inputBytes === 0 || outputBytes === 0)
              reject(new Error("Stopped state capture was empty."));
            else resolve();
          });
        }
      });
      assertCurrent();
    },
  };
}
