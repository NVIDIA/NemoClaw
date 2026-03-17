### Summary
Adds a lightweight observability layer and a Prometheus-compatible metrics service to NemoClaw. This allows tracking agent execution performance, blueprint latency, and API validation health without external dependencies.

### Key Components
- **Metrics Registry** — Custom lightweight implementation of counters and histograms in `nemoclaw/src/observability/metrics.ts`.
- **Metrics Service** — Integrated HTTP server (default port 9090) that exports Prometheus-formatted metrics at `/metrics`.
- **Instrumentation** — Wrapped `execBlueprint` and `validateApiKey` with latency observers to track real-world performance.
- **Documentation** — Updated README with configuration details (`NEMOCLAW_METRICS_ENABLED`) and example Prometheus output.

### Usage
```bash
# Enable metrics
export NEMOCLAW_METRICS_ENABLED=true
# Optional: Change port (defaults to 9090)
export NEMOCLAW_METRICS_PORT=9090

# View metrics
curl http://localhost:9090/metrics
```

### Verification
- **Unit Tests** — Added `test/metrics.test.js` verifying registry storage, histogram bucket logic, and `observeLatency` wrapper.
- **Manual Verification** — Verified Prometheus output format matches standard specifications.

### Notes
- Zero external dependencies for metrics (uses `node:http` and `process.hrtime.bigint`).
- Disabled by default to ensure zero overhead for standard CLI users.
- Adheres to NVIDIA's SPDX licensing headers.