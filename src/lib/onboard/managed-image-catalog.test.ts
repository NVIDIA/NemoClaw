// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  ManagedImageCatalogError,
  ManagedImageCatalogUnavailableError,
  normalizeManagedImageRelease,
  resolveManagedImageCatalogFromGhcr,
  resolveManagedImageContractFromGhcr,
} from "./managed-image/catalog";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImagePlatform,
  managedImagePlatformForNodeArchitecture,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "./managed-image/contract";

const RELEASE = "v0.0.97";
const REVISION = "2f03907c3a7ec151d7f5d4bb2a73abafc2849f83";
const COHORT = "ghrun-12345-1";
const TEST_PLATFORM = managedImagePlatformForNodeArchitecture(process.arch) ?? "linux/amd64";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";

type RegistryFixtureOptions = {
  readonly blobRedirectLocation?: string;
  readonly blobRedirectStatus?: number;
  readonly duplicatePlatform?: boolean;
  readonly directManifest?: boolean;
  readonly configBodyMismatch?: boolean;
  readonly labels?: Readonly<Record<string, string>>;
  readonly missingRoot?: boolean;
  readonly oversizedRootBody?: boolean;
  readonly rootBodyMismatch?: boolean;
  readonly rootReference?: string;
  readonly secondBlobRedirect?: boolean;
  readonly platform?: ManagedImagePlatform;
};

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function bodyDigest(body: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function jsonResponse(body: Buffer, digestHeader?: `sha256:${string}`): Response {
  return new Response(body, {
    headers: {
      "content-type": "application/json",
      ...(digestHeader === undefined ? {} : { "docker-content-digest": digestHeader }),
    },
  });
}

function registryFixture(agent: ShippedManagedImageAgent, options: RegistryFixtureOptions = {}) {
  const oversizedRootStream = {
    cancelled: false,
    contentLength: null as string | null,
    pulls: 0,
  };
  const oversizedRootResponse = (): Response => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          oversizedRootStream.cancelled = true;
        },
        pull(controller) {
          oversizedRootStream.pulls += 1;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
        },
      }),
      { headers: { "docker-content-digest": rootDigest } },
    );
    oversizedRootStream.contentLength = response.headers.get("content-length");
    return response;
  };
  const platform = options.platform ?? TEST_PLATFORM;
  const architecture = platform.slice("linux/".length);
  const repository = MANAGED_IMAGE_REPOSITORIES[agent].replace(/^ghcr\.io\//u, "");
  const labels = {
    "io.nvidia.nemoclaw.agent": agent,
    "io.nvidia.nemoclaw.managed-image.contract": String(MANAGED_IMAGE_CONTRACT_VERSION),
    "io.nvidia.nemoclaw.managed-image.platform": platform,
    "io.nvidia.nemoclaw.managed-image.startup-profile": String(
      MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    ),
    "io.nvidia.nemoclaw.managed-image.capabilities": String(
      MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    ),
    "org.opencontainers.image.source": `https://github.com/${MANAGED_IMAGE_SOURCE_REPOSITORY}`,
    "org.opencontainers.image.revision": REVISION,
    "org.opencontainers.image.version": RELEASE,
    "io.nvidia.nemoclaw.managed-image.cohort": COHORT,
    ...options.labels,
  };
  const imageConfig = {
    architecture,
    os: "linux",
    config: { Labels: labels },
  };
  const configBody = jsonBody(imageConfig);
  const configDigest = bodyDigest(configBody);
  const imageManifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: configBody.length,
    },
    layers: [],
  };
  const imageManifestBody = jsonBody(imageManifest);
  const platformDigest = bodyDigest(imageManifestBody);
  const rootDocument = options.directManifest
    ? imageManifest
    : {
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [
          {
            mediaType: OCI_MANIFEST,
            digest: platformDigest,
            size: imageManifestBody.length,
            platform: { architecture, os: "linux" },
          },
          ...(options.duplicatePlatform
            ? [
                {
                  mediaType: OCI_MANIFEST,
                  digest: digest("f"),
                  size: 1024,
                  platform: { architecture, os: "linux" },
                },
              ]
            : []),
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: digest("e"),
            size: 1024,
            platform: { architecture: "unknown", os: "unknown" },
          },
        ],
      };
  const rootBody = options.directManifest ? imageManifestBody : jsonBody(rootDocument);
  const rootDigest = bodyDigest(rootBody);
  const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    const manifestPrefix = `/v2/${repository}/manifests/`;
    const rootReference = options.rootReference ?? RELEASE;
    switch (true) {
      case url.pathname === "/token":
        expect(url.searchParams.get("service")).toBe("ghcr.io");
        expect(url.searchParams.get("scope")).toBe(`repository:${repository}:pull`);
        return Response.json({ token: "anonymous-registry-token" });
      case url.pathname === `${manifestPrefix}${rootReference}` && !authorization:
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${repository}:pull"`,
          },
        });
      case url.pathname === `${manifestPrefix}${rootReference}` && Boolean(authorization): {
        const deliveredRootBody = options.rootBodyMismatch
          ? Buffer.concat([rootBody, Buffer.from(" ", "utf8")])
          : rootBody;
        return options.missingRoot === true
          ? new Response("not found", { status: 404 })
          : options.oversizedRootBody === true
            ? oversizedRootResponse()
            : jsonResponse(deliveredRootBody, rootDigest);
      }
      case url.pathname === `${manifestPrefix}${platformDigest}` && Boolean(authorization):
        return jsonResponse(imageManifestBody, platformDigest);
      case url.pathname === `/v2/${repository}/blobs/${configDigest}` && Boolean(authorization): {
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: options.blobRedirectStatus ?? 307,
          headers: {
            location:
              options.blobRedirectLocation ??
              `https://pkg-containers.githubusercontent.com/ghcrblobs13/blobs/${configDigest}?sig=fixture`,
          },
        });
      }
      case url.origin === "https://pkg-containers.githubusercontent.com" &&
        url.pathname === `/ghcrblobs13/blobs/${configDigest}`:
        expect(authorization).toBeNull();
        expect(init?.redirect).toBe("manual");
        return options.secondBlobRedirect === true
          ? new Response(null, {
              status: 307,
              headers: {
                location: `https://pkg-containers.githubusercontent.com/ghcrblobs14/blobs/${configDigest}?sig=second`,
              },
            })
          : jsonResponse(
              options.configBodyMismatch
                ? Buffer.concat([configBody, Buffer.from(" ", "utf8")])
                : configBody,
            );
      default:
        return new Response("not found", { status: 404 });
    }
  });
  const fetchImpl = fetchMock as unknown as typeof fetch;

  return {
    configDigest,
    fetchImpl,
    fetchMock,
    oversizedRootStream,
    platform,
    platformDigest,
    rootDigest,
  };
}

function catalogFixture(
  options: Partial<Record<ShippedManagedImageAgent, RegistryFixtureOptions>> = {},
) {
  const fixtures = Object.fromEntries(
    SHIPPED_MANAGED_IMAGE_AGENTS.map((agent) => [
      agent,
      registryFixture(agent, {
        rootReference: agent === "openclaw" ? RELEASE : `cohort-${COHORT}`,
        ...options[agent],
      }),
    ]),
  ) as Record<ShippedManagedImageAgent, ReturnType<typeof registryFixture>>;
  const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const scope = url.searchParams.get("scope") ?? "";
    const agent = SHIPPED_MANAGED_IMAGE_AGENTS.find((candidate) =>
      [url.pathname, scope].some(
        (value) =>
          value.includes(MANAGED_IMAGE_REPOSITORIES[candidate].replace("ghcr.io/", "")) ||
          value.includes(fixtures[candidate].configDigest),
      ),
    );
    return agent
      ? fixtures[agent].fetchImpl(input, init)
      : new Response("not found", { status: 404 });
  });
  const fetchImpl = fetchMock as unknown as typeof fetch;

  return { fetchImpl, fetchMock, fixtures };
}

describe("managed image GHCR catalog", () => {
  it("resolves the OpenClaw release pointer to an exact validated identity (#7744)", async () => {
    const fixture = registryFixture("openclaw");

    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).resolves.toEqual({
      contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
      agent: "openclaw",
      platform: TEST_PLATFORM,
      image: MANAGED_IMAGE_REPOSITORIES.openclaw,
      digest: fixture.platformDigest,
      reference: `${MANAGED_IMAGE_REPOSITORIES.openclaw}@${fixture.platformDigest}`,
      source: {
        repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
        revision: REVISION,
        release: RELEASE,
        cohort: COHORT,
      },
      startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
      capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    });
  });

  it("classifies a registry transport failure as unavailable (#7744)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ManagedImageCatalogUnavailableError);
  });

  it.each(MANAGED_IMAGE_PLATFORMS)(
    "selects and validates the exact %s child manifest",
    async (platform) => {
      const fixture = registryFixture("openclaw", { platform });

      await expect(
        resolveManagedImageContractFromGhcr({
          agent: "openclaw",
          release: RELEASE,
          platform,
          fetchImpl: fixture.fetchImpl,
        }),
      ).resolves.toMatchObject({
        platform,
        digest: fixture.platformDigest,
        reference: `${MANAGED_IMAGE_REPOSITORIES.openclaw}@${fixture.platformDigest}`,
      });
    },
  );

  it("rejects wrong manifest bytes even when the registry advertises the expected digest", async () => {
    const fixture = registryFixture("openclaw", { rootBodyMismatch: true });

    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(/GHCR manifest bytes do not match digest/);
  });

  it("rejects an oversized chunked manifest before parsing it or exceeding the response limit", async () => {
    const fixture = registryFixture("openclaw", { oversizedRootBody: true });

    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(/GHCR manifest exceeds the registry response limit/);
    expect(fixture.oversizedRootStream).toMatchObject({
      cancelled: true,
      contentLength: null,
    });
    expect(fixture.oversizedRootStream.pulls).toBeGreaterThanOrEqual(3);
    expect(fixture.oversizedRootStream.pulls).toBeLessThan(5);
  });

  it("rejects image-config bytes that do not match the manifest descriptor digest", async () => {
    const fixture = registryFixture("openclaw", { configBodyMismatch: true });

    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(/GHCR image config bytes do not match digest/);
  });

  it.each(["hermes", "langchain-deepagents-code"] as const)(
    "refuses independent %s release-alias discovery",
    async (agent) => {
      const fetchImpl = vi.fn();
      await expect(
        resolveManagedImageContractFromGhcr({
          agent,
          release: RELEASE,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).rejects.toThrow(/only be resolved from the OpenClaw cohort pointer/);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(["hermes", "langchain-deepagents-code"] as const)(
    "resolves the complete three-agent catalog rather than an OpenClaw-only default [%s] (#7744)",
    async (agent) => {
      const fixture = catalogFixture();

      const catalog = await resolveManagedImageCatalogFromGhcr({
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      });

      expect(Object.keys(catalog).sort()).toEqual([...SHIPPED_MANAGED_IMAGE_AGENTS].sort());
      expect(
        SHIPPED_MANAGED_IMAGE_AGENTS.map(
          (agent) => (catalog[agent] as { source: { cohort: string } }).source.cohort,
        ),
      ).toEqual([COHORT, COHORT, COHORT]);
      const rootManifestRequests = fixture.fetchMock.mock.calls
        .map(([input]) => new URL(String(input)).pathname)
        .filter((pathname) => pathname.includes("/manifests/"));
      expect(rootManifestRequests.filter((pathname) => pathname.endsWith(`/${RELEASE}`))).toEqual([
        `/v2/nvidia/nemoclaw/openclaw-sandbox/manifests/${RELEASE}`,
        `/v2/nvidia/nemoclaw/openclaw-sandbox/manifests/${RELEASE}`,
      ]);

      const repository = MANAGED_IMAGE_REPOSITORIES[agent].replace("ghcr.io/", "");
      expect(rootManifestRequests).toContain(`/v2/${repository}/manifests/cohort-${COHORT}`);
      expect(rootManifestRequests).not.toContain(`/v2/${repository}/manifests/${RELEASE}`);
    },
  );

  it("resolves an immutable qualification revision as one exact cohort (#9385)", async () => {
    const fixture = catalogFixture({ openclaw: { rootReference: REVISION } });

    const catalog = await resolveManagedImageCatalogFromGhcr({
      release: RELEASE,
      revision: REVISION,
      fetchImpl: fixture.fetchImpl,
    });

    expect(
      SHIPPED_MANAGED_IMAGE_AGENTS.map(
        (agent) =>
          (catalog[agent] as { source: { cohort: string; release: string; revision: string } })
            .source,
      ),
    ).toEqual(
      SHIPPED_MANAGED_IMAGE_AGENTS.map(() => ({
        cohort: COHORT,
        release: RELEASE,
        repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
        revision: REVISION,
      })),
    );
    const rootManifestRequests = fixture.fetchMock.mock.calls
      .map(([input]) => new URL(String(input)).pathname)
      .filter((pathname) => pathname.includes("/manifests/"));
    expect(rootManifestRequests).toContain(
      `/v2/nvidia/nemoclaw/openclaw-sandbox/manifests/${REVISION}`,
    );
    expect(rootManifestRequests).not.toContain(
      `/v2/nvidia/nemoclaw/openclaw-sandbox/manifests/${RELEASE}`,
    );
  });

  it("rejects a malformed qualification revision before registry access (#9385)", async () => {
    const fetchImpl = vi.fn();

    await expect(
      resolveManagedImageCatalogFromGhcr({
        release: RELEASE,
        revision: "main",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/managed image revision 'main' is not a full lowercase SHA/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an image that does not match the qualification revision (#9385)", async () => {
    const requestedRevision = "c".repeat(40);
    const fixture = catalogFixture({ openclaw: { rootReference: requestedRevision } });

    await expect(
      resolveManagedImageCatalogFromGhcr({
        release: RELEASE,
        revision: requestedRevision,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(/source revision does not match the expected revision/);
  });

  it("discovers the immutable release from a qualification revision", async () => {
    const publishedRelease = "v0.0.96";
    const fixture = catalogFixture({
      openclaw: {
        rootReference: REVISION,
        labels: { "org.opencontainers.image.version": publishedRelease },
      },
      hermes: { labels: { "org.opencontainers.image.version": publishedRelease } },
      "langchain-deepagents-code": {
        labels: { "org.opencontainers.image.version": publishedRelease },
      },
    });

    const catalog = await resolveManagedImageCatalogFromGhcr({
      release: RELEASE,
      revision: REVISION,
      fetchImpl: fixture.fetchImpl,
    });

    expect(
      SHIPPED_MANAGED_IMAGE_AGENTS.map(
        (agent) => (catalog[agent] as { source: { release: string } }).source.release,
      ),
    ).toEqual(SHIPPED_MANAGED_IMAGE_AGENTS.map(() => publishedRelease));
  });

  it("uses the requested release for a revision-pinned legacy latest label", async () => {
    const fixture = catalogFixture({
      openclaw: {
        rootReference: REVISION,
        labels: { "org.opencontainers.image.version": "latest" },
      },
      hermes: { labels: { "org.opencontainers.image.version": "latest" } },
      "langchain-deepagents-code": {
        labels: { "org.opencontainers.image.version": "latest" },
      },
    });

    const catalog = await resolveManagedImageCatalogFromGhcr({
      release: RELEASE,
      revision: REVISION,
      fetchImpl: fixture.fetchImpl,
    });

    expect(
      SHIPPED_MANAGED_IMAGE_AGENTS.map(
        (agent) => (catalog[agent] as { source: { release: string } }).source.release,
      ),
    ).toEqual(SHIPPED_MANAGED_IMAGE_AGENTS.map(() => RELEASE));
  });

  it.each(["", "0.0.97", "latest"])(
    "rejects malformed image release label %j",
    async (release) => {
      const fixture = registryFixture("openclaw", {
        labels: { "org.opencontainers.image.version": release },
      });

      await expect(
        resolveManagedImageContractFromGhcr({
          agent: "openclaw",
          release: RELEASE,
          fetchImpl: fixture.fetchImpl,
        }),
      ).rejects.toThrow(/image release is not a supported release version/);
    },
  );

  it("fails closed when a dependent cohort alias is torn or absent", async () => {
    const fixture = catalogFixture({ hermes: { missingRoot: true } });

    const resolution = resolveManagedImageCatalogFromGhcr({
      release: RELEASE,
      fetchImpl: fixture.fetchImpl,
    });
    await expect(resolution).rejects.toBeInstanceOf(ManagedImageCatalogUnavailableError);
    await expect(resolution).rejects.toThrow(/GHCR manifest request returned HTTP 404/);

    const hermesRepository = MANAGED_IMAGE_REPOSITORIES.hermes.replace("ghcr.io/", "");
    const hermesManifestRequests = fixture.fetchMock.mock.calls
      .map(([input]) => new URL(String(input)).pathname)
      .filter((pathname) => pathname.startsWith(`/v2/${hermesRepository}/manifests/`));
    expect(hermesManifestRequests).toEqual([
      `/v2/${hermesRepository}/manifests/cohort-${COHORT}`,
      `/v2/${hermesRepository}/manifests/cohort-${COHORT}`,
    ]);
  });

  it("prioritizes cohort integrity failure over concurrent unavailability (#7744)", async () => {
    const fixture = catalogFixture({
      hermes: { missingRoot: true },
      "langchain-deepagents-code": {
        labels: { "io.nvidia.nemoclaw.managed-image.contract": "2" },
      },
    });

    const error = await resolveManagedImageCatalogFromGhcr({
      release: RELEASE,
      fetchImpl: fixture.fetchImpl,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ManagedImageCatalogError);
    expect(error).not.toBeInstanceOf(ManagedImageCatalogUnavailableError);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining(
        "'langchain-deepagents-code' image label io.nvidia.nemoclaw.managed-image.contract does not match",
      ),
    );
  });

  it("rejects a dependent image whose label does not match the OpenClaw cohort", async () => {
    const fixture = catalogFixture({
      hermes: {
        labels: { "io.nvidia.nemoclaw.managed-image.cohort": "ghrun-99999-2" },
      },
    });

    await expect(
      resolveManagedImageCatalogFromGhcr({
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(/publication cohort does not match the OpenClaw cohort/);
  });

  it("rejects a dependent image whose revision does not match the OpenClaw pointer", async () => {
    const fixture = catalogFixture({
      "langchain-deepagents-code": {
        labels: {
          "org.opencontainers.image.revision": "f".repeat(40),
        },
      },
    });

    await expect(
      resolveManagedImageCatalogFromGhcr({
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(/source revision does not match the expected revision/);
  });

  it.each([
    "ghrun-0-1",
    "ghrun-1-0",
    "ghrun-01-1",
    "run-1-1",
    `ghrun-${"1".repeat(21)}-1`,
    `ghrun-1-${"1".repeat(11)}`,
  ])(
    "rejects malformed OpenClaw publication cohort %j before dependent resolution",
    async (cohort) => {
      const fixture = registryFixture("openclaw", {
        labels: { "io.nvidia.nemoclaw.managed-image.cohort": cohort },
      });

      await expect(
        resolveManagedImageCatalogFromGhcr({
          release: RELEASE,
          fetchImpl: fixture.fetchImpl,
        }),
      ).rejects.toThrow(/publication cohort is not a supported identity/);
    },
  );

  it("accepts an OCI image manifest without requiring an index", async () => {
    const fixture = registryFixture("openclaw", { directManifest: true });

    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).resolves.toMatchObject({ digest: fixture.rootDigest });
  });

  it("pins the validated host-platform child manifest rather than its mutable platform index", async () => {
    const fixture = registryFixture("openclaw");

    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).resolves.toMatchObject({
      digest: fixture.platformDigest,
      reference: `${MANAGED_IMAGE_REPOSITORIES.openclaw}@${fixture.platformDigest}`,
    });
  });

  it("rejects a GHCR blob redirect outside the exact GitHub container origin", async () => {
    const fixture = registryFixture("openclaw", {
      blobRedirectLocation: `https://example.com/ghcrblobs13/blobs/${digest("7")}?sig=fixture`,
    });

    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(/unexpected redirect target/);
  });

  it.each([
    `https://fixture@pkg-containers.githubusercontent.com/ghcrblobs13/blobs/${digest("7")}?sig=fixture`,
    `https://pkg-containers.githubusercontent.com/ghcrblobs13/blobs/${digest("7")}?sig=fixture#fragment`,
  ])("rejects blob redirect target credentials or fragments: %s", async (location) => {
    const fixture = registryFixture("openclaw", { blobRedirectLocation: location });

    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(/unexpected redirect target/);
  });

  it("rejects a second redirect from the validated GitHub container blob target", async () => {
    const fixture = registryFixture("openclaw", { secondBlobRedirect: true });

    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(/attempted another redirect/);
  });

  it("requires the first image-config response to be exactly HTTP 307", async () => {
    const fixture = registryFixture("openclaw", {
      blobRedirectStatus: 302,
    });

    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(/returned HTTP 302, expected 307/);
  });

  it.each(["latest", "main", "v0.0.97@sha256:abc", "0"])(
    "rejects mutable or malformed release selector %j before network access",
    async (release) => {
      const fetchImpl = vi.fn();
      await expect(
        resolveManagedImageContractFromGhcr({
          agent: "openclaw",
          release,
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).rejects.toThrow(/not a supported release version/);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("normalizes an installed version to the corresponding immutable release alias", () => {
    expect(normalizeManagedImageRelease("0.0.97")).toBe(RELEASE);
  });

  it("fails closed when an index has multiple host-platform workload manifests", async () => {
    const fixture = registryFixture("openclaw", { duplicatePlatform: true });
    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(new RegExp(`contains 2 ${TEST_PLATFORM.replace("/", "\\/")}`));
  });

  it("fails closed before network access on an unsupported host architecture", async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        nodeArchitecture: "s390x",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/host architecture 's390x' has no managed-image platform/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the image does not advertise startup-profile v1", async () => {
    const fixture = registryFixture("openclaw", {
      labels: { "io.nvidia.nemoclaw.managed-image.startup-profile": "2" },
    });
    await expect(
      resolveManagedImageContractFromGhcr({
        agent: "openclaw",
        release: RELEASE,
        fetchImpl: fixture.fetchImpl,
      }),
    ).rejects.toThrow(/startup-profile does not match/);
  });
});
