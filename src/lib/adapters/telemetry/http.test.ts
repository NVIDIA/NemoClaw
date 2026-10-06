// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyTelemetryHostOS,
  normalizeTelemetryArchitecture,
  type TelemetryConfiguration,
  type TelemetryLocation,
} from "../../domain/telemetry/dimensions";
import { buildInstallCompletedEvent, type TelemetryEvent } from "../../domain/telemetry/event";
import { isWsl } from "../../platform/wsl";
import {
  GXT_EVENT_PROTOCOL_VERSION,
  NEMOCLAW_TELEMETRY_CLIENT_ID,
  NEMOCLAW_TELEMETRY_SCHEMA_VERSION,
  NEMOCLAW_TELEMETRY_SYSTEM_VERSION,
} from "./gxt";
import { postTelemetryBatch, postTelemetryEvent, TELEMETRY_DELIVERY_DEADLINE_MS } from "./http";
import { MAX_TELEMETRY_BATCH_EVENTS } from "../../domain/telemetry/observations";
import { acceptsTelemetryParameters } from "./gxt.test-support";

const servers: http.Server[] = [];

const configuration: TelemetryConfiguration = {
  agentHarnessId: "openclaw",
  agentHarnessStatus: "reported",
  modelId: "deepseek-ai/DeepSeek-V4-Flash",
  modelStatus: "reported",
  providerProfile: "nvidia",
  apiFamily: "openai-completions",
  sandboxOS: "linux",
  sandboxOSStatus: "reported",
  computeDriver: "kubernetes",
  gpuState: "configured_unverified",
  webSearchEnabled: false,
  observabilityEnabled: true,
  imageOwnership: "custom",
  policyTier: null,
  policyTierStatus: "not_persisted",
  configuredMessagingChannels: ["telegram", "slack"],
  messagingStatus: "reported",
};

const location: TelemetryLocation = {
  countryCode: "CA",
  countryName: "Canada",
  regionName: "Ontario",
  cityName: "Toronto",
  locationSource: "approved_deployment",
  locationStatus: "reported",
  locationPrecision: "city",
  locationObservedAt: "2026-10-01T15:00:00.000Z",
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

const snapshotEvents: TelemetryEvent[] = [
  { event: "nemoclaw_sandbox_count_observed", operation: "onboard", count: 1 },
  {
    event: "nemoclaw_configuration_completed",
    operation: "onboard",
    configuration: { ...configuration, policyTier: "restricted", policyTierStatus: "reported" },
    scope: "published_configuration",
  },
  {
    event: "nemoclaw_agent_runtime_observed",
    operation: "onboard",
    agent_runtime: "openclaw",
    count: 1,
  },
  {
    event: "nemoclaw_managed_agent_version_observed",
    operation: "onboard",
    agent_runtime: "openclaw",
    managed_agent_version: "other",
    count: 1,
  },
  {
    event: "nemoclaw_model_observed",
    operation: "onboard",
    model_source: "provider_catalog",
    known_model_key: "deepseek_v4_flash",
    modelId: "deepseek-ai/DeepSeek-V4-Flash",
    provider_profile: "nvidia",
    api_family: "openai-completions",
    count: 1,
  },
  {
    event: "nemoclaw_messaging_observed",
    operation: "onboard",
    messaging_channel: "telegram",
    count: 1,
  },
  {
    event: "nemoclaw_configuration_observed",
    operation: "onboard",
    scope: "sandbox",
    signal: "policy_tier",
    value: "restricted",
    count: 1,
  },
];

describe("telemetry snapshot HTTP delivery", () => {
  it.each(Array.from({ length: snapshotEvents.length + 1 }, (_, index) => index))(
    "preserves a matching ambient QA label on batch record %s and the derived host record",
    async (index) => {
      const testLabel = "qa-campaign:case:attempt-1";
      const bodies: Array<{ events: Array<{ parameters: Record<string, unknown> }> }> = [];
      const endpoint = await listen(
        http.createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            response.writeHead(204).end();
          });
        }),
      );
      vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", testLabel);
      await expect(
        postTelemetryBatch(
          { endpoint },
          snapshotEvents.map((event) => ({
            ...event,
            testLabel,
          })),
        ),
      ).resolves.toBe("delivered");
      expect(bodies).toHaveLength(1);
      expect(bodies[0].events).toHaveLength(snapshotEvents.length + 1);
      const event = bodies[0].events[index];
      expect(event.parameters.testLabel).toBe(testLabel);
      expect(acceptsTelemetryParameters(event.parameters)).toBe(true);
    },
  );

  it.each(Array.from({ length: snapshotEvents.length + 1 }, (_, index) => index))(
    "posts snapshot record %s in one request with one host and location collection (#10435)",
    async (index) => {
      const bodies: Array<{
        clientVer: string;
        cpuArchitecture: string;
        sentTs: string;
        gdprFuncOptIn: string;
        deviceGdprFuncOptIn: string;
        events: Array<{ name: string; ts: string; parameters: Record<string, unknown> }>;
      }> = [];
      const endpoint = await listen(
        http.createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            bodies.push(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as (typeof bodies)[number],
            );
            response.writeHead(204).end();
          });
        }),
      );
      let locationReads = 0;
      await expect(
        postTelemetryBatch(
          {
            endpoint,
            resolveLocation: async () => {
              locationReads += 1;
              return location;
            },
          },
          snapshotEvents,
        ),
      ).resolves.toBe("delivered");
      expect(bodies).toHaveLength(1);
      expect(locationReads).toBe(1);
      const body = bodies[0];
      expect(body.events).toHaveLength(snapshotEvents.length + 1);
      expect(body.events.map((event) => event.name)).toEqual([
        ...snapshotEvents.map((event) => event.event),
        "nemoclaw_configuration_observed",
      ]);
      expect(body.clientVer).toMatch(/^\d+\.\d+\.\d+/u);
      expect(body.cpuArchitecture).toBe(
        normalizeTelemetryArchitecture(process.arch).cpuArchitecture,
      );
      expect(body.gdprFuncOptIn).toBe("None");
      expect(body.deviceGdprFuncOptIn).toBe("None");
      const event = body.events[index];
      expect(event.ts).toBe(body.sentTs);
      expect(event.parameters.countryCode).toBe("CA");
      expect(event.parameters.cityName).toBe("Toronto");
      expect(event.parameters.locationSource).toBe("approved_deployment");
      expect(event.parameters.hostArch).toBe(process.arch);
      expect(acceptsTelemetryParameters(event.parameters)).toBe(true);
      expect(body.events[1].parameters).toMatchObject({
        configurationScope: "published_configuration",
        agentHarnessId: "openclaw",
        modelId: "deepseek-ai/DeepSeek-V4-Flash",
        sandboxOS: "linux",
        policyTier: "restricted",
        policyTierStatus: "reported",
        configuredMessagingChannels: ["telegram", "slack"],
      });
      expect(body.events[4].parameters).toMatchObject({
        configurationScope: "aggregate",
        model_source: "provider_catalog",
        known_model_key: "deepseek_v4_flash",
        provider_profile: "nvidia",
        api_family: "openai-completions",
        count: 1,
      });
      expect(body.events.filter((event) => event.name === "nemoclaw_install_completed")).toEqual(
        [],
      );
      expect(JSON.stringify(body)).not.toContain("isSynthetic");
      expect(JSON.stringify(body)).not.toContain("endpointUrl");
    },
  );

  it("rejects an invalid middle event before a lookup or request (#10435)", async () => {
    let requests = 0;
    let locationReads = 0;
    const endpoint = await listen(
      http.createServer((request, response) => {
        requests += 1;
        request.resume();
        response.writeHead(204).end();
      }),
    );
    const invalid = {
      ...snapshotEvents[1],
      endpointUrl: "https://private.invalid",
    } as unknown as TelemetryEvent;
    await expect(
      postTelemetryBatch(
        {
          endpoint,
          resolveLocation: async () => {
            locationReads += 1;
            return location;
          },
        },
        [snapshotEvents[0], invalid, snapshotEvents[2]],
      ),
    ).resolves.toBe("failed");
    expect(requests).toBe(0);
    expect(locationReads).toBe(0);
  });

  it("rejects an oversized event count before a lookup or request (#10442)", async () => {
    let requests = 0;
    let locationReads = 0;
    const endpoint = await listen(
      http.createServer((request, response) => {
        requests += 1;
        request.resume();
        response.writeHead(204).end();
      }),
    );
    const events = Array.from({ length: MAX_TELEMETRY_BATCH_EVENTS + 1 }, () => snapshotEvents[1]);
    await expect(
      postTelemetryBatch(
        {
          endpoint,
          resolveLocation: async () => {
            locationReads += 1;
            return location;
          },
        },
        events,
      ),
    ).resolves.toBe("failed");
    expect(requests).toBe(0);
    expect(locationReads).toBe(0);
  });

  it.each(["qa-shanghai-20261005:linux-openclaw:attempt-2", undefined])(
    "rejects mixed or partially labeled batches before a lookup or request (%s)",
    async (secondLabel) => {
      let requests = 0;
      let locationReads = 0;
      const endpoint = await listen(
        http.createServer((request, response) => {
          requests += 1;
          request.resume();
          response.writeHead(204).end();
        }),
      );
      const events: TelemetryEvent[] = [
        { ...snapshotEvents[0], testLabel: "qa-shanghai-20261005:linux-openclaw:attempt-1" },
        { ...snapshotEvents[2], ...(secondLabel ? { testLabel: secondLabel } : {}) },
      ];
      await expect(
        postTelemetryBatch(
          {
            endpoint,
            resolveLocation: async () => {
              locationReads += 1;
              return location;
            },
          },
          events,
        ),
      ).resolves.toBe("failed");
      expect(requests).toBe(0);
      expect(locationReads).toBe(0);
    },
  );

  it("rejects an oversized encoded envelope without sending a partial batch (#10435)", async () => {
    let requests = 0;
    const endpoint = await listen(
      http.createServer((request, response) => {
        requests += 1;
        request.resume();
        response.writeHead(204).end();
      }),
    );
    const events = Array.from({ length: MAX_TELEMETRY_BATCH_EVENTS }, () => snapshotEvents[1]);
    await expect(postTelemetryBatch({ endpoint }, events)).resolves.toBe("failed");
    expect(requests).toBe(0);
  });

  it("does not retry a rejected complete snapshot (#10442)", async () => {
    let requests = 0;
    const endpoint = await listen(
      http.createServer((request, response) => {
        requests += 1;
        request.resume();
        response.writeHead(503).end();
      }),
    );
    await expect(postTelemetryBatch({ endpoint }, snapshotEvents)).resolves.toBe("failed");
    expect(requests).toBe(1);
  });
});

async function listen(server: http.Server): Promise<URL> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/events`);
}

function expectedPayload(
  operation: TelemetryEvent["operation"],
  observed: Record<string, unknown> = {},
) {
  return {
    browserType: "undefined",
    clientId: NEMOCLAW_TELEMETRY_CLIENT_ID,
    clientType: "Native",
    clientVariant: "Release",
    clientVer: expect.stringMatching(/^\d+\.\d+\.\d+/u),
    cpuArchitecture: normalizeTelemetryArchitecture(process.arch).cpuArchitecture,
    deviceGdprBehOptIn: "None",
    deviceGdprFuncOptIn: "None",
    deviceGdprTechOptIn: "None",
    deviceId: "undefined",
    deviceMake: "undefined",
    deviceModel: "undefined",
    deviceOS: "undefined",
    deviceOSVersion: "undefined",
    deviceType: "undefined",
    eventProtocol: GXT_EVENT_PROTOCOL_VERSION,
    eventSchemaVer: NEMOCLAW_TELEMETRY_SCHEMA_VERSION,
    eventSysVer: NEMOCLAW_TELEMETRY_SYSTEM_VERSION,
    externalUserId: "undefined",
    gdprBehOptIn: "None",
    gdprFuncOptIn: "None",
    gdprTechOptIn: "None",
    idpId: "undefined",
    integrationId: "undefined",
    productName: "undefined",
    productVersion: "undefined",
    sentTs: expect.any(String),
    sessionId: "undefined",
    userId: "undefined",
    events: [
      {
        name:
          operation === "install" || operation === "update"
            ? "nemoclaw_install_completed"
            : "nemoclaw_configuration_completed",
        parameters: {
          nvidiaSource: "nemoclaw",
          testLabel: "",
          operation,
          configurationScope:
            operation === "install" || operation === "update"
              ? "operation"
              : "primary_configuration",
          hostOS: classifyTelemetryHostOS(process.platform),
          hostContext: isWsl() ? "wsl" : "native",
          hostArch: process.arch,
          agentHarnessId: "unknown",
          agentHarnessStatus: "not_observed",
          modelId: "unknown",
          modelStatus: "not_observed",
          providerProfile: "unknown",
          apiFamily: "unknown",
          sandboxOS: "unknown",
          sandboxOSStatus: "not_observed",
          computeDriver: "unknown",
          gpuState: "unknown",
          webSearchEnabled: "unknown",
          observabilityEnabled: "unknown",
          imageOwnership: "unknown",
          policyTier: "unknown",
          policyTierStatus: "not_persisted",
          configuredMessagingChannels: [],
          messagingStatus: "not_observed",
          countryCode: "",
          countryName: "",
          regionName: "",
          cityName: "",
          locationSource: "none",
          locationStatus: "not_configured",
          locationPrecision: "none",
          locationObservedAt: "",
          ...observed,
        },
        ts: expect.any(String),
      },
    ],
  };
}

describe("telemetry HTTP delivery", () => {
  it.each(["qa-shanghai-20261005:linux-openclaw:attempt-1", "", "private@example.com"])(
    "rejects an invalid or unmatched ambient QA label %j before reading configuration",
    async (testLabel) => {
      let reads = 0;
      const config = Object.defineProperty(
        { endpoint: new URL("http://127.0.0.1/events") },
        "endpoint",
        {
          get: () => {
            reads += 1;
            return new URL("http://127.0.0.1/events");
          },
        },
      );
      vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", testLabel);
      await expect(postTelemetryEvent(config, buildInstallCompletedEvent("install"))).resolves.toBe(
        "failed",
      );
      await expect(postTelemetryBatch(config, snapshotEvents)).resolves.toBe("failed");
      expect(reads).toBe(0);
    },
  );

  it("uses the single five-second production deadline (#10440)", () => {
    expect(TELEMETRY_DELIVERY_DEADLINE_MS).toBe(5_000);
  });

  it.each(["onboard", "inference_set"] as const)(
    "posts every completed %s configuration field with approved geography (#10440)",
    async (operation) => {
      const bodies: unknown[] = [];
      let resolutions = 0;
      let resolverSignal: AbortSignal | undefined;
      const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          response.writeHead(204).end();
        });
      });
      const endpoint = await listen(server);
      await expect(
        postTelemetryEvent(
          {
            endpoint,
            resolveLocation: async (signal) => {
              resolutions += 1;
              resolverSignal = signal;
              return location;
            },
          },
          { event: "nemoclaw_configuration_completed", operation, configuration },
        ),
      ).resolves.toBe("delivered");
      expect(bodies).toEqual([
        expectedPayload(operation, {
          ...configuration,
          ...location,
          webSearchEnabled: "false",
          observabilityEnabled: "true",
          policyTier: "unknown",
        }),
      ]);
      expect(resolutions).toBe(1);
      expect(resolverSignal?.aborted).toBe(true);
    },
  );

  it("preserves a country-only result without inventing region or city (#10440)", async () => {
    const bodies: unknown[] = [];
    const partial = {
      ...location,
      regionName: null,
      cityName: null,
      locationStatus: "partial",
      locationPrecision: "country",
    };
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        response.writeHead(204).end();
      });
    });
    const endpoint = await listen(server);
    await expect(
      postTelemetryEvent(
        { endpoint, resolveLocation: async () => partial },
        buildInstallCompletedEvent("install"),
      ),
    ).resolves.toBe("delivered");
    expect(bodies).toEqual([
      expectedPayload("install", { ...partial, regionName: "", cityName: "" }),
    ]);
  });

  it("delivers only to the endpoint validated before a resolver mutates its input (#10440)", async () => {
    const requests: Array<{
      path: string | undefined;
      authorization: string | undefined;
      body: unknown;
    }> = [];
    let redirectedRequests = 0;
    const redirected = await listen(
      http.createServer((request, response) => {
        redirectedRequests += 1;
        request.resume();
        response.writeHead(204).end();
      }),
    );
    const endpoint = await listen(
      http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          requests.push({
            path: request.url,
            authorization: request.headers.authorization,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          });
          response.writeHead(204).end();
        });
      }),
    );
    await expect(
      postTelemetryEvent(
        {
          endpoint,
          resolveLocation: async () => {
            endpoint.port = redirected.port;
            endpoint.username = "private-user";
            endpoint.password = "private-password";
            endpoint.search = "?private=value";
            return location;
          },
        },
        buildInstallCompletedEvent("install"),
      ),
    ).resolves.toBe("delivered");
    expect(redirectedRequests).toBe(0);
    expect(requests).toEqual([
      {
        path: "/events",
        authorization: undefined,
        body: expectedPayload("install", { ...location }),
      },
    ]);
  });

  it.each([
    {
      failure: "rejected",
      resolve: async () => {
        throw new Error("private-provider-error");
      },
    },
    { failure: "non-object", resolve: async () => "private-provider-response" },
    {
      failure: "private-url",
      resolve: async () => ({ ...location, cityName: "https://private.example/v1" }),
    },
    { failure: "ip-address", resolve: async () => ({ ...location, cityName: "192.0.2.1" }) },
    { failure: "identifier", resolve: async () => ({ ...location, deviceId: "private-host" }) },
    {
      failure: "unapproved-source",
      resolve: async () => ({ ...location, locationSource: "none" }),
    },
    {
      failure: "contradictory-status",
      resolve: async () => ({ ...location, locationStatus: "partial" }),
    },
    {
      failure: "calendar-invalid",
      resolve: async () => ({ ...location, locationObservedAt: "2026-02-30T15:00:00.000Z" }),
    },
    {
      failure: "throwing-property",
      resolve: async () =>
        Object.defineProperty({ ...location }, "cityName", {
          enumerable: true,
          get: () => {
            throw new Error("private-provider-error");
          },
        }),
    },
  ])(
    "sends one bounded unavailable-location fallback for $failure data (#10440)",
    async ({ resolve }) => {
      const bodies: unknown[] = [];
      const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          response.writeHead(204).end();
        });
      });
      const endpoint = await listen(server);
      let resolutions = 0;
      const resolveLocation = async () => {
        resolutions += 1;
        return await resolve();
      };
      await expect(
        postTelemetryEvent({ endpoint, resolveLocation }, buildInstallCompletedEvent("install")),
      ).resolves.toBe("delivered");
      expect(resolutions).toBe(1);
      expect(bodies).toEqual([expectedPayload("install", { locationStatus: "unavailable" })]);
      expect(JSON.stringify(bodies)).not.toContain("private-");
    },
  );

  it("abandons a hanging resolver and ignores its late response without a second send (#10440)", async () => {
    const bodies: unknown[] = [];
    let resolverSignal: AbortSignal | undefined;
    let finishResolution: (value: unknown) => void = () => undefined;
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        response.writeHead(204).end();
      });
    });
    const endpoint = await listen(server);
    await expect(
      postTelemetryEvent(
        {
          endpoint,
          resolveLocation: (signal) => {
            resolverSignal = signal;
            return new Promise<unknown>((resolve) => {
              finishResolution = resolve;
            });
          },
        },
        buildInstallCompletedEvent("install"),
        1_000,
      ),
    ).resolves.toBe("delivered");
    expect(resolverSignal?.aborted).toBe(true);
    const lateLocation = Object.defineProperty({ ...location }, "cityName", {
      enumerable: true,
      get: () => {
        throw new Error("Late response must not be inspected");
      },
    });
    finishResolution(lateLocation);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bodies).toEqual([expectedPayload("install", { locationStatus: "unavailable" })]);
  });

  it("shares one deadline between location resolution and a stalled receiver (#10440)", async () => {
    let requests = 0;
    let resolverSignal: AbortSignal | undefined;
    const server = http.createServer((request) => {
      requests += 1;
      request.resume();
    });
    const endpoint = await listen(server);
    const startedAt = performance.now();
    await expect(
      postTelemetryEvent(
        {
          endpoint,
          resolveLocation: (signal) => {
            resolverSignal = signal;
            return new Promise<unknown>(() => undefined);
          },
        },
        buildInstallCompletedEvent("install"),
        1_000,
      ),
    ).resolves.toBe("failed");
    expect(performance.now() - startedAt).toBeLessThan(1_800);
    expect(requests).toBe(1);
    expect(resolverSignal?.aborted).toBe(true);
  });

  it.each([
    { name: "private model", invalid: { modelId: "private-company/model" } },
    { name: "duplicate channels", invalid: { configuredMessagingChannels: ["slack", "slack"] } },
  ])("rejects $name before a location lookup or network request (#10440)", async ({ invalid }) => {
    let requests = 0;
    let resolutions = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      response.writeHead(204).end();
    });
    const endpoint = await listen(server);
    const event = {
      event: "nemoclaw_configuration_completed",
      operation: "onboard",
      configuration: { ...configuration, ...invalid },
    } as unknown as TelemetryEvent;
    await expect(
      postTelemetryEvent(
        {
          endpoint,
          resolveLocation: async () => {
            resolutions += 1;
            return location;
          },
        },
        event,
      ),
    ).resolves.toBe("failed");
    expect(requests).toBe(0);
    expect(resolutions).toBe(0);
  });

  it.each([
    "http://public.example/events",
    "http://user:secret@127.0.0.1/events",
    "https://telemetry.example/events?secret=value",
    "https://telemetry.example/events#private",
    "file:///private/events",
  ])("refuses unsafe endpoint %s before a location lookup (#10440)", async (address) => {
    let resolutions = 0;
    await expect(
      postTelemetryEvent(
        {
          endpoint: new URL(address),
          resolveLocation: async () => {
            resolutions += 1;
            return location;
          },
        },
        buildInstallCompletedEvent("install"),
      ),
    ).resolves.toBe("failed");
    expect(resolutions).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses invalid deadline %s before a location lookup (#10440)",
    async (deadline) => {
      let resolutions = 0;
      await expect(
        postTelemetryEvent(
          {
            endpoint: new URL("http://127.0.0.1/events"),
            resolveLocation: async () => {
              resolutions += 1;
              return location;
            },
          },
          buildInstallCompletedEvent("install"),
          deadline,
        ),
      ).resolves.toBe("failed");
      expect(resolutions).toBe(0);
    },
  );

  it("does not follow a redirect or retry its event (#10440)", async () => {
    let targetRequests = 0;
    const target = await listen(
      http.createServer((request, response) => {
        targetRequests += 1;
        request.resume();
        response.writeHead(204).end();
      }),
    );
    let requests = 0;
    const endpoint = await listen(
      http.createServer((request, response) => {
        requests += 1;
        request.resume();
        response.writeHead(307, { location: target.href }).end();
      }),
    );
    await expect(
      postTelemetryEvent({ endpoint }, buildInstallCompletedEvent("install")),
    ).resolves.toBe("failed");
    expect(requests).toBe(1);
    expect(targetRequests).toBe(0);
  });

  it.each(["install", "update"] as const)(
    "posts one validated %s event to a local receiver (#10440)",
    async (operation) => {
      const requests: Array<{
        method: string | undefined;
        contentType: string | undefined;
        accept: string | undefined;
        eventProtocol: string | undefined;
        body: unknown;
      }> = [];
      const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          requests.push({
            method: request.method,
            contentType: request.headers["content-type"],
            accept: request.headers.accept,
            eventProtocol: request.headers["x-event-protocol"] as string | undefined,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          });
          response.writeHead(204).end();
        });
      });
      const endpoint = await listen(server);

      await expect(
        postTelemetryEvent({ endpoint }, buildInstallCompletedEvent(operation)),
      ).resolves.toBe("delivered");

      expect(requests).toEqual([
        {
          method: "POST",
          contentType: "application/json;charset=utf-8",
          accept: "application/json",
          eventProtocol: GXT_EVENT_PROTOCOL_VERSION,
          body: expectedPayload(operation),
        },
      ]);
      const payload = requests[0]?.body as { sentTs?: string; events?: Array<{ ts?: string }> };
      expect(payload.sentTs).toBe(payload.events?.[0]?.ts);
      expect(Number.isNaN(Date.parse(payload.sentTs ?? ""))).toBe(false);
    },
  );

  it("does not retry a rejected event (#10440)", async () => {
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests += 1;
      request.resume();
      response.writeHead(503).end();
    });
    const endpoint = await listen(server);

    await expect(
      postTelemetryEvent({ endpoint }, buildInstallCompletedEvent("update")),
    ).resolves.toBe("failed");
    expect(requests).toBe(1);
  });

  it("fails once when the receiver refuses the connection (#10440)", async () => {
    const server = http.createServer();
    const endpoint = await listen(server);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    servers.splice(servers.indexOf(server), 1);

    await expect(
      postTelemetryEvent({ endpoint }, buildInstallCompletedEvent("install")),
    ).resolves.toBe("failed");
  });

  it("applies one total deadline to a trickling response (#10440)", async () => {
    let requests = 0;
    let resolveRequestReceived: () => void = () => undefined;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequestReceived = resolve;
    });
    const server = http.createServer((request, response) => {
      requests += 1;
      resolveRequestReceived();
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      const timer = setInterval(() => response.write(" "), 20);
      response.once("close", () => clearInterval(timer));
    });
    const endpoint = await listen(server);

    const delivery = postTelemetryEvent({ endpoint }, buildInstallCompletedEvent("install"), 1_000);
    await requestReceived;
    await expect(delivery).resolves.toBe("failed");
    expect(requests).toBe(1);
  });

  it("refuses an event with additional free-form data before networking (#10440)", async () => {
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      response.writeHead(204).end();
    });
    const endpoint = await listen(server);
    const event = {
      event: "nemoclaw_install_completed",
      operation: "install",
      detail: "free-form",
    } as unknown as ReturnType<typeof buildInstallCompletedEvent>;

    await expect(postTelemetryEvent({ endpoint }, event)).resolves.toBe("failed");
    expect(requests).toBe(0);
  });

  it("strips a hidden serialization override from an otherwise valid event (#10440)", async () => {
    const bodies: unknown[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        response.writeHead(204).end();
      });
    });
    const endpoint = await listen(server);
    const event = { event: "nemoclaw_install_completed", operation: "install" };
    Object.defineProperty(event, "toJSON", {
      enumerable: false,
      value: () => ({ ...event, detail: "free-form" }),
    });

    await expect(
      postTelemetryEvent({ endpoint }, event as ReturnType<typeof buildInstallCompletedEvent>),
    ).resolves.toBe("delivered");
    expect(bodies).toEqual([expectedPayload("install")]);
  });
});
