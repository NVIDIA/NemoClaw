// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  executePrivilegedSandboxCommand,
  resolveDirectSandboxContainer,
} from "../../../sandbox/privileged-exec";
import type { SandboxStateRestoreCommand } from "../../../state/ssh-transport";
import type { SandboxEntry } from "../../../state/registry";
import type {
  RebuildManifest,
  RecreatedSandboxRestoreOptions,
  RestoreResult,
} from "../../../state/sandbox";
import type { DockerGpuPatchResult } from "../../../onboard/docker-gpu-patch";
import { queryOpenShellDockerSandboxRuntimeSnapshot } from "../../../onboard/openshell-docker-sandbox-containers";
import { createDockerRuntimeProviderBundle } from "../../../onboard/runtime-provider/docker";
import { restoreRecreatedSandboxStateWithManagedAuthority } from "./restore-authority";

/** Retain managed snapshot fences while the replacement awaits its final handoff. */
export function restoreRecreatedDockerSandboxState(
  sandboxName: string,
  manifest: RebuildManifest,
  options: RecreatedSandboxRestoreOptions &
    Pick<DockerGpuPatchResult, "newContainerId" | "oldContainerId">,
  {
    getSandbox,
    resolveContainer = resolveDirectSandboxContainer,
  }: {
    getSandbox: (name: string) => SandboxEntry | null;
    resolveContainer?: typeof resolveDirectSandboxContainer;
  },
): RestoreResult {
  const { newContainerId, oldContainerId, ...restoreOptions } = options;
  const target = {
    expectedResourceHandle: newContainerId,
    retainedDockerBackupId: oldContainerId,
  };
  const runCommand: SandboxStateRestoreCommand = (command, options) =>
    executePrivilegedSandboxCommand(
      sandboxName,
      [
        "/usr/bin/setpriv",
        "--reuid=sandbox",
        "--regid=sandbox",
        "--init-groups",
        "--no-new-privs",
        "--",
        "/usr/bin/env",
        "-i",
        "HOME=/sandbox",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "/bin/sh",
        "-c",
        command,
      ],
      {
        ...target,
        sanitizeEnvironment: true,
        input: options.input,
        timeout: options.timeout,
        maxOutputBytes: options.maxBuffer,
      },
    );
  const requireProvider = () =>
    createDockerRuntimeProviderBundle({
      queryRuntimeSnapshot: (name) => {
        // Validate registered ownership and the exact stopped rollback copy
        // before the snapshot provider observes the pinned replacement.
        resolveContainer(name, null, target);
        return queryOpenShellDockerSandboxRuntimeSnapshot(
          name,
          {},
          {
            expectedContainerId: newContainerId,
          },
        );
      },
    });
  return restoreRecreatedSandboxStateWithManagedAuthority(
    sandboxName,
    manifest,
    { ...restoreOptions, runCommand },
    { getSandbox, requireProvider },
  );
}
