// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { load } from "./persistence";

export type ManagedMcpCredentialReservation = {
  sandboxName: string;
  server: string;
  credentialKeys: readonly string[];
};

export function listManagedMcpCredentialReservations(): readonly ManagedMcpCredentialReservation[] {
  return Object.values(load().sandboxes)
    .flatMap((sandbox) =>
      Object.values(sandbox.mcp?.bridges ?? {}).map((entry) => ({
        sandboxName: sandbox.name,
        server: entry.server,
        credentialKeys: [...entry.env],
      })),
    )
    .sort(
      (left, right) =>
        left.sandboxName.localeCompare(right.sandboxName) ||
        left.server.localeCompare(right.server),
    );
}
