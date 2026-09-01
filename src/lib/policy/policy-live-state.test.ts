// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import YAML from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PolicyObservationError } from "../adapters/openshell/policy-state";
import { digestBaselineEntry } from "./baseline-exclusion";

const mocks = vi.hoisted(() => ({
  captureSandboxBasePolicy: vi.fn(),
  captureSandboxBasePolicyRevision: vi.fn(),
  getSandbox: vi.fn(),
  inspectSandboxPolicy: vi.fn(),
  resolveOpenshell: vi.fn(),
  run: vi.fn(),
  runCapture: vi.fn(),
}));

vi.mock("../adapters/openshell/policy-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/policy-state")>()),
  captureSandboxBasePolicy: mocks.captureSandboxBasePolicy,
  captureSandboxBasePolicyRevision: mocks.captureSandboxBasePolicyRevision,
  inspectSandboxPolicy: mocks.inspectSandboxPolicy,
}));
vi.mock("../adapters/openshell/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/resolve")>()),
  resolveOpenshell: mocks.resolveOpenshell,
}));
vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  run: mocks.run,
  runCapture: mocks.runCapture,
}));
vi.mock("../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/registry")>()),
  getSandbox: mocks.getSandbox,
}));

import {
  applyPresetContent,
  applyPresets,
  excludeBaselineEntry,
  inspectPolicyMutationContext,
  removePreset,
  restoreBaselineEntry,
  setPolicyDocument,
} from "./index";

const sandboxName = "live-policy";
const preset = `preset:\n  name: weather\n  description: Weather\nnetwork_policies:\n  weather:\n    endpoints:\n      - host: wttr.in\n        port: 443\n`;
const hostEntry = { endpoints: [{ host: "approved.example.com", port: 443 }] };

describe("live OpenShell policy mutations", () => {
  let livePolicy: string;

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    livePolicy = YAML.stringify({
      version: 1,
      network_policies: { host_approval: hostEntry },
    });
    mocks.getSandbox.mockReturnValue({ name: sandboxName, gatewayName: "nemoclaw" });
    mocks.inspectSandboxPolicy.mockImplementation(() => ({
      policySource: "sandbox",
      effectivePolicy: YAML.parse(livePolicy),
      policy: YAML.parse(livePolicy),
      policyIdentity: { hash: "sha256:live", activeVersion: 1 },
    }));
    mocks.captureSandboxBasePolicy.mockImplementation(() => livePolicy);
    mocks.captureSandboxBasePolicyRevision.mockImplementation(() => livePolicy);
    mocks.runCapture.mockImplementation(() => livePolicy);
    mocks.resolveOpenshell.mockReturnValue("/usr/local/bin/openshell");
    mocks.run.mockImplementation((command: readonly string[]) => {
      const policyIndex = command.indexOf("--policy");
      livePolicy = fs.readFileSync(command[policyIndex + 1] as string, "utf8");
      return { status: 0 };
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("uses live policy state without a registry owner or receipt", () => {
    expect(inspectPolicyMutationContext(sandboxName, "inspect policy")).toEqual(
      expect.objectContaining({ gatewayName: "nemoclaw" }),
    );
    expect(inspectPolicyMutationContext(sandboxName, "inspect policy")).not.toHaveProperty(
      "authority",
    );
  });

  it("preserves an out-of-band host entry while adding and removing a preset", () => {
    expect(applyPresetContent(sandboxName, "weather", preset, { nonFatal: true })).toBe(true);
    expect(YAML.parse(livePolicy).network_policies).toEqual(
      expect.objectContaining({ host_approval: hostEntry, weather: expect.any(Object) }),
    );

    expect(removePreset(sandboxName, "weather", { nonFatal: true })).toBe(true);
    expect(YAML.parse(livePolicy).network_policies).toEqual({ host_approval: hostEntry });
  });

  it("does not overwrite a host edit that races a prepared full-policy update", () => {
    let observations = 0;
    mocks.inspectSandboxPolicy.mockImplementation(() => {
      observations += 1;
      livePolicy =
        observations === 2
          ? YAML.stringify({
              version: 1,
              network_policies: {
                host_approval: hostEntry,
                concurrent_host_edit: {
                  endpoints: [{ host: "concurrent.example.com", port: 443 }],
                },
              },
            })
          : livePolicy;
      const policy = YAML.parse(livePolicy);
      return {
        policySource: "sandbox",
        effectivePolicy: policy,
        policy,
        policyIdentity: {
          hash: `sha256:live-${String(observations)}`,
          activeVersion: observations,
        },
      };
    });

    expect(applyPresetContent(sandboxName, "weather", preset, { nonFatal: true })).toBe(false);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty("concurrent_host_edit");
  });

  it("preserves a host edit made after the final reread but before policy set", () => {
    let activeVersion = 1;
    let concurrentRevision = livePolicy;
    mocks.inspectSandboxPolicy.mockImplementation(() => {
      const policy = YAML.parse(livePolicy);
      return {
        policySource: "sandbox",
        effectivePolicy: policy,
        policy,
        policyIdentity: { hash: `sha256:live-${String(activeVersion)}`, activeVersion },
      };
    });
    mocks.captureSandboxBasePolicyRevision.mockImplementation(() => concurrentRevision);
    let writes = 0;
    mocks.run
      .mockImplementationOnce((command: readonly string[]) => {
        writes += 1;
        const policyIndex = command.indexOf("--policy");
        const requested = fs.readFileSync(command[policyIndex + 1] as string, "utf8");
        const concurrent = YAML.parse(livePolicy);
        concurrent.network_policies.concurrent_host_edit = {
          endpoints: [{ host: "concurrent.example.com", port: 443 }],
        };
        concurrentRevision = YAML.stringify(concurrent);
        activeVersion = 2;
        livePolicy = requested;
        activeVersion += 1;
        return { status: 0 };
      })
      .mockImplementation((command: readonly string[]) => {
        writes += 1;
        const policyIndex = command.indexOf("--policy");
        livePolicy = fs.readFileSync(command[policyIndex + 1] as string, "utf8");
        activeVersion += 1;
        return { status: 0 };
      });

    expect(applyPresetContent(sandboxName, "weather", preset, { nonFatal: true })).toBe(true);
    expect(writes).toBe(2);
    expect(YAML.parse(livePolicy).network_policies).toEqual(
      expect.objectContaining({
        host_approval: hostEntry,
        weather: expect.any(Object),
        concurrent_host_edit: expect.any(Object),
      }),
    );
  });

  it("reconciles five consecutive unrelated policy revisions before reporting success", () => {
    let activeVersion = 1;
    let concurrentRevision = livePolicy;
    let writes = 0;
    mocks.inspectSandboxPolicy.mockImplementation(() => {
      const policy = YAML.parse(livePolicy);
      return {
        policySource: "sandbox",
        effectivePolicy: policy,
        policy,
        policyIdentity: { hash: `sha256:live-${String(activeVersion)}`, activeVersion },
      };
    });
    mocks.captureSandboxBasePolicyRevision.mockImplementation(() => concurrentRevision);
    mocks.run.mockImplementation((command: readonly string[]) => {
      writes += 1;
      const policyIndex = command.indexOf("--policy");
      const requested = fs.readFileSync(command[policyIndex + 1] as string, "utf8");
      const concurrent = YAML.parse(livePolicy);
      concurrent.network_policies[`concurrent_host_edit_${String(writes)}`] = {
        endpoints: [{ host: `concurrent-${String(writes)}.example.com`, port: 443 }],
      };
      const raced = writes <= 5;
      concurrentRevision = raced ? YAML.stringify(concurrent) : concurrentRevision;
      activeVersion += Number(raced);
      livePolicy = requested;
      activeVersion += 1;
      return { status: 0 };
    });
    const desired = YAML.parse(livePolicy);
    desired.network_policies.requested_policy = {
      endpoints: [{ host: "requested.example.com", port: 443 }],
    };

    expect(setPolicyDocument(sandboxName, YAML.stringify(desired), { nonFatal: true })).toBe(true);
    expect(writes).toBe(6);
    expect(YAML.parse(livePolicy).network_policies).toEqual(
      expect.objectContaining({
        requested_policy: expect.any(Object),
        concurrent_host_edit_1: expect.any(Object),
        concurrent_host_edit_2: expect.any(Object),
        concurrent_host_edit_3: expect.any(Object),
        concurrent_host_edit_4: expect.any(Object),
        concurrent_host_edit_5: expect.any(Object),
      }),
    );
  });

  it("restores the latest external policy after the reconciliation bound is exhausted", () => {
    let activeVersion = 1;
    let concurrentRevision = livePolicy;
    let writes = 0;
    mocks.inspectSandboxPolicy.mockImplementation(() => {
      const policy = YAML.parse(livePolicy);
      return {
        policySource: "sandbox",
        effectivePolicy: policy,
        policy,
        policyIdentity: { hash: `sha256:live-${String(activeVersion)}`, activeVersion },
      };
    });
    mocks.captureSandboxBasePolicyRevision.mockImplementation(() => concurrentRevision);
    mocks.run.mockImplementation((command: readonly string[]) => {
      writes += 1;
      const policyIndex = command.indexOf("--policy");
      const requested = fs.readFileSync(command[policyIndex + 1] as string, "utf8");
      const concurrent = YAML.parse(livePolicy);
      concurrent.network_policies[`concurrent_host_edit_${String(writes)}`] = {
        endpoints: [{ host: `concurrent-${String(writes)}.example.com`, port: 443 }],
      };
      const raced = writes <= 6;
      concurrentRevision = raced ? YAML.stringify(concurrent) : concurrentRevision;
      activeVersion += Number(raced);
      livePolicy = requested;
      activeVersion += 1;
      return { status: 0 };
    });
    const desired = YAML.parse(livePolicy);
    desired.network_policies.requested_policy = {
      endpoints: [{ host: "requested.example.com", port: 443 }],
    };

    expect(setPolicyDocument(sandboxName, YAML.stringify(desired), { nonFatal: true })).toBe(false);
    expect(writes).toBe(7);
    expect(YAML.parse(livePolicy)).toEqual(YAML.parse(concurrentRevision));
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty("concurrent_host_edit_6");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "NemoClaw is restoring the latest external policy, and this update will not apply",
      ),
    );
  });

  it("restores the latest external policy when an edit races recovery", () => {
    livePolicy = YAML.stringify({
      version: 1,
      network_policies: {
        fake: {
          endpoints: [
            {
              host: "host.openshell.internal",
              port: 43117,
              protocol: "rest",
              enforcement: "enforce",
              request_body_credential_rewrite: true,
            },
          ],
        },
      },
    });
    let activeVersion = 1;
    let concurrentRevision = livePolicy;
    let writes = 0;
    mocks.inspectSandboxPolicy.mockImplementation(() => {
      const policy = YAML.parse(livePolicy);
      return {
        policySource: "sandbox",
        effectivePolicy: policy,
        policy,
        policyIdentity: { hash: `sha256:live-${String(activeVersion)}`, activeVersion },
      };
    });
    mocks.captureSandboxBasePolicyRevision.mockImplementation(() => concurrentRevision);
    mocks.run.mockImplementation((command: readonly string[]) => {
      writes += 1;
      const policyIndex = command.indexOf("--policy");
      const requested = fs.readFileSync(command[policyIndex + 1] as string, "utf8");
      const concurrent = YAML.parse(livePolicy);
      writes === 1
        ? (concurrent.network_policies.concurrent_host_edit = {
            endpoints: [{ host: "concurrent.example.com", port: 443 }],
          })
        : delete concurrent.network_policies.fake.endpoints[0].request_body_credential_rewrite;
      writes >= 2 && delete concurrent.network_policies.fake.endpoints[0].credential_binding;
      writes === 3 &&
        (concurrent.network_policies.latest_external_recovery_edit = {
          endpoints: [{ host: "latest-recovery.example.com", port: 443 }],
        });
      const raced = writes <= 3;
      concurrentRevision = raced ? YAML.stringify(concurrent) : concurrentRevision;
      activeVersion += Number(raced);
      livePolicy = requested;
      activeVersion += 1;
      return { status: 0 };
    });
    const desired = YAML.parse(livePolicy);
    desired.network_policies.fake.endpoints[0].credential_binding = {
      provider: "e2e-policy-provider",
    };

    expect(
      setPolicyDocument(sandboxName, YAML.stringify(desired), {
        nonFatal: true,
        reconciledDocumentIsAcceptable: (document) => {
          const endpoint = YAML.parse(document).network_policies.fake.endpoints[0];
          return (
            endpoint.credential_binding?.provider === "e2e-policy-provider" &&
            endpoint.enforcement === "enforce" &&
            endpoint.request_body_credential_rewrite === true
          );
        },
      }),
    ).toBe(false);
    expect(writes).toBe(4);
    expect(YAML.parse(livePolicy)).toEqual(YAML.parse(concurrentRevision));
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty("latest_external_recovery_edit");
    expect(YAML.parse(livePolicy).network_policies.fake.endpoints[0]).not.toHaveProperty(
      "credential_binding",
    );
    expect(YAML.parse(livePolicy).network_policies.fake.endpoints[0]).not.toHaveProperty(
      "request_body_credential_rewrite",
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "After the command finishes, run `openshell policy get -g nemoclaw --full live-policy`",
      ),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Run `openshell policy get -g nemoclaw --full live-policy` to inspect the effective policy",
      ),
    );
  });

  it("accepts an ambiguous write only when live readback matches", () => {
    const desiredPolicy = YAML.stringify({
      version: 1,
      network_policies: { host_approval: hostEntry, confirmed_after_reset: {} },
    });
    mocks.run.mockImplementation((command: readonly string[]) => {
      const policyIndex = command.indexOf("--policy");
      livePolicy = fs.readFileSync(command[policyIndex + 1] as string, "utf8");
      return { status: 3, stderr: "openshell: response stream reset" };
    });

    expect(setPolicyDocument(sandboxName, desiredPolicy, { nonFatal: true })).toBe(true);
    expect(mocks.captureSandboxBasePolicy).toHaveBeenCalledWith(sandboxName, "nemoclaw");
  });

  it("rejects an ambiguous write when live readback differs", () => {
    const desiredPolicy = YAML.stringify({
      version: 1,
      network_policies: { requested_but_absent: {} },
    });
    mocks.run.mockReturnValue({ status: 3, stderr: "openshell: response stream reset" });

    expect(setPolicyDocument(sandboxName, desiredPolicy, { nonFatal: true })).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("The current live policy differs from the requested document"),
    );
  });

  it("rejects an ambiguous write when live readback is unavailable", () => {
    const desiredPolicy = YAML.stringify({ version: 1, network_policies: {} });
    mocks.run.mockReturnValue({ status: 3, stderr: "openshell: response stream reset" });
    mocks.captureSandboxBasePolicy
      .mockImplementationOnce(() => livePolicy)
      .mockImplementation(() => {
        throw new PolicyObservationError("OpenShell policy read timed out");
      });

    expect(setPolicyDocument(sandboxName, desiredPolicy, { nonFatal: true })).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("The current live policy could not be read"),
    );
  });

  it("removes one baseline entry from the bounded live policy", () => {
    const baselineEntry = {
      name: "npm_registry",
      endpoints: [{ host: "registry.npmjs.org", port: 443 }],
    };
    livePolicy = YAML.stringify({
      version: 1,
      network_policies: { host_approval: hostEntry, npm_registry: baselineEntry },
    });

    expect(
      excludeBaselineEntry(sandboxName, "npm_registry", digestBaselineEntry(baselineEntry), {
        nonFatal: true,
      }),
    ).toBe(true);
    expect(YAML.parse(livePolicy).network_policies).toEqual({ host_approval: hostEntry });
  });

  it("does not let baseline exclude or restore overwrite a concurrent host edit", () => {
    const baselineEntry = {
      name: "npm_registry",
      endpoints: [{ host: "registry.npmjs.org", port: 443 }],
    };
    const concurrentEntry = {
      endpoints: [{ host: "concurrent.example.com", port: 443 }],
    };
    const installRace = () => {
      let observations = 0;
      const observe = () => {
        observations += 1;
        const policy = YAML.parse(livePolicy);
        return {
          policySource: "sandbox",
          effectivePolicy: policy,
          policy,
          policyIdentity: {
            hash: `sha256:baseline-${String(observations)}`,
            activeVersion: observations,
          },
        };
      };
      const observeConcurrentEdit = () => {
        const document = YAML.parse(livePolicy);
        document.network_policies.concurrent_host_edit = concurrentEntry;
        livePolicy = YAML.stringify(document);
        return observe();
      };
      mocks.inspectSandboxPolicy
        .mockReset()
        .mockImplementationOnce(observe)
        .mockImplementationOnce(observeConcurrentEdit)
        .mockImplementation(observe);
    };

    livePolicy = YAML.stringify({
      version: 1,
      network_policies: { host_approval: hostEntry, npm_registry: baselineEntry },
    });
    installRace();
    expect(
      excludeBaselineEntry(sandboxName, "npm_registry", digestBaselineEntry(baselineEntry), {
        nonFatal: true,
      }),
    ).toBe(false);
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty("concurrent_host_edit");

    mocks.run.mockClear();
    livePolicy = YAML.stringify({
      version: 1,
      network_policies: { host_approval: hostEntry },
    });
    installRace();
    expect(restoreBaselineEntry(sandboxName, "npm_registry", { nonFatal: true })).toBe(false);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty("concurrent_host_edit");
  });

  it("makes no mutation when the bounded base-policy adapter refuses the read", () => {
    mocks.captureSandboxBasePolicy.mockImplementation(() => {
      throw new PolicyObservationError("OpenShell policy read timed out");
    });

    expect(applyPresetContent(sandboxName, "weather", preset, { nonFatal: true })).toBe(false);
    expect(removePreset(sandboxName, "weather", { nonFatal: true, presetContent: preset })).toBe(
      false,
    );
    expect(applyPresets(sandboxName, ["npm"])).toBe(false);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("derives custom preset identity from namespaced OpenShell keys", () => {
    expect(
      applyPresetContent(sandboxName, "weather", preset, {
        custom: { sourcePath: "/tmp/weather.yaml" },
        nonFatal: true,
      }),
    ).toBe(true);
    expect(YAML.parse(livePolicy).network_policies).toHaveProperty(
      "nemoclaw_custom__weather__weather",
    );
  });
});
