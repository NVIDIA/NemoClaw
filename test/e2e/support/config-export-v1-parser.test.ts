// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  parseNemoClawConfigDocumentName,
  parseNemoClawConfigDocumentUid,
} from "../../../src/lib/config/model.ts";
import { buildExportConfig } from "../../../src/lib/domain/config/export-document.ts";
import type { VerifiedExportSource } from "../../../src/lib/domain/config/export-evidence.ts";
import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import {
  V1_CONFIG_PARSER_REVISION,
  validateWithRevisionMatchedV1Parser,
} from "./v1-config-parser.ts";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const identity = {
  documentName: parseNemoClawConfigDocumentName("parser-contract"),
  documentUid: parseNemoClawConfigDocumentUid("018f47e2-9d93-7d15-9c41-3ecf70b2550f"),
};
const source = {
  sandboxName: "parser-contract",
  agent: "openclaw",
  runtime: { provider: "docker", imageRef: `nvcr.io/nvidia/nemoclaw@${digest}` },
  gateway: { name: "nemoclaw", port: 8080 },
  inference: {
    provider: "openai-api",
    model: "gpt-5",
    api: "openai-responses",
    endpoint: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
  },
  policy: {
    version: 1,
    process: { run_as_user: "sandbox", run_as_group: "sandbox" },
    network_policies: {
      api: {
        name: "api",
        endpoints: [{ host: "api.openai.com", port: 443 }],
        binaries: [{ path: "/usr/bin/openclaw" }],
      },
    },
    filesystem_policy: {
      include_workdir: false,
      read_only: ["/usr"],
      read_write: ["/sandbox"],
    },
  },
} as unknown as VerifiedExportSource;

function rawExport(agent: "hermes" | "openclaw") {
  return YAML.stringify(buildExportConfig({ ...source, agent, interfaces: undefined }, identity));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("revision-matched v1 config parser", () => {
  it(
    "accepts singular producer YAML and rejects the retired agents list (#12131)",
    testTimeoutOptions(10 * 60 * 1_000),
    () => {
      const openclaw = rawExport("openclaw");
      const hermes = rawExport("hermes");
      const legacy = YAML.stringify({
        ...YAML.parse(openclaw),
        spec: {
          ...YAML.parse(openclaw).spec,
          sandboxes: YAML.parse(openclaw).spec.sandboxes.map(
            ({ agent, ...sandbox }: Record<string, unknown>) => ({ ...sandbox, agents: [agent] }),
          ),
        },
      });

      const result = validateWithRevisionMatchedV1Parser({
        accepted: [
          { name: "openclaw", raw: openclaw },
          { name: "hermes", raw: hermes },
        ],
        rejected: [{ name: "legacy-agents-list", raw: legacy }],
      });

      expect(result).toEqual({
        revision: V1_CONFIG_PARSER_REVISION,
        accepted: [
          { name: "openclaw", sha256: sha256(openclaw) },
          { name: "hermes", sha256: sha256(hermes) },
        ],
        rejected: [{ name: "legacy-agents-list", sha256: sha256(legacy) }],
      });
    },
  );
});
