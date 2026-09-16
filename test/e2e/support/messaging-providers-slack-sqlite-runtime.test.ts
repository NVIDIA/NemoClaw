// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { SLACK_INSTALLED_RUNTIME_PROOF_SOURCE } from "../live/messaging-providers-slack-runtime-proof.ts";

it("confines installed Slack runtime SQLite temporary files to the OpenClaw state tree", () => {
  expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain(
    'const sqliteTmpdir = "/sandbox/.openclaw/tmp"',
  );
  expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("!metadata.isSymbolicLink()");
  expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("metadata.uid === process.getuid()");
  expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain(
    "process.env.SQLITE_TMPDIR = sqliteTmpdir",
  );
});
