// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildCoreDnsPatchJson,
  dockerHostRuntime,
  firstNonLoopbackNameserver,
  isSafeDnsUpstream,
  resolveCoreDnsUpstream,
  selectOpenshellClusterContainer,
} from "./coredns";

describe("CoreDNS domain helpers", () => {
  it("classifies Docker host socket runtimes", () => {
    expect(dockerHostRuntime("unix:///Users/me/.colima/default/docker.sock")).toBe("colima");
    expect(dockerHostRuntime("unix:///run/user/1000/podman/podman.sock")).toBe("podman");
    expect(dockerHostRuntime("unix:///Users/me/.docker/run/docker.sock")).toBe("docker-desktop");
    expect(dockerHostRuntime("tcp://docker.example:2376")).toBe("custom");
    expect(dockerHostRuntime(undefined)).toBeNull();
  });

  it("selects the first non-loopback nameserver", () => {
    expect(firstNonLoopbackNameserver("nameserver 127.0.0.1\nnameserver 9.9.9.9\n")).toBe("9.9.9.9");
    expect(firstNonLoopbackNameserver("nameserver ::1\nnameserver localhost\nnameserver 9.9.9.9\n")).toBe(
      "9.9.9.9",
    );
    expect(firstNonLoopbackNameserver("# comment\noptions ndots:5\n")).toBeNull();
  });

  it("resolves upstreams in container, colima VM, host order", () => {
    expect(
      resolveCoreDnsUpstream({
        containerResolvConf: "nameserver 1.1.1.1",
        hostResolvConf: "nameserver 9.9.9.9",
        runtime: "colima",
      }),
    ).toBe("1.1.1.1");
    expect(
      resolveCoreDnsUpstream({
        colimaVmResolvConf: "nameserver 8.8.8.8",
        containerResolvConf: "nameserver 127.0.0.11",
        hostResolvConf: "nameserver 9.9.9.9",
        runtime: "colima",
      }),
    ).toBe("8.8.8.8");
    expect(
      resolveCoreDnsUpstream({
        containerResolvConf: "nameserver 127.0.0.11",
        hostResolvConf: "nameserver 9.9.9.9",
        runtime: "podman",
      }),
    ).toBe("9.9.9.9");
  });

  it("selects a unique OpenShell cluster container", () => {
    expect(selectOpenshellClusterContainer("nemoclaw", "openshell-cluster-alpha\nopenshell-cluster-nemoclaw")).toBe(
      "openshell-cluster-nemoclaw",
    );
    expect(selectOpenshellClusterContainer(undefined, "openshell-cluster-nemoclaw")).toBe(
      "openshell-cluster-nemoclaw",
    );
    expect(selectOpenshellClusterContainer(undefined, "a\nb")).toBeNull();
    expect(selectOpenshellClusterContainer("nemoclaw", "openshell-cluster-nemoclaw-extra")).toBeNull();
    expect(selectOpenshellClusterContainer("box", "openshell-cluster-box-a\nopenshell-cluster-box-b")).toBeNull();
  });

  it("rejects unsafe upstream strings and JSON-escapes safe patch payloads", () => {
    expect(isSafeDnsUpstream("dns.example-1:53")).toBe(true);
    expect(isSafeDnsUpstream("bad;rm -rf /")).toBe(false);
    expect(JSON.parse(buildCoreDnsPatchJson("9.9.9.9")).data.Corefile).toContain("forward . 9.9.9.9");
  });
});
