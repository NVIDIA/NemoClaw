// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Keep `.js` detection for upgrade/uninstall cleanup of proxies launched by
// pre-migration releases. Remove it under #6926 once the minimum supported
// upgrade source is newer than the last release that launched the `.js` file.
const OLLAMA_AUTH_PROXY_SCRIPT_PATTERN = /(?:^|[\s/\\])ollama-auth-proxy\.(?:js|mts)(?=$|\s)/;

export function isOllamaAuthProxyCommandLine(commandLine: string): boolean {
  return OLLAMA_AUTH_PROXY_SCRIPT_PATTERN.test(commandLine);
}
