// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  firstOccupiedInferencePublish,
  lsofListenArguments,
  lsofListenerArgvCandidates,
  occupiedFromBindProbeStatus,
  occupiedInferencePublishMessage,
  parseLsofListener,
  publishedInferenceHostBindings,
} from "./podman-inference-publish-preflight";

describe("Podman inference publish preflight", () => {
  it("names a host Ollama listener and refuses reuse (#11723)", () => {
    expect(
      occupiedInferencePublishMessage({
        address: "127.0.0.1",
        port: 11434,
        process: "ollama",
        pid: 4242,
      }),
    ).toBe(
      "Port 11434 on 127.0.0.1 is already in use by ollama (PID 4242). Portable onboarding starts its own Podman Ollama and does not reuse a host Ollama process. Stop that host service, then rerun onboarding.",
    );
  });

  it("names a leftover listener and points at uninstall (#11723)", () => {
    expect(
      occupiedInferencePublishMessage({
        address: "127.0.0.1",
        port: 11434,
        process: "rootlessport",
        pid: null,
      }),
    ).toBe(
      "Port 11434 on 127.0.0.1 is already in use by rootlessport. Stop that listener or the leftover NemoClaw Podman Ollama container (uninstall or destroy the owning sandbox), then rerun onboarding.",
    );
  });

  it("names an unnamed listener without leftover-only uninstall (#11723)", () => {
    expect(
      occupiedInferencePublishMessage({
        address: "127.0.0.1",
        port: 11434,
        process: "unknown",
        pid: null,
      }),
    ).toBe(
      "Port 11434 on 127.0.0.1 is already in use by unknown. Stop a host Ollama service or leftover Portable Ollama container on that port, then rerun onboarding.",
    );
  });

  it("parses one lsof LISTEN row after the header (#11723)", () => {
    expect(
      parseLsofListener(
        [
          "COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
          "ollama  31385 ollama    4u  IPv4  75487      0t0  TCP 127.0.0.1:11434 (LISTEN)",
        ].join("\n"),
        "127.0.0.1",
        11434,
      ),
    ).toEqual({
      address: "127.0.0.1",
      port: 11434,
      process: "ollama",
      pid: 31385,
    });
  });

  it("passes lsof a single -iTCP@host:port filter (#11723)", () => {
    expect(lsofListenArguments("127.0.0.1", 11434)).toEqual([
      "-nP",
      "-iTCP@127.0.0.1:11434",
      "-sTCP:LISTEN",
    ]);
  });

  it("does not resolve lsof or sudo through PATH (#11723)", () => {
    const commands = lsofListenerArgvCandidates("127.0.0.1", 11434);
    expect(commands).toEqual([
      ["/usr/bin/lsof", "-nP", "-iTCP@127.0.0.1:11434", "-sTCP:LISTEN"],
      ["/usr/bin/sudo", "-n", "/usr/bin/lsof", "-nP", "-iTCP@127.0.0.1:11434", "-sTCP:LISTEN"],
    ]);
    expect(commands.map((argv) => argv[0])).toEqual(["/usr/bin/lsof", "/usr/bin/sudo"]);
    expect(commands.flat()).not.toContain("lsof");
    expect(commands.flat()).not.toContain("sudo");
  });

  it("inspects loopback before the portable gateway publish (#11723)", () => {
    expect(publishedInferenceHostBindings(11434, "169.254.2.2")).toEqual([
      { address: "127.0.0.1", port: 11434 },
      { address: "169.254.2.2", port: 11434 },
    ]);
    expect(
      firstOccupiedInferencePublish(
        publishedInferenceHostBindings(11434, "169.254.2.2"),
        (address, port) =>
          address === "127.0.0.1" && port === 11434
            ? { address, port, process: "ollama", pid: 7 }
            : { address, port, process: "rootlessport", pid: 9 },
      ),
    ).toEqual({ address: "127.0.0.1", port: 11434, process: "ollama", pid: 7 });
  });

  it("treats bind-probe status 2 as a preflight error, not a free port (#11723)", () => {
    expect(occupiedFromBindProbeStatus(0, "169.254.2.2", 11434)).toBe(false);
    expect(occupiedFromBindProbeStatus(1, "169.254.2.2", 11434)).toBe(true);
    expect(() => occupiedFromBindProbeStatus(2, "169.254.2.2", 11434)).toThrow(
      "Cannot bind the inference publish target 169.254.2.2:11434.",
    );
    expect(() => occupiedFromBindProbeStatus(null, "169.254.2.2", 11434)).toThrow(
      "Cannot bind the inference publish target 169.254.2.2:11434.",
    );
  });

  it("reports a portable gateway occupant when loopback is free (#11723)", () => {
    expect(
      firstOccupiedInferencePublish(
        publishedInferenceHostBindings(11434, "169.254.2.2"),
        (address, port) =>
          address === "169.254.2.2" && port === 11434
            ? { address, port, process: "unknown", pid: null }
            : null,
      ),
    ).toEqual({ address: "169.254.2.2", port: 11434, process: "unknown", pid: null });
  });
});
