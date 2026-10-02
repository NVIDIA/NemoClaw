// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guardSource } from "./openclaw-shell-removal-fixture.ts";

const cases = [{ id: "O02", args: ["agent", "--local", "-m", "fixture"] }];

describe("OpenClaw proposed shell removals", () => {
  it.each(cases.flatMap((entry) => [0, 23].map((exit) => ({ ...entry, exit }))))(
    "$id forwards local mode arguments and exit $exit (#11763)",
    ({ args, exit }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-removal-"));
      try {
        fs.writeFileSync(
          path.join(directory, "openclaw"),
          '#!/bin/sh\nprintf "arg=%s\\n" "$@"\nprintf "token=%s\\n" "${OPENCLAW_GATEWAY_TOKEN-unset}"\nexit "${FIXTURE_EXIT-0}"\n',
          { mode: 0o700 },
        );
        const run = (source: string, exit: number, remote = false) =>
          spawnSync("bash", ["-c", `${source}\nopenclaw "$@"`, "fixture", ...args], {
            encoding: "utf8",
            timeout: 5000,
            env: {
              PATH: `${directory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
              FIXTURE_EXIT: String(exit),
              OPENCLAW_GATEWAY_TOKEN: "fixture-token",
              ...(remote ? { OPENCLAW_GATEWAY_URL: "wss://other.example.test" } : {}),
            },
          });
        const candidate = guardSource();
        const forwarded = run(candidate, exit);
        expect(forwarded.status, forwarded.stderr).toBe(exit);
        expect(forwarded.stdout.split("\n").filter((line) => line.startsWith("arg="))).toEqual(
          args.map((arg) => `arg=${arg}`),
        );
        expect(forwarded.stdout).toContain("token=fixture-token");
        const remote = run(candidate, 0, true);
        expect(remote.status, remote.stderr).toBe(0);
        expect(remote.stdout).toContain("token=unset");
        expect(remote.stdout).not.toContain("fixture-token");
        expect(remote.stderr).not.toContain("fixture-token");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
