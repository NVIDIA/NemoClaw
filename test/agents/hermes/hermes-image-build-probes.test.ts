// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { dockerfileInstructions } from "../../../src/lib/onboard/dockerfile-tool-disclosure-contract";

const root = path.join(import.meta.dirname, "../../..");
const dockerfile = fs.readFileSync(path.join(root, "agents", "hermes", "Dockerfile"), "utf8");
const probes = path.join(root, "agents", "hermes", "image-build-probes.py");
const imageProbePath = "/opt/nemoclaw-hermes-config/image-build-probes.py";
const commands = [
  "cron-backup",
  "cron-create",
  "cron-reopen",
  "cron-runtime-source",
  "dashboard-policy",
  "discord-backup",
  "discord-create",
  "discord-recovery-source",
  "discord-reopen",
  "gateway-process-identity",
  "gateway-runtime-metadata",
  "googlechat-override-seams",
  "langfuse-credentials",
  "neutral-platform-inertness",
  "profile-policy",
  "session-delete",
  "session-preview",
  "session-state-create",
  "session-state-reopen",
] as const;

describe("Hermes image build probes", () => {
  it("keeps cross-identity ledger probes consolidated below the Docker layer-depth ceiling", () => {
    const runInstructions = dockerfileInstructions(dockerfile).filter(({ text }) =>
      text.startsWith("RUN "),
    );
    const layersFor = (family: "cron" | "discord") =>
      runInstructions.filter(({ text }) => text.includes(`${imageProbePath} ${family}-`));
    const sessionStateLayers = runInstructions.filter(({ text }) =>
      text.includes(`${imageProbePath} session-state-`),
    );

    expect({
      cron: layersFor("cron").length,
      discord: layersFor("discord").length,
      sessionState: sessionStateLayers.length,
    }).toEqual({ cron: 2, discord: 2, sessionState: 1 });
    expect(sessionStateLayers[0]?.start).toBe(
      layersFor("cron").find(({ text }) => text.includes(`${imageProbePath} cron-create`))?.start,
    );
    expect(sessionStateLayers[0]?.text).toContain(
      "rm -f /sandbox/.hermes/runtime/state.db",
    );
    expect(dockerfile).toContain("check_absent /sandbox/.hermes/runtime/state.db");
  });

  it.each(commands)(
    "uses a checked-in probe runner instead of builder-dependent heredocs [case %#] (#7981)",
    (command) => {
      expect(dockerfile).not.toMatch(/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/u);
      expect(dockerfile).toContain(`COPY agents/hermes/image-build-probes.py ${imageProbePath}`);
      const normalizedDockerfile = dockerfile.replace(/\\\n/gu, "").replace(/\s+/gu, " ");

      expect(normalizedDockerfile).toContain(`${imageProbePath} ${command}`);

      const removal = dockerfile.indexOf(`rm -f ${imageProbePath}`);
      expect(removal).toBeGreaterThan(dockerfile.indexOf(`${imageProbePath} discord-reopen`));
      expect(dockerfile.indexOf(`check_absent ${imageProbePath}`)).toBeGreaterThan(removal);
    },
  );

  it.each(Array.from(commands, (value) => [value]))(
    "lists Dockerfile probe command %s in the runner usage",
    (command) => {
      const result = spawnSync("python3", ["-I", probes], {
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.status).toBe(1);

      expect(result.stderr).toContain(command);
    },
  );
});
