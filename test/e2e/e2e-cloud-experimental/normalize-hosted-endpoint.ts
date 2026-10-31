// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { unsafeEndpointUrlViolation } from "../../../src/lib/core/endpoint-url-safety.ts";
import { normalizeProviderBaseUrl } from "../../../src/lib/core/provider-endpoint.ts";

const endpoint = process.argv[2];
const violation = unsafeEndpointUrlViolation(endpoint);
if (!endpoint?.trim() || violation) {
  console.error(`Hosted endpoint ${violation?.reason ?? "is required."}`);
  process.exit(1);
}
process.stdout.write(normalizeProviderBaseUrl(endpoint, "openai"));
