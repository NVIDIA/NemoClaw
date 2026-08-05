// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG_SCHEMA_VERSION,
  CAPABILITY_MANIFEST_SCHEMA_VERSION,
  CapabilityProvisioningContractError,
  parseCapabilityCatalogV1,
  parseCapabilityManifestV1,
} from "./contract";

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

describe("capability provisioning contracts", () => {
  it("rejects duplicate capability requests", () => {
    expect(() =>
      parseCapabilityManifestV1(
        manifest([
          { id: "switchyard", version: null },
          { id: "switchyard", version: null },
        ]),
      ),
    ).toThrow(/must not contain duplicates/u);
  });

  it("rejects mutable artifacts, arbitrary destinations, and executable instructions", () => {
    const mutable = catalog();
    mutable.capabilities[0]!.artifacts[0]!.reference =
      "oci://ghcr.io/nvidia/nemoclaw-capabilities/rust-runtime:latest";
    expect(() => parseCapabilityCatalogV1(mutable)).toThrow(/reference has an unsupported format/u);

    const destination = catalog();
    destination.capabilities[0]!.artifacts[0]!.installPrefix = "/usr/local";
    expect(() => parseCapabilityCatalogV1(destination)).toThrow(
      /installPrefix has an unsupported format/u,
    );

    const executable = catalog() as unknown as { capabilities: Array<Record<string, unknown>> };
    executable.capabilities[0]!.command = "apt-get install rustc";
    expect(() => parseCapabilityCatalogV1(executable)).toThrow(/must contain exactly/u);
  });

  it("rejects catalog dependency gaps and cycles", () => {
    const missing = catalog();
    missing.capabilities[1]!.requires = ["missing-runtime"];
    expect(() => parseCapabilityCatalogV1(missing)).toThrow(/requires unknown capability/u);

    const cyclic = catalog();
    cyclic.capabilities[0]!.requires = ["switchyard"];
    expect(() => parseCapabilityCatalogV1(cyclic)).toThrow(/dependency cycle/u);
  });

  it("rejects inherited objects and malformed relative path entries", () => {
    const inherited = Object.create({ schemaVersion: CAPABILITY_MANIFEST_SCHEMA_VERSION });
    inherited.agent = "hermes";
    inherited.capabilities = [];
    expect(() => parseCapabilityManifestV1(inherited)).toThrow(CapabilityProvisioningContractError);

    const traversal = catalog();
    traversal.capabilities[0]!.artifacts[0]!.pathEntries = ["../bin"];
    expect(() => parseCapabilityCatalogV1(traversal)).toThrow(/pathEntries\[0\]/u);
  });
});
