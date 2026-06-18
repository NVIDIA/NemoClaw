# LP via REST (maximize 40x + 30y)

Submit an LP to the cuOpt server (CSR format) and poll for the solution.

**Requires:** cuOpt server running (e.g. `python -m cuopt_server.cuopt_service --ip 0.0.0.0 --port 8000`).

**Run:** `python client.py`
If the server is not reachable, the script exits 0 (skip).

**Env:** `CUOPT_SERVER_URL` (default `http://localhost:8000`).
