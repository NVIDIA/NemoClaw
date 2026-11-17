// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

export function mockPinnedV1ConsumerBuilds() {
  const state = { invocations: [] as string[], workspaces: new Set<string>(), builds: 0 };
  vi.mocked(execFileSync).mockImplementation((command, args, options) => {
    if (command === "tar") {
      fs.mkdirSync(path.join(String(args?.at(-1)), "crates/nemoclaw-sdk/tests"), {
        recursive: true,
      });
    } else if (command === "cargo") {
      const env = options?.env ?? {};
      const target = env.CARGO_TARGET_DIR!;
      if (fs.mkdirSync(target, { recursive: true }) !== undefined) {
        state.builds += 1;
      }
      state.workspaces.add(path.dirname(target));
      const input = env.NEMOCLAW_V1_CONFIG_INPUT!;
      state.invocations.push(path.dirname(input));
      const raw = fs.readFileSync(input, "utf8");
      if (raw === "rejected") {
        throw Object.assign(new Error("rejected export"), {
          status: 101,
          stderr: Buffer.from("configuration violates schema"),
        });
      }
      if (raw !== "missing-output") {
        fs.writeFileSync(env.NEMOCLAW_V1_SETTINGS_OUTPUT!, raw);
      }
    } else if (command === "python3") {
      return fs.readFileSync(String(args?.at(-1)));
    }
    return Buffer.from("");
  });
  return state;
}
