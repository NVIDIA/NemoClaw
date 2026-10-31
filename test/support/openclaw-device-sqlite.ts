// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseSync } from "node:sqlite";

export function executePairingFixtureQuery(
  db: DatabaseSync,
  query: { table: string; rows?: Record<string, string>[] },
) {
  if (!query.rows) db.exec(`DELETE FROM ${query.table}`);
  else
    for (const row of query.rows)
      db.prepare(
        `INSERT INTO ${query.table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
          .map(() => "?")
          .join(",")})`,
      ).run(...Object.values(row));
}
