# Server API Python — runnable assets

REST client examples (Python requests). Each runs against a cuOpt server; if the server is not reachable, the script exits 0 (skip).

| Asset         | Description |
|---------------|-------------|
| `vrp_simple/` | Basic VRP (no time windows) |
| `vrp_basic/`  | VRP with time windows |
| `pdp_basic/`  | Pickup and delivery (pairs) |
| `lp_basic/`   | LP (CSR format) |
| `milp_basic/` | MILP (integer + continuous variables) |

Start server: `python -m cuopt_server.cuopt_service --ip 0.0.0.0 --port 8000`
Env: `CUOPT_SERVER_URL` (default `http://localhost:8000`).
