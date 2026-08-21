// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ServiceFileIdentityOptions,
  ServiceFileInspection,
} from "../gateway/service-file-identity";

const NEMOCLAW_GATEWAY_UNIT_TEMPLATE = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../../scripts/lib/openshell-gateway.service.in"),
  "utf-8",
);

export function nemoclawGatewaySystemdUnitFixture(gatewayBinary: string): string {
  return NEMOCLAW_GATEWAY_UNIT_TEMPLATE.replaceAll("@OPENSHELL_GATEWAY_BIN@", gatewayBinary);
}

export function createGatewayServiceFileContentsFixture(
  gatewayBinary: string,
  homebrewPlist: string,
): (filePath: string) => string {
  return (filePath) =>
    filePath.endsWith("homebrew.mxcl.openshell.plist")
      ? homebrewPlist
      : filePath.endsWith("nemoclaw-openshell-gateway.service")
        ? nemoclawGatewaySystemdUnitFixture(gatewayBinary)
        : "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n";
}

export function openShellHomebrewServicePlistFixture(formulaPrefix: string): string {
  const homebrewPrefix = path.dirname(path.dirname(formulaPrefix));
  const logDirectory = path.join(homebrewPrefix, "var", "log", "openshell");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "<key>KeepAlive</key>",
    "<dict>",
    "<key>SuccessfulExit</key>",
    "<false/>",
    "</dict>",
    "<key>Label</key>",
    "<string>homebrew.mxcl.openshell</string>",
    "<key>LimitLoadToSessionType</key>",
    "<array>",
    ...["Aqua", "Background", "LoginWindow", "StandardIO", "System"].map(
      (session) => `<string>${session}</string>`,
    ),
    "</array>",
    "<key>ProgramArguments</key>",
    "<array>",
    `<string>${path.join(formulaPrefix, "libexec", "openshell-gateway-homebrew-service")}</string>`,
    "</array>",
    "<key>RunAtLoad</key>",
    "<true/>",
    "<key>StandardErrorPath</key>",
    `<string>${path.join(logDirectory, "openshell-gateway.err.log")}</string>`,
    "<key>StandardOutPath</key>",
    `<string>${path.join(logDirectory, "openshell-gateway.out.log")}</string>`,
    "</dict>",
    "</plist>",
  ].join("\n");
}

export function serviceFileIdentityFixture(
  contentsForPath: (filePath: string) => Buffer | string,
  ownerForPath: (filePath: string) => number,
): (options: ServiceFileIdentityOptions) => ServiceFileInspection | null {
  return (options) => {
    const owner = ownerForPath(options.filePath);
    if (owner !== options.expectedUid) return null;
    const contents = Buffer.from(contentsForPath(options.filePath));
    if (options.contentsLimit !== undefined && contents.length > options.contentsLimit) return null;
    const contentSha256 = createHash("sha256").update(contents).digest("hex");
    return {
      ...(options.contentsLimit === undefined ? {} : { contents }),
      identity: {
        changedTimeNanoseconds: "1",
        ...(options.hashContents === true || options.contentsLimit !== undefined
          ? { contentSha256 }
          : {}),
        device: "1",
        inode: createHash("sha256").update(options.filePath).digest("hex"),
        linkCount: "1",
        mode: 0o755,
        modifiedTimeNanoseconds: "1",
        owner,
        size: String(contents.length),
      },
    };
  };
}
