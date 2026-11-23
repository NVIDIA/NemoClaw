// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function vllmPublicationCurlArgs(urls: readonly string[]): string[] {
  return [
    "-q",
    "--noproxy",
    "*",
    "--globoff",
    "--silent",
    "--show-error",
    "--connect-timeout",
    "3",
    "--max-time",
    "5",
    "--write-out",
    "%{exitcode} %{http_code}\n",
    ...urls.flatMap((url) => ["--output", "/dev/null", url]),
  ];
}

export const SPARK_EGRESS_PROBE =
  "status=0; code=$(curl -sS -o /dev/null -w '%{http_connect}' --max-time 20 https://example.com/) || status=$?; printf '%s %s' \"$status\" \"$code\"";
