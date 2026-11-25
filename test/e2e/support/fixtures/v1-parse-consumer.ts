// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

export function mockV1ParseBuilds() {
  const state = { invocations: [] as string[], workspaces: new Set<string>(), builds: 0 };
  vi.mocked(execFileSync).mockImplementation((command, args, options) => {
    if (command === "cargo") {
      const env = options?.env ?? {};
      const target = env.CARGO_TARGET_DIR!;
      if (fs.mkdirSync(target, { recursive: true }) !== undefined) state.builds += 1;
      state.workspaces.add(path.dirname(target));
      state.invocations.push(path.dirname(env.NEMOCLAW_V1_CONFIG_INPUT!));
      const raw = fs.readFileSync(env.NEMOCLAW_V1_CONFIG_INPUT!, "utf8");
      if (raw === "rejected") {
        throw Object.assign(new Error("rejected export"), {
          status: 2,
          stderr: Buffer.from("configuration rejected: configuration violates schema"),
        });
      }
      if (raw !== "missing-output") {
        fs.writeFileSync(env.NEMOCLAW_V1_DOCUMENT_OUTPUT!, raw);
      }
    }
    return Buffer.from("");
  });
  return state;
}
