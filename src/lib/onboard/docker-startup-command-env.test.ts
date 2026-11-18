// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  parseOpenShellMainProcessSpecEnvValue,
  replaceOpenShellMainProcessSpecCommand,
} from "./docker-startup-command-env";

describe("OpenShell main-process attachment metadata", () => {
  it.each([{}, { await_main_process_attachment: false }, { await_main_process_attachment: true }])(
    "preserves attachment metadata when replacing the command: %j",
    (attachment) => {
      const original = {
        version: 1,
        command: ["env", "TOKEN=opaque-value", "nemoclaw-start"],
        tty: false,
        ...attachment,
      };
      expect(parseOpenShellMainProcessSpecEnvValue(JSON.stringify(original))).toEqual(original);
      expect(
        JSON.parse(
          replaceOpenShellMainProcessSpecCommand(JSON.stringify(original), [
            "replacement",
            "argument with spaces",
          ]),
        ),
      ).toEqual({ ...original, command: ["replacement", "argument with spaces"] });
    },
  );

  it.each([
    { await_main_process_attachment: "false" },
    { await_main_process_attachment: null },
    { await_main_process_attachment: 1 },
    { unexpected: false },
    { await_main_process_attachment: false, unexpected: false },
  ])("rejects unsupported metadata: %j", (extra) => {
    expect(() =>
      parseOpenShellMainProcessSpecEnvValue(
        JSON.stringify({ version: 1, command: ["nemoclaw-start"], tty: false, ...extra }),
      ),
    ).toThrow(/contract/);
  });
});
