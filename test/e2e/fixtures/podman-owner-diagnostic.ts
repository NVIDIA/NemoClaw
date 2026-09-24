// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import type { HostCliClient } from "./clients/host";
import type { RuntimeProviderGatewaySurface } from "../../../src/lib/onboard/runtime-provider/contract";
import { snapshotPodmanOwner } from "./podman-owner-snapshot";

type OwnedGateway = Extract<RuntimeProviderGatewaySurface, { ownsHostReadiness: true }>;

type Fact = ReturnType<typeof snapshotPodmanOwner>;
type Report = {
  kind: "podman-owner-observation-v1";
  source: "verified" | "unverified" | "unavailable";
  facts?: Fact;
};
export function observeWithOwnerDiagnostic(
  gateway: OwnedGateway,
  capture: (report: Report) => void,
  snapshot = snapshotPodmanOwner,
): OwnedGateway {
  return {
    ...gateway,
    observeOwnedGateway(input) {
      const result = gateway.observeOwnedGateway(input);
      try {
        const verified = result.listenerScan.pids;
        const unverified = result.listenerScan.unverifiedPids;
        const listeners = [...verified, ...unverified];
        capture(
          listeners.length === 1
            ? {
                kind: "podman-owner-observation-v1",
                source: verified.length === 1 ? "verified" : "unverified",
                facts: snapshot(input, listeners[0]!),
              }
            : { kind: "podman-owner-observation-v1", source: "unavailable" },
        );
      } catch {
        /* Diagnostic failure cannot replace authoritative observation. */
      }
      return result;
    },
  };
}

export async function capturePodmanOwnerDiagnostic(
  environment: NodeJS.ProcessEnv,
): Promise<Report> {
  let report: Report = { kind: "podman-owner-observation-v1", source: "unavailable" };
  try {
    const { createProductionGatewayReadinessDependencies } =
      require("../../../src/lib/readiness/gateway-production") as typeof import("../../../src/lib/readiness/gateway-production");
    const { resolveConfiguredRuntimeProvider } =
      require("../../../src/lib/onboard/runtime-provider/selection") as typeof import("../../../src/lib/onboard/runtime-provider/selection");
    const provider = resolveConfiguredRuntimeProvider(process.platform, process.arch, environment);
    if (provider.identity.id !== "podman" || !provider.gateway.ownsHostReadiness) return report;
    const gateway = observeWithOwnerDiagnostic(provider.gateway, (value) => {
      report = value;
    });
    const dependencies = createProductionGatewayReadinessDependencies({
      environment,
      resolveRuntimeProviderGateway: () => gateway,
    });
    await dependencies.observeManagedGateway(await dependencies.resolveOwner());
  } catch {
    /* No raw errors or authority-file contents enter artifacts. */
  }
  return report;
}

/** Additional read-only snapshots; original command outcome and registered cleanup remain authoritative. */
export async function withPodmanOwnerDiagnostic<T>(
  environment: NodeJS.ProcessEnv,
  write: (phase: "before" | "after", report: Report) => Promise<unknown>,
  run: () => Promise<T>,
  capture: (
    environment: NodeJS.ProcessEnv,
    phase: "before" | "after",
  ) => Promise<Report> = capturePodmanOwnerDiagnostic,
): Promise<T> {
  const record = async (phase: "before" | "after") => {
    try {
      await write(phase, await capture(environment, phase));
    } catch {
      /* Preserve command and cleanup semantics. */
    }
  };
  await record("before");
  try {
    return await run();
  } finally {
    await record("after");
  }
}

export async function captureBoundedPodmanOwnerDiagnostic(
  host: Pick<HostCliClient, "command">,
  environment: NodeJS.ProcessEnv,
  phase: "before" | "after",
): Promise<Report> {
  const unavailable: Report = { kind: "podman-owner-observation-v1", source: "unavailable" };
  try {
    const entry = fileURLToPath(import.meta.url);
    const loader = fileURLToPath(import.meta.resolve("tsx/cjs"));
    const script = `const write = process.stdout.write.bind(process.stdout); require(${JSON.stringify(entry)}).capturePodmanOwnerDiagnostic(process.env).then(report => write(JSON.stringify(report))).catch(() => write(JSON.stringify({kind:"podman-owner-observation-v1",source:"unavailable"})));`;
    const result = await host.command(process.execPath, ["--require", loader, "-e", script], {
      env: environment,
      artifactName: `owner-snapshot-${phase}`,
      timeoutMs: 60_000,
      persistArtifacts: false,
      captureLimitBytes: 4096,
    });
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.stdout.length > 4096 ||
      result.stderr.length !== 0
    )
      return unavailable;
    const value = JSON.parse(result.stdout) as Report;
    if (
      value.kind !== unavailable.kind ||
      !["verified", "unverified", "unavailable"].includes(value.source)
    )
      return unavailable;
    if (Object.keys(value).some((key) => !["kind", "source", "facts"].includes(key)))
      return unavailable;
    const factKeys = [
      "kind",
      "available",
      "pidFileReadable",
      "pidFileMatchesListener",
      "markerReadable",
      "markerParsed",
      "markerMatchesListener",
      "markerIsPodman",
      "markerPlatformMatchesExpected",
      "markerArchitectureMatchesExpected",
      "markerEndpointMatchesExpected",
      "trustedExecutableResolved",
      "markerExecutableMatchesTrusted",
      "runningExecutableMatchesTrusted",
    ];
    if (value.source === "unavailable") {
      return value.facts === undefined ? value : unavailable;
    }
    const facts = value.facts;
    if (
      !facts ||
      typeof facts !== "object" ||
      Array.isArray(facts) ||
      facts.kind !== "podman-owner-snapshot-v1" ||
      typeof facts.available !== "boolean"
    )
      return unavailable;
    const expectedKeys = facts.available ? factKeys : ["kind", "available"];
    if (
      Object.keys(facts).length !== expectedKeys.length ||
      Object.keys(facts).some((key) => !expectedKeys.includes(key)) ||
      expectedKeys.some(
        (key) => key !== "kind" && typeof (facts as Record<string, unknown>)[key] !== "boolean",
      )
    )
      return unavailable;
    return value;
  } catch {
    return unavailable;
  }
}
