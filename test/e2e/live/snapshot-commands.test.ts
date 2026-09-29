// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { testTimeout } from "../../helpers/timeouts.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

test(
  "retired snapshot commands expose complete-state backup and rebuild replacements",
  {
    timeout: testTimeout(5 * 60_000),
    meta: {
      e2ePhases: [
        "build the exact candidate CLI for trusted-main target retirement",
        "inspect the exact candidate CLI surface",
        "verify selective snapshot commands remain retired",
        "verify complete-state backup and rebuild replacements are discoverable",
      ],
    },
  },
  async ({ artifacts, host, progress }) => {
    await artifacts.target.declare({
      id: "snapshot-commands",
      boundary: "exact candidate CLI compatibility during trusted-main target retirement",
      contracts: [
        "the selective per-sandbox snapshot command is not advertised",
        "backup-all remains the supported pre-upgrade backup command",
        "rebuild advertises transactional backup, recreation, and restoration",
      ],
    });

    progress.phase("build the exact candidate CLI for trusted-main target retirement");
    const build = await host.command("npm", ["run", "build:cli"], {
      artifactName: "build-exact-candidate-cli",
      cwd: REPO_ROOT,
      timeoutMs: 3 * 60_000,
    });
    expect(build.exitCode, resultText(build)).toBe(0);

    progress.phase("inspect the exact candidate CLI surface");
    const help = await host.nemoclaw(["help"], {
      artifactName: "snapshot-retirement-cli-help",
      timeoutMs: 60_000,
    });
    const helpText = resultText(help);

    progress.phase("verify selective snapshot commands remain retired");
    expect(help.exitCode === 0 && !helpText.includes("<name> snapshot"), helpText).toBe(true);

    progress.phase("verify complete-state backup and rebuild replacements are discoverable");
    expect(helpText).toContain("nemoclaw backup-all");
    expect(helpText).toContain("nemoclaw <name> rebuild");
    const rebuildHelp = await host.nemoclaw(["e2e-snapshot", "rebuild", "--help"], {
      artifactName: "complete-native-rebuild-cli-help",
      timeoutMs: 60_000,
    });
    expect(rebuildHelp.exitCode, resultText(rebuildHelp)).toBe(0);
    expect(resultText(rebuildHelp)).toContain(
      "Back up, recreate, and restore a sandbox using the current agent image.",
    );

    await artifacts.target.complete({
      id: "snapshot-commands",
      status: "passed",
      selectiveSnapshotCommandRetired: true,
      completeStateReplacementsAdvertised: true,
    });
  },
);
