// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** SDK response defaults for the managed Brave profile's non-secret boundary. */
export function managedBraveProfile() {
  return {
    id: "brave",
    source: "user",
    scope: "workspace",
    resourceVersion: 4n,
    inferenceCapable: false,
    credentials: [
      {
        name: "api_key",
        envVars: ["BRAVE_API_KEY"],
        required: true,
        authStyle: "header",
        headerName: "x-subscription-token",
        queryParam: "",
        pathTemplate: "",
      },
    ],
    endpoints: [
      {
        host: "api.search.brave.com",
        port: 443,
        ports: [],
        protocol: "rest",
        tls: "",
        enforcement: "enforce",
        access: "read-write",
        rules: [],
        allowedIps: [],
        denyRules: [],
        allowEncodedSlash: false,
        persistedQueries: "",
        graphqlPersistedQueries: {},
        graphqlMaxBodyBytes: 0,
        path: "",
        websocketCredentialRewrite: false,
        requestBodyCredentialRewrite: false,
        advisorProposed: false,
        credentialSigning: "",
        signingService: "",
        signingRegion: "",
        jsonRpcMaxBodyBytes: 0,
      },
    ],
    binaries: ["/usr/local/bin/node", "/usr/bin/node", "/usr/local/bin/curl", "/usr/bin/curl"].map(
      (path) => ({ path }),
    ),
  };
}

export function managedTavilyProfile(agent: "openclaw" | "hermes" = "openclaw") {
  const base = managedBraveProfile();
  return {
    ...base,
    id: agent === "hermes" ? "tavily-hermes-v1" : "tavily",
    credentials: [
      {
        ...base.credentials[0],
        envVars: ["TAVILY_API_KEY"],
        authStyle: "bearer",
        headerName: "authorization",
      },
    ],
    endpoints: [
      {
        ...base.endpoints[0],
        host: "api.tavily.com",
        requestBodyCredentialRewrite: true,
        rules: ["/search", "/extract"].map((path) => ({
          allow: {
            method: "POST",
            path,
            command: "",
            query: {},
            params: {},
            operationType: "",
            operationName: "",
            fields: [],
          },
        })),
      },
    ],
    binaries: (agent === "hermes"
      ? ["/opt/hermes/.venv/bin/python", "/usr/local/bin/curl", "/usr/bin/curl"]
      : ["/opt/venv/bin/python3*", ...base.binaries.map((binary) => binary.path)]
    ).map((path) => ({ path })),
  };
}
