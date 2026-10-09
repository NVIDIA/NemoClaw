// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateReleasePinLayout } from "../../scripts/checks/extract-installer-pins.mts";
import {
  V00116_BREV_ASSETS,
  V00116_INSTALLER_ASSETS,
  v00116Pins,
  withSandboxAbi,
} from "../helpers/openshell-release-fixtures";

describe("OpenShell release pin layouts", () => {
  it.each([
    ["installer", V00116_INSTALLER_ASSETS],
    ["Brev launchable", V00116_BREV_ASSETS],
  ] as const)(
    "accepts every asset in the prospective v0.0.116 %s pin layout (#10790)",
    (consumer, expectedAssets) => {
      const validatedAssets = validateReleasePinLayout(
        v00116Pins(consumer),
        "0.0.116",
        consumer,
        consumer,
      ).map(({ asset }) => asset);

      expect(validatedAssets.sort()).toEqual([...expectedAssets].sort());
    },
  );

  it.each([
    ...V00116_INSTALLER_ASSETS.map((asset) => ["installer", asset] as const),
    ...V00116_BREV_ASSETS.map((asset) => ["Brev launchable", asset] as const),
  ])("rejects a prospective v0.0.116 %s layout missing %s (#10790)", (consumer, asset) => {
    const pins = v00116Pins(consumer).filter((pin) => pin.asset !== asset);

    expect(() => validateReleasePinLayout(pins, "0.0.116", consumer, consumer)).toThrow(
      `missing=[${asset}]`,
    );
  });

  it.each([
    [
      "missing prospective v0.0.116 manifest pin",
      v00116Pins("installer").filter(
        ({ asset }) => asset !== "openshell-sandbox-checksums-sha256.txt",
      ),
      "missing=[openshell-sandbox-checksums-sha256.txt]",
    ],
    [
      "changed prospective v0.0.116 manifest pin",
      v00116Pins("installer").map((pin) =>
        pin.asset === "openshell-checksums-sha256.txt" ? { ...pin, sha256: "0".repeat(64) } : pin,
      ),
      "manifest openshell-checksums-sha256.txt must match the base-trusted v0.0.116 manifest digest",
    ],
  ] as const)("rejects a %s (#10790)", (_case, pins, diagnostic) => {
    expect(() =>
      validateReleasePinLayout(pins, "0.0.116", "installer", "prospective pins"),
    ).toThrow(diagnostic);
  });

  it("rejects sandbox ABI layouts cross-wired between v0.0.106 and v0.0.116 (#10790)", () => {
    const v00106Pins = V00116_INSTALLER_ASSETS.map((asset) => ({
      asset: asset.replace(/(openshell-sandbox-(?:x86_64|aarch64)-unknown-linux-)musl/u, "$1gnu"),
      releaseVersion: "0.0.106",
      sha256: "0".repeat(64),
      source: "installer",
    }));
    const rejectLayout = (pins: typeof v00106Pins, version: string, expected: string) =>
      expect(() => validateReleasePinLayout(pins, version, "installer", version)).toThrow(expected);

    rejectLayout(withSandboxAbi(v00106Pins, "musl"), "0.0.106", "linux-gnu.tar.gz");
    rejectLayout(withSandboxAbi(v00116Pins("installer"), "gnu"), "0.0.116", "linux-musl.tar.gz");
  });

  it("requires a trust record before validating a candidate pin layout (#10790)", () => {
    expect(() =>
      validateReleasePinLayout([], "9.9.8", "installer", "untrusted installer pin table"),
    ).toThrow("OpenShell v9.9.8 is not in the base-trusted release records");
  });
});
