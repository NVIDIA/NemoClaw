// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Hermes and OpenShell versions supported by the first lifecycle API. */
export const HERMES_LIFECYCLE_DEFINITION = Object.freeze({
  agent: "hermes" as const,
  agentVersion: "0.21.3" as const,
  openshellVersion: "0.1.5" as const,
});

/** OpenShell runtime selected by the Hermes CLI; independent of the first lifecycle API. */
export const HERMES_CLI_OPENSHELL_VERSION = "0.1.7" as const;
