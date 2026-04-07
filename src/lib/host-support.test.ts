// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import through compiled dist output for consistent coverage attribution.
import {
  checkHostSupport,
  classifyLinuxHost,
  classifyMacosHost,
  parseOsRelease,
} from "../../dist/lib/host-support";

describe("parseOsRelease", () => {
  it("parses quoted and unquoted values", () => {
    const parsed = parseOsRelease([
      'NAME="Ubuntu"',
      "ID=ubuntu",
      'VERSION_ID="24.04"',
    ].join("\n"));

    expect(parsed).toEqual({ id: "ubuntu", versionId: "24.04" });
  });

  it("returns empty fields when ID/VERSION_ID are missing", () => {
    const parsed = parseOsRelease("NAME=Ubuntu\nPRETTY_NAME=Ubuntu Linux");
    expect(parsed).toEqual({ id: "", versionId: "" });
  });
});

describe("classifyLinuxHost", () => {
  it("marks Ubuntu 24.04 as supported", () => {
    const result = classifyLinuxHost("ubuntu", "24.04");
    expect(result.status).toBe("ok");
    expect(result.code).toBe("SUPPORTED");
  });

  it("marks Ubuntu 22.04 as supported", () => {
    const result = classifyLinuxHost("ubuntu", "22.04");
    expect(result.status).toBe("ok");
    expect(result.code).toBe("SUPPORTED");
  });

  it("marks Ubuntu 20.04 as near EOL warning", () => {
    const result = classifyLinuxHost("ubuntu", "20.04");
    expect(result.status).toBe("warning");
    expect(result.code).toBe("NEAR_EOL");
  });

  it("marks Ubuntu 18.04 as EOL error", () => {
    const result = classifyLinuxHost("ubuntu", "18.04");
    expect(result.status).toBe("error");
    expect(result.code).toBe("EOL");
  });

  it("marks unknown Linux distro as warning", () => {
    const result = classifyLinuxHost("debian", "12");
    expect(result.status).toBe("warning");
    expect(result.code).toBe("UNSUPPORTED_OS");
  });
});

describe("checkHostSupport", () => {
  it("classifies unsupported platform as error", () => {
    const result = checkHostSupport({ platform: "win32" });
    expect(result.status).toBe("error");
    expect(result.code).toBe("UNSUPPORTED_OS");
  });

  it("classifies linux from os-release data", () => {
    const result = checkHostSupport({
      platform: "linux",
      readFileSyncImpl: () => 'ID=ubuntu\nVERSION_ID="24.04"\n',
    });

    expect(result.status).toBe("ok");
    expect(result.code).toBe("SUPPORTED");
  });

  it("returns warning when /etc/os-release cannot be read", () => {
    const result = checkHostSupport({
      platform: "linux",
      readFileSyncImpl: () => {
        throw new Error("missing");
      },
    });

    expect(result.status).toBe("warning");
    expect(result.code).toBe("UNKNOWN_VERSION");
  });

  it("classifies macOS 14 as supported", () => {
    const result = checkHostSupport({
      platform: "darwin",
      getMacosVersionImpl: () => "14.5",
    });

    expect(result.status).toBe("ok");
    expect(result.code).toBe("SUPPORTED");
    expect(result.message).toContain("macOS 14");
  });

  it("returns unknown-version warning when macOS version is unavailable", () => {
    const result = checkHostSupport({
      platform: "darwin",
      getMacosVersionImpl: () => "",
    });

    expect(result.status).toBe("warning");
    expect(result.code).toBe("UNKNOWN_VERSION");
  });
});

describe("classifyMacosHost", () => {
  it("marks macOS 15 (Sequoia) as supported", () => {
    const result = classifyMacosHost("15.1");
    expect(result.status).toBe("ok");
    expect(result.code).toBe("SUPPORTED");
  });

  it("marks macOS 14 (Sonoma) as supported", () => {
    const result = classifyMacosHost("14.5");
    expect(result.status).toBe("ok");
    expect(result.code).toBe("SUPPORTED");
  });

  it("marks macOS 13 (Ventura) as supported", () => {
    const result = classifyMacosHost("13.0");
    expect(result.status).toBe("ok");
    expect(result.code).toBe("SUPPORTED");
  });

  it("marks macOS 12 (Monterey) as near EOL", () => {
    const result = classifyMacosHost("12.7");
    expect(result.status).toBe("warning");
    expect(result.code).toBe("NEAR_EOL");
  });

  it("returns unknown-version for unparseable version", () => {
    const result = classifyMacosHost("invalid");
    expect(result.status).toBe("warning");
    expect(result.code).toBe("UNKNOWN_VERSION");
  });

  it("returns unknown-version for empty string", () => {
    const result = classifyMacosHost("");
    expect(result.status).toBe("warning");
    expect(result.code).toBe("UNKNOWN_VERSION");
  });
});
