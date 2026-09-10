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
