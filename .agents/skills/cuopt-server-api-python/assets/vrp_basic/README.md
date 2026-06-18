# VRP with time windows (REST client)

Submit a VRP with time windows to the cuOpt server and poll for the solution.

**Requires:** cuOpt server running (e.g. `python -m cuopt_server.cuopt_service --ip 0.0.0.0 --port 8000`).

**Run:** `python client.py`
If the server is not reachable, the script exits 0 (skip).

**Env:** `CUOPT_SERVER_URL` (default `http://localhost:8000`).
