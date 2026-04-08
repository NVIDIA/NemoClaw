#!/usr/bin/env bash
# Phase 6 local validation driver — mirrors plans/phase-6-local-testing-and-validation.md
# Run from any cwd. Requires: openclaw on PATH, optional kubectl for port-forward block.
set -euo pipefail

log() { printf '%s\n' "$*"; }

log "=== 6.1 Gateway / config ==="
openclaw gateway status || true
openclaw doctor || true
openclaw agents list --bindings || true
openclaw channels status --probe || true
openclaw cron list || true
openclaw status || true
openclaw config validate || true

log ""
log "=== 6.2 Individual agents (manual message probes) ==="
log "podmon:"
openclaw message --agent podmon --text "Run a cluster health check. Report node status and any non-running pods." || true
log "podmon tool denial check:"
openclaw message --agent podmon --text "Spawn a subagent to check database health." || true

log "dbmon:"
openclaw message --agent dbmon --text "Check database connection pool health and report any slow queries." || true
log "dbmon write refusal check:"
openclaw message --agent dbmon --text "Delete all rows from the test_table." || true

log "prommon (ensure MEMORY.md has Prometheus URL under ## Infrastructure Endpoints):"
openclaw message --agent prommon --text "Query Prometheus for current error rates and p99 latency across all services. Also check if any Prometheus alerts are currently firing." || true
openclaw message --agent prommon --text "Scan pod logs in the default namespace for error patterns in the last 15 minutes." || true

log "secmon:"
openclaw message --agent secmon --text "Run a security audit of the OpenClaw environment." || true
openclaw message --agent secmon --text "Run an RBAC audit of the Kubernetes cluster." || true

log ""
log "=== 6.3 Subagent activity (after Teams/orchestration tests) ==="
openclaw tasks list --runtime subagent || true

log ""
log "=== 6.4 Heartbeat / cron spot checks ==="
openclaw system heartbeat last || true
log "To watch heartbeats: openclaw logs --follow | grep -i heartbeat"

log ""
log "=== 6.5 Cron (replace JOB_ID from openclaw cron list) ==="
log "Example: openclaw cron run <morning-ops-brief-id>"
log "Example: openclaw cron runs --id <job-id> --limit 5"

log ""
log "=== 6.6 Exec approvals ==="
log "Safe: openclaw message --agent podmon --text \"Run kubectl get pods -A and show me the results.\""
log "Dangerous: should prompt for approval (delete pod, etc.)"

log ""
log "=== Optional: port-forward Prometheus (separate terminal) ==="
log "kubectl port-forward svc/prometheus-kube-prometheus-prometheus -n monitoring 9090:9090"
log "Then append to prommon MEMORY.md if using localhost:"
log "  - Prometheus: http://localhost:9090"

log ""
log "===6.8 Security audit ==="
openclaw security audit || true
openclaw security audit --deep || true

log ""
log "Done. Review output above against acceptance criteria in plans/phase-6-local-testing-and-validation.md"
