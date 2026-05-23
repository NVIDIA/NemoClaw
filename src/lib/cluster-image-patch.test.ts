// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildPatchDockerfile,
  ClusterImagePatchError,
  computePatchedTag,
  ensurePatchedClusterImage,
  extractUpstreamVersion,
} from "../../dist/lib/cluster-image-patch";

const UPSTREAM = "ghcr.io/nvidia/openshell/cluster:0.0.36";

describe("buildPatchDockerfile", () => {
  it("uses a multi-stage ubuntu:24.04 builder to install fuse-overlayfs from apt", () => {
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    expect(dockerfile).toContain("FROM ubuntu:24.04@sha256:");
    expect(dockerfile).toContain("AS bin-fetcher");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends fuse-overlayfs");
    expect(dockerfile).toContain(
      "COPY --from=bin-fetcher /export/fuse-overlayfs /usr/local/bin/fuse-overlayfs",
    );
    expect(dockerfile).toContain(
      "COPY --from=bin-fetcher /export/lib/libfuse3.so.3 /usr/local/lib/libfuse3.so.3",
    );
    expect(dockerfile).toContain('CMD ["server", "--snapshotter=fuse-overlayfs"]');
  });

  it("pins the ubuntu builder base by digest so the Dockerfile-text-derived tag stays content-stable", () => {
    // The patched-image tag is a SHA over the Dockerfile text. If the
    // builder base were a floating tag like `ubuntu:24.04`, the same
    // NemoClaw tag could produce different image bytes whenever Ubuntu
    // publishes a security update — breaking the (text → bytes) contract.
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    expect(dockerfile).toMatch(/FROM ubuntu:24\.04@sha256:[0-9a-f]{64} AS bin-fetcher/);
  });

  it("does not link to a third-party code repository in the Dockerfile", () => {
    // Repo policy (CONTRIBUTING.md "No External Project Links") prohibits
    // pointing at third-party GitHub repos in source. The previous static-
    // binary approach pulled from `containers/fuse-overlayfs` releases —
    // this assertion guards against regressing back to that.
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    expect(dockerfile).not.toContain("github.com");
  });

  it("does not RUN apt-get or curl in the final cluster stage", () => {
    // The upstream cluster image's base ships BusyBox tar (so dpkg-deb
    // cannot extract .debs) AND does not ship curl (RUN curl exits 127).
    // The fix is structural: install in a clean ubuntu:24.04 builder,
    // COPY --from into the cluster stage.
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    const finalStage = dockerfile.split(/^FROM \$\{UPSTREAM\}/m)[1] ?? "";
    expect(finalStage).not.toMatch(/RUN[^\n]*apt-get/);
    expect(finalStage).not.toMatch(/RUN[^\n]*curl/);
  });

  it("threads through the native snapshotter without installing fuse-overlayfs", () => {
    // K3s `native` snapshotter does not need the userspace fuse helper.
    // Anyone selecting it (NEMOCLAW_OVERLAY_SNAPSHOTTER=native) should get
    // a minimal patch image that only overrides CMD.
    const dockerfile = buildPatchDockerfile("native");
    expect(dockerfile).toContain('CMD ["server", "--snapshotter=native"]');
    expect(dockerfile).not.toContain("fuse-overlayfs");
    expect(dockerfile).not.toContain("apt-get");
    expect(dockerfile).not.toContain("ubuntu:24.04");
  });
});

describe("extractUpstreamVersion", () => {
  it("extracts the tag portion from a registry-qualified image reference", () => {
    expect(extractUpstreamVersion("ghcr.io/nvidia/openshell/cluster:0.0.36")).toBe("0.0.36");
  });

  it("strips an appended digest", () => {
    expect(
      extractUpstreamVersion(
        "ghcr.io/nvidia/openshell/cluster:0.0.36@sha256:abc123def456",
      ),
    ).toBe("0.0.36");
  });

  it("falls back to 'unknown' for an untagged reference", () => {
    expect(extractUpstreamVersion("ghcr.io/nvidia/openshell/cluster")).toBe("unknown");
  });

  it("does not mistake a registry port for a tag", () => {
    // `registry.example.com:5000/openshell/cluster` is a registry on port 5000
    // with no explicit tag; a naive split-on-':' parser would return "5000/openshell/cluster".
    expect(extractUpstreamVersion("registry.example.com:5000/openshell/cluster")).toBe("unknown");
  });

  it("extracts the tag when both a registry port and a tag are present", () => {
    expect(extractUpstreamVersion("registry.example.com:5000/openshell/cluster:0.0.36")).toBe(
      "0.0.36",
    );
  });

  it("falls back to 'unknown' when the tag separator has no value after it", () => {
    expect(extractUpstreamVersion("ghcr.io/nvidia/openshell/cluster:")).toBe("unknown");
  });
});

describe("computePatchedTag", () => {
  it("is deterministic for matching inputs", () => {
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    const a = computePatchedTag({
      upstreamImage: UPSTREAM,
      snapshotter: "fuse-overlayfs",
      dockerfile,
    });
    const b = computePatchedTag({
      upstreamImage: UPSTREAM,
      snapshotter: "fuse-overlayfs",
      dockerfile,
    });
    expect(a).toBe(b);
    expect(a.startsWith("nemoclaw-cluster:0.0.36-fuse-overlayfs-")).toBe(true);
  });

  it("differs when the snapshotter changes", () => {
    const fuse = computePatchedTag({
      upstreamImage: UPSTREAM,
      snapshotter: "fuse-overlayfs",
      dockerfile: buildPatchDockerfile("fuse-overlayfs"),
    });
    const native = computePatchedTag({
      upstreamImage: UPSTREAM,
      snapshotter: "native",
      dockerfile: buildPatchDockerfile("native"),
    });
    expect(fuse).not.toBe(native);
  });

  it("differs when the upstream image version changes", () => {
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    const a = computePatchedTag({
      upstreamImage: "ghcr.io/nvidia/openshell/cluster:0.0.36",
      snapshotter: "fuse-overlayfs",
      dockerfile,
    });
    const b = computePatchedTag({
      upstreamImage: "ghcr.io/nvidia/openshell/cluster:0.0.37",
      snapshotter: "fuse-overlayfs",
      dockerfile,
    });
    expect(a).not.toBe(b);
  });

  it("differs when only the upstream digest changes (cache invalidates on registry re-push)", () => {
    // Even with identical Dockerfile text and tag string, a different
    // upstream content digest must produce a different patched tag —
    // otherwise a registry re-push of the same tag would silently keep
    // serving stale layers from the local cache.
    const dockerfile = buildPatchDockerfile("fuse-overlayfs");
    const tagA = computePatchedTag({
      upstreamImage: UPSTREAM,
      snapshotter: "fuse-overlayfs",
      dockerfile,
      upstreamDigest: "sha256:aaaa1111",
    });
    const tagB = computePatchedTag({
      upstreamImage: UPSTREAM,
      snapshotter: "fuse-overlayfs",
      dockerfile,
      upstreamDigest: "sha256:bbbb2222",
    });
    expect(tagA).not.toBe(tagB);
  });
});

interface MockFs {
  mkdtempSync: (prefix: string) => string;
  writeFileSync: (filePath: string, data: string, encoding: BufferEncoding) => void;
  rmSync: (filePath: string, opts?: { recursive?: boolean; force?: boolean }) => void;
  written: Map<string, string>;
}

function createMockFs(): MockFs {
  const written = new Map<string, string>();
  return {
    mkdtempSync: (prefix: string) => `${prefix}mock`,
    writeFileSync: (filePath: string, data: string, _encoding: BufferEncoding) => {
      written.set(filePath, String(data));
    },
    rmSync: (_filePath: string) => {
      // no-op
    },
    written,
  };
}

describe("ensurePatchedClusterImage", () => {
  // Helpers for runCaptureImpl mocks. The implementation calls
  // `docker image inspect --format '{{.Id}}' <ref>` twice in the typical
  // flow: once to learn the upstream digest, once to check if the
  // patched tag is cached. Tests differentiate by the ref argument.
  function inspectAt(cmd: readonly string[]): "upstream" | "tag" | "other" {
    if (cmd[0] !== "docker" || cmd[1] !== "image" || cmd[2] !== "inspect") return "other";
    const ref = cmd[5];
    if (ref === UPSTREAM) return "upstream";
    if (typeof ref === "string" && ref.startsWith("nemoclaw-cluster:")) return "tag";
    return "other";
  }

  it("uses the locally-cached upstream digest and skips the network entirely on full cache hit", () => {
    const captureCalls: string[][] = [];
    const runCalls: string[][] = [];
    const tag = ensurePatchedClusterImage({
      upstreamImage: UPSTREAM,
      runCaptureImpl: (cmd) => {
        captureCalls.push([...cmd]);
        // Both upstream and patched tag are present locally.
        return "sha256:abcd1234";
      },
      runImpl: (cmd) => {
        runCalls.push([...cmd]);
        return { status: 0 };
      },
      logger: () => {},
      fsImpl: createMockFs(),
      tmpdirImpl: () => "/tmp",
    });

    expect(tag.startsWith("nemoclaw-cluster:0.0.36-fuse-overlayfs-")).toBe(true);
    // No pull, no manifest probe, no build — pure local-cache resolution.
    expect(runCalls).toHaveLength(0);
    // Two inspects: one for upstream, one for the patched tag.
    expect(captureCalls.filter((c) => inspectAt(c) === "upstream")).toHaveLength(1);
    expect(captureCalls.filter((c) => inspectAt(c) === "tag")).toHaveLength(1);
  });

  it("probes registry reachability, pulls upstream, then builds on full cache miss", () => {
    const fsImpl = createMockFs();
    const runCalls: string[][] = [];
    let upstreamInspectCount = 0;

    const tag = ensurePatchedClusterImage({
      upstreamImage: UPSTREAM,
      runCaptureImpl: (cmd) => {
        if (inspectAt(cmd) === "upstream") {
          upstreamInspectCount += 1;
          // First call: not cached. After-pull call: digest is now there.
          return upstreamInspectCount === 1 ? "" : "sha256:9999aaaa";
        }
        // Patched tag never exists locally → cache miss → build.
        return "";
      },
      runImpl: (cmd) => {
        runCalls.push([...cmd]);
        return { status: 0 };
      },
      logger: () => {},
      fsImpl,
      tmpdirImpl: () => "/tmp",
    });

    expect(tag.startsWith("nemoclaw-cluster:0.0.36-fuse-overlayfs-")).toBe(true);
    // Reachability probe must precede the pull so air-gapped hosts fail fast.
    expect(runCalls[0]).toEqual(["docker", "manifest", "inspect", UPSTREAM]);
    expect(runCalls[1]).toEqual(["docker", "pull", UPSTREAM]);
    const buildCall = runCalls.find((entry) => entry[0] === "docker" && entry[1] === "build");
    expect(buildCall).toBeDefined();
    expect(buildCall).toContain("--build-arg");
    expect(buildCall).toContain(`UPSTREAM=${UPSTREAM}`);
    expect(buildCall).toContain("-t");
    expect(buildCall).toContain(tag);

    const [dockerfilePath] = Array.from(fsImpl.written.keys());
    expect(dockerfilePath).toBeDefined();
    expect(fsImpl.written.get(dockerfilePath)).toContain(
      'CMD ["server", "--snapshotter=fuse-overlayfs"]',
    );
  });

  it("threads the native snapshotter through the build", () => {
    const fsImpl = createMockFs();
    let upstreamInspectCount = 0;
    ensurePatchedClusterImage({
      upstreamImage: UPSTREAM,
      snapshotter: "native",
      runCaptureImpl: (cmd) => {
        if (inspectAt(cmd) === "upstream") {
          upstreamInspectCount += 1;
          return upstreamInspectCount === 1 ? "" : "sha256:beef";
        }
        return "";
      },
      runImpl: () => ({ status: 0 }),
      logger: () => {},
      fsImpl,
      tmpdirImpl: () => "/tmp",
    });
    const [dockerfilePath] = Array.from(fsImpl.written.keys());
    expect(fsImpl.written.get(dockerfilePath)).toContain(
      'CMD ["server", "--snapshotter=native"]',
    );
    expect(fsImpl.written.get(dockerfilePath)).not.toContain('"--snapshotter=fuse-overlayfs"');
  });

  it("fails fast with a documented error when upstream is unreachable on a cache miss", () => {
    // Air-gapped / restricted-network case: no local upstream image AND
    // the manifest probe times out / fails. This must surface in seconds,
    // not 10 minutes, and the message must point at the troubleshooting docs.
    expect(() =>
      ensurePatchedClusterImage({
        upstreamImage: UPSTREAM,
        runCaptureImpl: () => "",
        runImpl: (cmd) => {
          if (cmd[1] === "manifest") return { status: 1 };
          return { status: 0 };
        },
        logger: () => {},
        fsImpl: createMockFs(),
        tmpdirImpl: () => "/tmp",
      }),
    ).toThrow(/cannot reach upstream registry/);
  });

  it("throws ClusterImagePatchError on docker pull failure", () => {
    expect(() =>
      ensurePatchedClusterImage({
        upstreamImage: UPSTREAM,
        runCaptureImpl: () => "",
        runImpl: (cmd) => (cmd[1] === "pull" ? { status: 1 } : { status: 0 }),
        logger: () => {},
        fsImpl: createMockFs(),
        tmpdirImpl: () => "/tmp",
      }),
    ).toThrow(ClusterImagePatchError);
  });

  it("suppresses raw docker manifest/build output so onboard does not leak internal noise (#3248)", () => {
    // The manifest probe dumps a multi-line JSON manifest list, and `docker build`
    // dumps its full BuildKit log (apt-get, layer hashes, debconf warnings) to
    // the user's terminal. Both must be suppressed so the install transcript
    // stays clean. The caller already prints its own "Pulling …"/"Building …"
    // progress lines.
    const fsImpl = createMockFs();
    const runCalls: { cmd: string[]; opts: { suppressOutput?: boolean } | undefined }[] = [];
    let upstreamInspectCount = 0;

    ensurePatchedClusterImage({
      upstreamImage: UPSTREAM,
      runCaptureImpl: (cmd) => {
        if (inspectAt(cmd) === "upstream") {
          upstreamInspectCount += 1;
          return upstreamInspectCount === 1 ? "" : "sha256:9999aaaa";
        }
        return "";
      },
      runImpl: (cmd, opts) => {
        runCalls.push({ cmd: [...cmd], opts });
        return { status: 0 };
      },
      logger: () => {},
      fsImpl,
      tmpdirImpl: () => "/tmp",
    });

    const manifestCall = runCalls.find((entry) => entry.cmd[1] === "manifest");
    expect(manifestCall?.opts).toMatchObject({ suppressOutput: true });

    const buildCall = runCalls.find((entry) => entry.cmd[1] === "build");
    expect(buildCall?.cmd).toContain("--quiet");
    expect(buildCall?.opts).toMatchObject({ suppressOutput: true });
  });

  it("throws ClusterImagePatchError on docker build failure", () => {
    let upstreamInspectCount = 0;
    expect(() =>
      ensurePatchedClusterImage({
        upstreamImage: UPSTREAM,
        runCaptureImpl: (cmd) => {
          if (inspectAt(cmd) === "upstream") {
            upstreamInspectCount += 1;
            return upstreamInspectCount === 1 ? "" : "sha256:abcd";
          }
          return "";
        },
        runImpl: (cmd) => (cmd[1] === "build" ? { status: 2 } : { status: 0 }),
        logger: () => {},
        fsImpl: createMockFs(),
        tmpdirImpl: () => "/tmp",
      }),
    ).toThrow(ClusterImagePatchError);
  });
});
