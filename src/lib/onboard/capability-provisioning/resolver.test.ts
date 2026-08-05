// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CAPABILITY_BOM_SCHEMA_VERSION,
  CAPABILITY_CATALOG_SCHEMA_VERSION,
  CAPABILITY_MANIFEST_SCHEMA_VERSION,
} from "./contract";
import { resolveCapabilityBillOfMaterials } from "./resolver";

const RUNTIME_DIGEST = "a".repeat(64);
const TOOL_DIGEST = "b".repeat(64);

function manifest(capabilities: Array<{ id: string; version: string | null }> = []) {
  return {
    schemaVersion: CAPABILITY_MANIFEST_SCHEMA_VERSION,
    agent: "hermes",
    capabilities,
  };
}

function catalog() {
  return {
    schemaVersion: CAPABILITY_CATALOG_SCHEMA_VERSION,
    capabilities: [
      {
        id: "rust-runtime",
        displayName: "Rust runtime",
        kind: "runtime",
        version: "1.90.0",
        agents: ["openclaw", "hermes", "langchain-deepagents-code"],
        requires: [],
        policyPresets: [],
        artifacts: [
          {
            platform: "linux/amd64",
            reference: `oci://ghcr.io/nvidia/nemoclaw-capabilities/rust-runtime@sha256:${RUNTIME_DIGEST}`,
            installPrefix: "/opt/nemoclaw/capabilities/rust-runtime",
            pathEntries: ["bin"],
          },
          {
            platform: "linux/arm64",
            reference: `oci://ghcr.io/nvidia/nemoclaw-capabilities/rust-runtime@sha256:${TOOL_DIGEST}`,
            installPrefix: "/opt/nemoclaw/capabilities/rust-runtime",
            pathEntries: ["bin"],
          },
        ],
      },
      {
        id: "switchyard",
        displayName: "Switchyard",
        kind: "tool",
        version: "2.4.1",
        agents: ["hermes"],
        requires: ["rust-runtime"],
        policyPresets: ["switchyard"],
        artifacts: [
          {
            platform: "linux/amd64",
            reference: `oci://ghcr.io/nvidia/nemoclaw-capabilities/switchyard@sha256:${TOOL_DIGEST}`,
            installPrefix: "/opt/nemoclaw/capabilities/switchyard",
            pathEntries: ["bin"],
          },
        ],
      },
    ],
  };
}

describe("capability bill of materials resolution", () => {
  it("resolves requested capabilities and dependencies into one deterministic BOM", () => {
    const input = manifest([{ id: "switchyard", version: "2.4.1" }]);
    const first = resolveCapabilityBillOfMaterials({
      manifest: input,
      catalog: catalog(),
      platform: "linux/amd64",
    });
    const second = resolveCapabilityBillOfMaterials({
      manifest: input,
      catalog: catalog(),
      platform: "linux/amd64",
    });

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(CAPABILITY_BOM_SCHEMA_VERSION);
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.capabilities.map(({ id, requested }) => ({ id, requested }))).toEqual([
      { id: "rust-runtime", requested: false },
      { id: "switchyard", requested: true },
    ]);
    expect(JSON.stringify(first)).not.toMatch(/docker|podman|command|credential|secret/iu);
  });

  it("orders punctuation-bearing capability IDs by code units across equivalent inputs", () => {
    const capabilityIds = ["tool-1", "tool.1", "tool_1"];
    const capabilities = capabilityIds.map((id) => ({
      id,
      displayName: id,
      kind: "tool",
      version: "1.0.0",
      agents: ["hermes"],
      requires: [],
      policyPresets: [],
      artifacts: [
        {
          platform: "linux/amd64",
          reference: `oci://ghcr.io/nvidia/nemoclaw-capabilities/${id}@sha256:${TOOL_DIGEST}`,
          installPrefix: `/opt/nemoclaw/capabilities/${id}`,
          pathEntries: ["bin"],
        },
      ],
    }));
    const first = resolveCapabilityBillOfMaterials({
      manifest: manifest(capabilityIds.map((id) => ({ id, version: null }))),
      catalog: { schemaVersion: CAPABILITY_CATALOG_SCHEMA_VERSION, capabilities },
      platform: "linux/amd64",
    });
    const second = resolveCapabilityBillOfMaterials({
      manifest: manifest([...capabilityIds].reverse().map((id) => ({ id, version: null }))),
      catalog: {
        schemaVersion: CAPABILITY_CATALOG_SCHEMA_VERSION,
        capabilities: [...capabilities].reverse(),
      },
      platform: "linux/amd64",
    });

    expect(first).toEqual(second);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.capabilities.map(({ id }) => id)).toEqual(["tool-1", "tool.1", "tool_1"]);
  });

  it("rejects unknown and version-incompatible requests", () => {
    expect(() =>
      resolveCapabilityBillOfMaterials({
        manifest: manifest([{ id: "unknown", version: null }]),
        catalog: catalog(),
        platform: "linux/amd64",
      }),
    ).toThrow(/unknown capability 'unknown'/u);
    expect(() =>
      resolveCapabilityBillOfMaterials({
        manifest: manifest([{ id: "switchyard", version: "2.5.0" }]),
        catalog: catalog(),
        platform: "linux/amd64",
      }),
    ).toThrow(/catalog provides '2.4.1'/u);
  });

  it("fails closed for unsupported agents and platforms", () => {
    expect(() =>
      resolveCapabilityBillOfMaterials({
        manifest: { ...manifest([{ id: "switchyard", version: null }]), agent: "openclaw" },
        catalog: catalog(),
        platform: "linux/amd64",
      }),
    ).toThrow(/does not support agent 'openclaw'/u);
    expect(() =>
      resolveCapabilityBillOfMaterials({
        manifest: manifest([{ id: "switchyard", version: null }]),
        catalog: catalog(),
        platform: "linux/arm64",
      }),
    ).toThrow(/does not support platform 'linux\/arm64'/u);
  });
});
