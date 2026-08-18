// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

type VolumeState = { name: string; labels: Record<string, string> } | null;

export function createHermesStateVolumeDockerHarness(initial: VolumeState = null) {
  let volume = initial;
  const calls: string[][] = [];
  const runDocker = vi.fn((args: readonly string[]) => {
    const argv = [...args];
    calls.push(argv);
    switch (argv[0]) {
      case "inspect":
        return volume
          ? {
              status: 0,
              stdout: `${JSON.stringify({ Name: volume.name, Labels: volume.labels })}\n`,
            }
          : { status: 1, stderr: `Error response from daemon: get ${argv.at(-1)}: no such volume` };
      case "create": {
        const labels: Record<string, string> = {};
        for (let index = 1; index < argv.length - 1; index += 1) {
          switch (argv[index]) {
            case "--label": {
              const [name, ...value] = argv[index + 1]!.split("=");
              labels[name!] = value.join("=");
              index += 1;
              break;
            }
          }
        }
        volume = { name: argv.at(-1)!, labels };
        return { status: 0, stdout: `${volume.name}\n` };
      }
      case "rm":
        volume = null;
        return { status: 0, stdout: `${argv[1]}\n` };
      default:
        return { status: 1, stderr: "unexpected Docker command" };
    }
  });
  return {
    calls,
    get volume() {
      return volume;
    },
    runDocker,
  };
}
