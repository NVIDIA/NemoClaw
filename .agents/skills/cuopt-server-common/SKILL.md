---
name: cuopt-server-common
version: "26.08.00"
description: cuOpt REST server — what it does and how requests flow. Domain concepts; no deploy or client code.
license: Apache-2.0
metadata:
  author: NVIDIA cuOpt Team
  tags:
    - cuopt
    - server
    - rest-api
    - concepts
---


# cuOpt Server (common)

Domain concepts for the cuOpt REST server. No deploy commands or client code here.

## What the server does

- Accepts optimization requests (routing, LP, MILP) over HTTP.
- Returns a request ID; solution is obtained by polling with that ID.
- Does **not** support QP via REST.

## Problem types supported

| Problem type | Supported |
|--------------|:---------:|
| Routing      | ✓         |
| LP           | ✓         |
| MILP         | ✓         |
| QP           | ✗         |

## Request flow (conceptual)

1. Client sends problem data in the required schema (matrices, tasks, fleet, solver config).
2. Server returns a `reqId`.
3. Client polls the solution endpoint with `reqId` until the job completes.
4. Response contains status and, on success, solution (routes, objective, primal values, etc.).

## Required questions (deployment and usage)

Ask these if not already clear:

1. **Problem type** — Routing or LP/MILP? (QP not available.)
2. **Deployment** — Local, Docker, Kubernetes, or cloud?
3. **Client** — Which language or tool will call the API (e.g. Python, curl, another service)?

## Key endpoints (conceptual)

- Health check.
- Submit request (POST).
- Get solution by request ID (GET).
- OpenAPI spec (e.g. for payload format).
