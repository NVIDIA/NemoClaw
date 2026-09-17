// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runWithEnv, testTimeoutOptions } from "./helpers";

function indexOfArg(log: string, needle: string): number {
  return log.split("\n").findIndex((line) => line === needle);
}

describe("CLI dispatch", () => {
  it(
    "detaches every per-sandbox provider before sandbox delete on destroy",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-detach-"));
      try {
        const localBin = path.join(home, "bin");
        const registryDir = path.join(home, ".nemoclaw");
        const openshellLog = path.join(home, "openshell.log");
        fs.mkdirSync(localBin, { recursive: true });
        fs.mkdirSync(registryDir, { recursive: true });
        fs.writeFileSync(
          path.join(registryDir, "sandboxes.json"),
          JSON.stringify({
            sandboxes: {
              alpha: {
                name: "alpha",
                model: "test-model",
                provider: "nvidia-prod",
                gpuEnabled: false,
                agent: "langchain-deepagents-code",
              },
            },
            defaultSandbox: "alpha",
          }),
          { mode: 0o600 },
        );
        fs.writeFileSync(
          path.join(localBin, "openshell"),
          [
            "#!/bin/sh",
            `log_file=${JSON.stringify(openshellLog)}`,
            'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
            '  printf "NAME STATUS\\n" >> "$log_file"',
            "  exit 0",
            "fi",
            'if [ "$1 $2 $3 $4 $5" = "sandbox get -g nemoclaw alpha" ]; then',
            '  printf \'%s\\n\' "$*" >> "$log_file"',
            '  printf "Error: code: \'Some requested entity was not found\', message: \\"sandbox not found\\"\\n" >&2',
            "  exit 1",
            "fi",
            'printf \'%s\\n\' "$*" >> "$log_file"',
            "exit 0",
          ].join("\n"),
          { mode: 0o755 },
        );
        fs.writeFileSync(path.join(localBin, "docker"), ["#!/bin/sh", "exit 0"].join("\n"), {
          mode: 0o755,
        });
        fs.writeFileSync(path.join(localBin, "brew"), ["#!/bin/sh", "exit 127"].join("\n"), {
          mode: 0o755,
        });

        const r = runWithEnv("alpha destroy -y", {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        });

        const log = fs.readFileSync(openshellLog, "utf8");
        expect(r.code, `${r.out}\nOpenShell log:\n${log}`).toBe(0);
        const deleteIdx = indexOfArg(log, "sandbox delete -g nemoclaw alpha");
        expect(deleteIdx).toBeGreaterThan(-1);

        const expectedDetachLines = [
          "sandbox provider detach alpha alpha-telegram-bridge",
          "sandbox provider detach alpha alpha-discord-bridge",
          "sandbox provider detach alpha alpha-wechat-bridge",
          "sandbox provider detach alpha alpha-slack-bridge",
          "sandbox provider detach alpha alpha-slack-app",
          "sandbox provider detach alpha alpha-brave-search",
          "sandbox provider detach alpha alpha-tavily-search",
        ];
        expectedDetachLines.forEach((line) => {
          const idx = indexOfArg(log, line);
          expect(idx, `${line} should appear in openshell log`).toBeGreaterThan(-1);
          expect(idx, `${line} should precede the owner-scoped sandbox delete`).toBeLessThan(
            deleteIdx,
          );
        });
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
