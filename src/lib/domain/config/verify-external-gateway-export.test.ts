// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { qualifyEffectivePolicy } from "../../actions/config/observe-export-source";
import { validateExportGateway } from "./export-gateway";
import { snapshot, verify, hermesSnapshot } from "./export-source-test-fixture";
import { asExportedConfig } from "../../../../test/support/config-export-document";
import { validateConfigExportWithPinnedV1 } from "../../../../test/support/v1-config-consumer";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";

const externalGateway = {
  name: "nemoclaw",
  port: 8080,
  management: "external",
  stateRootOwned: false,
  external: {
    endpoint: "http://127.0.0.1:8080",
    authorityFingerprint: "a".repeat(64),
    listenerPid: 4242,
    listenerStartTime: "710024",
  },
} as const;

describe("external gateway config export", () => {
  it("exports only connection intent and leaves the managed baseline unchanged (#11861)", async () => {
    const baseline = snapshot();
    const source = { ...baseline, gateway: externalGateway };
    const original = structuredClone(source);
    const managed = await exportSnapshots([baseline]);
    const external = await exportSnapshots([source]);
    expect(managed.outcome.ok).toBe(true);
    expect(external.outcome.ok).toBe(true);
    const managedConfig = asExportedConfig(YAML.parse(managed.writeStdout.mock.calls[0]![0]));
    const externalYaml = external.writeStdout.mock.calls[0]![0];
    const externalConfig = asExportedConfig(YAML.parse(externalYaml));
    expect(managedConfig.spec.gateway).toEqual({
      management: "managed",
      endpoint: "http://127.0.0.1:8080",
    });
    expect(externalConfig.spec.gateway).toEqual({
      management: "external",
      endpoint: "http://127.0.0.1:8080",
    });
    expect({ ...externalConfig.spec, gateway: managedConfig.spec.gateway }).toEqual(
      managedConfig.spec,
    );
    expect(externalYaml).not.toContain(externalGateway.external.authorityFingerprint);
    expect(externalYaml).not.toContain("listenerPid");
    expect(source).toEqual(original);
  });

  it.each([
    { management: "unknown" as const },
    { external: undefined },
    { external: { ...externalGateway.external, authorityFingerprint: "" } },
    { external: { ...externalGateway.external, listenerPid: 0 } },
    { external: { ...externalGateway.external, listenerStartTime: "" } },
    { external: { ...externalGateway.external, endpoint: "https://127.0.0.1:8080" } },
    { external: { ...externalGateway.external, endpoint: "http://[::1]:8080" } },
    { external: { ...externalGateway.external, endpoint: "http://127.0.0.1:9090" } },
    { external: { ...externalGateway.external, endpoint: "http://169.254.169.254:8080" } },
    { external: { ...externalGateway.external, endpoint: "http://secret@127.0.0.1:8080" } },
    { name: "another", port: 9090 },
  ])(
    "refuses incomplete or competing external evidence without publishing %# (#11861)",
    async (change) => {
      const source = snapshot({ gateway: { ...externalGateway, ...change } });
      const exported = await exportSnapshots([source]);
      expect(exported.outcome.ok).toBe(false);
      expect(exported.writeStdout).not.toHaveBeenCalled();
      expect(exported.publish).not.toHaveBeenCalled();
      expect(JSON.stringify(exported.outcome)).not.toContain("secret@");
    },
  );

  it("rejects external gateways for Hermes (#11861)", () => {
    expect(verify({ ...hermesSnapshot(), gateway: externalGateway })).toMatchObject({
      kind: "rejected",
      findings: expect.arrayContaining([
        expect.objectContaining({ field: "spec.gateway.management", category: "unsupported" }),
      ]),
    });
  });

  it("refuses external local inference even with complete gateway evidence (#11861)", () => {
    const source = snapshot();
    expect(
      verify({
        ...source,
        gateway: externalGateway,
        inference: { ...source.inference, topology: "local" },
      }),
    ).toMatchObject({
      kind: "rejected",
      findings: expect.arrayContaining([
        expect.objectContaining({ field: "spec.gateway.management", category: "unsupported" }),
      ]),
    });
  });

  it("rejects external gateways on Podman (#11861)", () => {
    const observed = snapshot({ gateway: externalGateway });
    expect(
      validateExportGateway({
        ...observed,
        registry: { ...observed.registry, openshellDriver: "podman" },
        policy: qualifyEffectivePolicy(observed.policy),
      }),
    ).toEqual([
      expect.objectContaining({ field: "spec.gateway.management", category: "unsupported" }),
    ]);
  });

  it("refuses listener replacement across both complete observation attempts (#11861)", async () => {
    const source = snapshot({ gateway: externalGateway });
    const replacement = snapshot({
      gateway: {
        ...externalGateway,
        external: { ...externalGateway.external, listenerStartTime: "999999" },
      },
    });
    const exported = await exportSnapshots([source, replacement, source, replacement]);
    expect(exported.outcome).toMatchObject({ ok: false });
    expect(exported.writeStdout).not.toHaveBeenCalled();
    expect(exported.publish).not.toHaveBeenCalled();
  });

  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1")(
    "passes raw external YAML to the pinned v1 parser and compiler (#11861)",
    testTimeoutOptions(12 * 60_000),
    async () => {
      const exported = await exportSnapshots([snapshot({ gateway: externalGateway })]);
      expect(exported.outcome.ok).toBe(true);
      expect(
        validateConfigExportWithPinnedV1(exported.writeStdout.mock.calls[0]![0]),
      ).toMatchObject({
        revision: "88c6600c06b0937907290362eef86912052c4ad0",
      });
    },
  );
});
