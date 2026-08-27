// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { MANAGED_SLACK_CREDENTIAL_REFERENCE_SOURCE } from "../fixtures/redaction.ts";

describe("Hermes sandbox Slack credential-reference validation", () => {
  it("accepts unversioned and 21-digit managed Slack references and rejects a raw Slack token (#10153)", () => {
    const longRevision = `v${"1".repeat(21)}_`;
    const aliasPatternSource = String.raw`^${MANAGED_SLACK_CREDENTIAL_REFERENCE_SOURCE}$`;
    const probe = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import json
import re
import sys

pattern = re.compile(sys.argv[1])
print(json.dumps([bool(pattern.fullmatch(value)) for value in sys.argv[2:]]))
`,
        aliasPatternSource,
        "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        `xapp-OPENSHELL-RESOLVE-ENV-${longRevision}SLACK_APP_TOKEN`,
        `xoxb-${"raw-token-material".repeat(3)}`,
      ],
      { encoding: "utf8" },
    );

    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual([true, true, false]);
  });
});
