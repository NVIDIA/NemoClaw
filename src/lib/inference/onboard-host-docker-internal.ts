// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const HOST_DOCKER_INTERNAL = "host.docker.internal";
const OLLAMA_PROXY_URL = "http://host.openshell.internal:11435/v1";

function isHijackedDockerInternalUrl(url) {
  try {
    return new URL(String(url)).hostname === HOST_DOCKER_INTERNAL;
  } catch {
    return false;
  }
}

function getHostDockerInternalProbeFailure() {
  return {
    ok: false,
    message:
      `${HOST_DOCKER_INTERNAL} does not reach the host machine from inside the sandbox: ` +
      `OpenShell k3s sandboxes do not provide it as a reliable host-service route. ` +
      `It may fail DNS resolution or resolve to a gateway/bridge address where port ` +
      `11434 is not forwarded. For local Ollama, use the auth-proxy URL ` +
      `${OLLAMA_PROXY_URL} (the URL NemoClaw onboard configures automatically ` +
      `when you pick "Local Ollama"). See issue #3136.`,
    failures: [
      {
        name: "host.docker.internal reachability",
        httpStatus: 0,
        curlStatus: 0,
        message:
          `${HOST_DOCKER_INTERNAL} is not a reliable host-service route from ` +
          `OpenShell k3s sandboxes and cannot be used as an inference base URL.`,
        body: "",
      },
    ],
  };
}

module.exports = {
  HOST_DOCKER_INTERNAL,
  OLLAMA_PROXY_URL,
  isHijackedDockerInternalUrl,
  getHostDockerInternalProbeFailure,
};
