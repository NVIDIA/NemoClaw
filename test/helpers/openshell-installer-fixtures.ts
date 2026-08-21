// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const CANDIDATE_RUNTIME = {
  cli: process.env.OPENSHELL_BIN,
  gateway: process.env.OPENSHELL_GATEWAY_BIN,
  resolutionId: process.env.NEMOCLAW_CANDIDATE_RESOLUTION_ID,
  sandbox: process.env.NEMOCLAW_OPENSHELL_SANDBOX_BIN,
  version: process.env.NEMOCLAW_CANDIDATE_VERSION,
};
export const CANDIDATE_RUNTIME_ENABLED = Object.values(CANDIDATE_RUNTIME).every(Boolean);

export const PINNED_OPEN_SHELL_SHA256 = {
  cliDarwinArm64: "969493205e3d3462226ff613eaba0b9cde0f582e3026294169d533d41e87c905",
  cliLinuxArm64: "ce981904ae8febd9cd6b3fbceb04e1dcfb48da6042bac08eadf0c2211f83fe55",
  cliLinuxX64: "d1a885a91b3e5aaa006c36aca95dc78bed0638c1ba1a79b55f1da93211b8a0a0",
  formula: "f0f86519e227b3b326431410058ba690b1a7b83e5af7384014e4b96283d3a642",
  gatewayDarwinArm64: "de8f90db9dd0d3b47855b2b6d2542660730917bd1249e53140300990a8690b94",
  gatewayLinuxArm64: "22b7781249e3487085694d0f0f3797a0e549018b81144cd24b2f1118c730d1c7",
  gatewayLinuxX64: "b7760cb752a4363c2f21d32298dd0c683dc438f6edfd16c2e4242bc0baefbb7c",
  sandboxLinuxArm64: "5e5d758d53c6abc6d7a936be907dafa9dfce10423289536f39b50abe294dfafd",
  sandboxLinuxX64: "559b8aaad3a8eeab45c511e7de531d9baa98a311282dcb0c2c5f38cc2d4ca355",
  sandboxBinaryLinuxX64: "019301ec8618abbed8135e8d39dde7bea47e5e92813bbc17768550de34db59f8",
} as const;

export const ZERO_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";
export const OPENSHELL_REWRITE_FEATURE_MARKERS =
  "request-body-credential-rewrite websocket-credential-rewrite";
export const OPENSHELL_MCP_FEATURE_MARKER = "allow_all_known_mcp_methods";
export const OPENSHELL_FEATURE_MARKERS = `${OPENSHELL_REWRITE_FEATURE_MARKERS} ${OPENSHELL_MCP_FEATURE_MARKER}`;
export const BREW_OUTCOMES = [
  ["0", "0", "reinstall", 0],
  ["1", "1", "install", 1],
  ["0", "1", "reinstall", 1],
] as const;

export function trustedFormulaBoundaryEvents(operation: string): string[] {
  return [
    "--repository nvidia/openshell",
    "help trust",
    "help untrust",
    "untrust --formula nvidia/openshell/openshell",
    "trust --formula nvidia/openshell/openshell",
    operation,
    "untrust --formula nvidia/openshell/openshell",
  ];
}

export function unverifiedFormulaBoundaryEvents(operation: string): string[] {
  return trustedFormulaBoundaryEvents(operation).filter((event) => !event.startsWith("trust "));
}
