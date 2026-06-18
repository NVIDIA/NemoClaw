---
name: cuopt-server-api-python
version: "26.08.00"
description: cuOpt REST server — start server, endpoints, Python/curl client examples. Use when the user is deploying or calling the REST API.
license: Apache-2.0
metadata:
  author: NVIDIA cuOpt Team
  tags:
    - cuopt
    - server
    - rest-api
    - python
    - deployment
---



# cuOpt Server — Deploy and client (Python/curl)

This skill covers **starting the server** and **client examples** (curl, Python). Server has no separate C API (clients can be any language).

## Start server

```bash
# Development
python -m cuopt_server.cuopt_service --ip 0.0.0.0 --port 8000

# Docker
docker run --gpus all -d -p 8000:8000 -e CUOPT_SERVER_PORT=8000 \
  nvidia/cuopt:latest-cuda12.9-py3.13
```

## Verify

```bash
curl http://localhost:8000/cuopt/health
```

## Workflow

1. POST to `/cuopt/request` → get `reqId`
2. Poll `/cuopt/solution/{reqId}` until solution ready
3. Parse response

## Python client (routing)

```python
import requests, time
SERVER = "http://localhost:8000"
HEADERS = {"Content-Type": "application/json", "CLIENT-VERSION": "custom"}
payload = {
    "cost_matrix_data": {"data": {"0": [[0,10,15],[10,0,12],[15,12,0]]}},
    "travel_time_matrix_data": {"data": {"0": [[0,10,15],[10,0,12],[15,12,0]]}},
    "task_data": {"task_locations": [1, 2], "demand": [[10, 20]], "task_time_windows": [[0,100],[0,100]], "service_times": [5, 5]},
    "fleet_data": {"vehicle_locations": [[0, 0]], "capacities": [[50]], "vehicle_time_windows": [[0, 200]]},
    "solver_config": {"time_limit": 5}
}
r = requests.post(f"{SERVER}/cuopt/request", json=payload, headers=HEADERS)
req_id = r.json()["reqId"]
# Poll: GET /cuopt/solution/{req_id}
```

## Terminology: REST vs Python API

| Python API | REST |
|------------|------|
| order_locations | task_locations |
| set_order_time_windows() | task_time_windows |
| service_times | service_times |

Use `travel_time_matrix_data` (not transit_time_matrix_data). Capacities: `[[50, 50]]` not `[[50], [50]]`.

## Debugging (422 / payload)

**Validation errors:** Check field names against OpenAPI (`/cuopt.yaml`). Common mistakes: `transit_time_matrix_data` → `travel_time_matrix_data`; capacities per dimension `[[50, 50]]` not per vehicle `[[50], [50]]`. Capture `reqId` and response body for failed requests.

## Runnable assets

Run from each asset directory (server must be running; scripts exit 0 if server unreachable). All use Python `requests`:

- [assets/vrp_simple/](assets/vrp_simple/) — Basic VRP (no time windows)
- [assets/vrp_basic/](assets/vrp_basic/) — VRP with time windows
- [assets/pdp_basic/](assets/pdp_basic/) — Pickup and delivery
- [assets/lp_basic/](assets/lp_basic/) — LP via REST (CSR format)
- [assets/milp_basic/](assets/milp_basic/) — MILP via REST

See [assets/README.md](assets/README.md) for overview.

## Escalate

For contribution or build-from-source, see the developer skill.
