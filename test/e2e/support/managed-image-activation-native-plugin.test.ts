// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHostProcessWorkspace } from "../../helpers/host-process-harness.ts";
import { managedActivationOpenClawPluginScript } from "../live/managed-image-activation-e2e-helpers.ts";

// The fixture runs inside Linux managed images and uses GNU mv's no-target-directory contract.
describe.runIf(process.platform === "linux")("managed native bootstrap diagnostic fixture", () => {
  it.each([0, 9])(
    "creates private bootstrap diagnostics and propagates native install exit %i",
    (pluginExit) => {
      const fixture = createHostProcessWorkspace("nemoclaw-managed-native-plugin-");
      const home = fixture.homeDir.replaceAll(path.sep, "/");
      const state = fixture.path(".openclaw");
      try {
        fs.mkdirSync(state, { mode: 0o700 });
        fixture.writeCommand(
          "openclaw",
          [
            {
              args: [
                "plugins",
                "install",
                "--force",
                "--accept-capabilities",
                `${home}/managed-activation-native-plugin`,
              ],
              exitCode: pluginExit,
            },
          ],
          ["HOME"],
        );
        const result = fixture.run("bash", ["-ec", managedActivationOpenClawPluginScript(home)], {
          env: fixture.environment(),
        });
        expect(result.status, result.output).toBe(pluginExit);
        fixture.assertCommandRoutesUsed();
        expect(fixture.commandRecords()).toMatchObject([{ environment: { HOME: home } }]);
        expect(fs.readFileSync(path.join(state, ".env"), "utf8")).toBe("OPENCLAW_DEBUG=1\n");
        expect(fs.statSync(path.join(state, ".env")).mode & 0o777).toBe(0o600);
      } finally {
        fixture.remove();
      }
    },
  );

  it.each([
    {
      kind: "file",
      prepare: "printf retained > .openclaw/.env",
      readback: "cat .openclaw/.env",
      expected: "retained",
    },
    {
      kind: "symlink",
      prepare: "printf retained > retained; ln -s ../retained .openclaw/.env",
      readback: "readlink .openclaw/.env; cat retained",
      expected: "../retained\nretained",
    },
    {
      kind: "dangling symlink",
      prepare: "ln -s ../retained .openclaw/.env",
      readback: "readlink .openclaw/.env; test ! -e retained",
      expected: "../retained\n",
    },
  ])("preserves existing native dotenv $kind", (row) => {
    const fixture = createHostProcessWorkspace("nemoclaw-managed-native-plugin-retain-");
    const home = fixture.homeDir.replaceAll(path.sep, "/");
    try {
      fs.mkdirSync(fixture.path(".openclaw"), { mode: 0o700 });
      const prepared = fixture.run("bash", ["-ec", row.prepare], { cwd: fixture.homeDir });
      expect(prepared.status, prepared.output).toBe(0);
      fixture.writeCommand("openclaw", [
        {
          args: [
            "plugins",
            "install",
            "--force",
            "--accept-capabilities",
            `${home}/managed-activation-native-plugin`,
          ],
          exitCode: 0,
        },
      ]);
      const result = fixture.run("bash", ["-ec", managedActivationOpenClawPluginScript(home)], {
        env: fixture.environment(),
      });
      expect(result.status, result.output).toBe(0);
      fixture.assertCommandRoutesUsed();
      const retained = fixture.run("bash", ["-ec", row.readback], { cwd: fixture.homeDir });
      expect(retained.status, retained.output).toBe(0);
      expect(retained.stdout).toBe(row.expected);
    } finally {
      fixture.remove();
    }
  });
});
