#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Generate an HTML status page from health-check.sh JSON output.
#
# Writes a self-contained HTML file that auto-refreshes and shows the
# current health of all NemoClaw services. No dependencies beyond a
# browser and the health-check.sh script.
#
# Usage:
#   ./scripts/health-check-html.sh                          # write to /tmp/nemoclaw-status.html
#   ./scripts/health-check-html.sh --output /path/to/file   # write to custom path
#   ./scripts/health-check-html.sh --open                   # write and open in browser
#   ./scripts/health-check-html.sh --sandbox mybox          # pass flags to health-check
#
# Pair with a scheduler for a live-updating dashboard:
#   watch -n 60 ./scripts/health-check-html.sh              # regenerate every 60s

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_FILE="/tmp/nemoclaw-status.html"
OPEN_BROWSER=0
HC_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --output|-o)
      OUTPUT_FILE="${2:?--output requires a path}"
      shift 2
      ;;
    --open)
      OPEN_BROWSER=1
      shift
      ;;
    --help|-h)
      sed -n '2,/^$/s/^# *//p' "$0"
      exit 0
      ;;
    *)
      HC_ARGS+=("$1")
      shift
      ;;
  esac
done

# Run health check in JSON mode
JSON=$("$SCRIPT_DIR/health-check.sh" "${HC_ARGS[@]}" --json 2>/dev/null || true)

if [ -z "$JSON" ]; then
  echo "Error: health-check.sh produced no output" >&2
  exit 1
fi

# Extract fields from JSON (portable — no jq dependency)
TIMESTAMP=$(echo "$JSON" | grep '"timestamp"' | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
SANDBOX=$(echo "$JSON" | grep '"sandbox"' | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
# Summary values are on one line — use specific key-value extraction to avoid
# greedy matching pulling the wrong number (all three would return "1" otherwise).
PASSED=$(echo "$JSON" | grep '"passed"' | head -1 | sed 's/.*"passed": *\([0-9]*\).*/\1/')
FAILED=$(echo "$JSON" | grep '"failed"' | head -1 | sed 's/.*"failed": *\([0-9]*\).*/\1/')
SKIPPED=$(echo "$JSON" | grep '"skipped"' | head -1 | sed 's/.*"skipped": *\([0-9]*\).*/\1/')

if [ "$FAILED" -eq 0 ]; then
  OVERALL_STATUS="Healthy"
  OVERALL_COLOR="#22c55e"
  OVERALL_BG="#f0fdf4"
else
  OVERALL_STATUS="Degraded"
  OVERALL_COLOR="#ef4444"
  OVERALL_BG="#fef2f2"
fi

# Build check rows
ROWS=""
while IFS= read -r line; do
  name=$(echo "$line" | sed 's/.*"name": *"\([^"]*\)".*/\1/')
  check_status=$(echo "$line" | sed 's/.*"status": *"\([^"]*\)".*/\1/')
  detail=$(echo "$line" | sed 's/.*"detail": *"\([^"]*\)".*/\1/')

  case "$check_status" in
    pass)
      icon="&#x2713;"
      color="#22c55e"
      bg="#f0fdf4"
      ;;
    fail)
      icon="&#x2717;"
      color="#ef4444"
      bg="#fef2f2"
      ;;
    skip)
      icon="&#x2013;"
      color="#a3a3a3"
      bg="#fafafa"
      ;;
  esac

  ROWS="${ROWS}
        <tr style=\"background:${bg}\">
          <td style=\"color:${color};font-size:1.2em;text-align:center;width:40px\">${icon}</td>
          <td style=\"font-weight:600;text-transform:capitalize\">${name}</td>
          <td style=\"color:#525252\">${detail:-skipped}</td>
        </tr>"
done < <(echo "$JSON" | grep '"name"')

cat > "$OUTPUT_FILE" << HTMLEOF
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="60">
  <title>NemoClaw Status</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
           background: #f5f5f5; color: #171717; padding: 2rem; }
    .container { max-width: 700px; margin: 0 auto; }
    .header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
    .header h1 { font-size: 1.5rem; }
    .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px;
             font-size: 0.875rem; font-weight: 600; }
    .meta { color: #737373; font-size: 0.875rem; margin-bottom: 1.5rem; }
    .card { background: white; border-radius: 0.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            overflow: hidden; margin-bottom: 1.5rem; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid #f0f0f0; }
    tr:last-child td { border-bottom: none; }
    .summary { display: flex; gap: 1.5rem; padding: 1rem; }
    .summary-item { text-align: center; }
    .summary-item .num { font-size: 1.5rem; font-weight: 700; }
    .summary-item .label { font-size: 0.75rem; color: #737373; text-transform: uppercase; }
    .footer { color: #a3a3a3; font-size: 0.75rem; text-align: center; margin-top: 2rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>NemoClaw Status</h1>
      <span class="badge" style="background:${OVERALL_BG};color:${OVERALL_COLOR}">${OVERALL_STATUS}</span>
    </div>
    <div class="meta">
      Sandbox: <strong>${SANDBOX}</strong> &middot; Last checked: ${TIMESTAMP} &middot; Auto-refreshes every 60s
    </div>
    <div class="card">
      <table>${ROWS}
      </table>
    </div>
    <div class="card">
      <div class="summary">
        <div class="summary-item">
          <div class="num" style="color:#22c55e">${PASSED}</div>
          <div class="label">Passed</div>
        </div>
        <div class="summary-item">
          <div class="num" style="color:#ef4444">${FAILED}</div>
          <div class="label">Failed</div>
        </div>
        <div class="summary-item">
          <div class="num" style="color:#a3a3a3">${SKIPPED}</div>
          <div class="label">Skipped</div>
        </div>
      </div>
    </div>
    <div class="footer">
      Generated by scripts/health-check-html.sh &middot; <a href="https://github.com/NVIDIA/NemoClaw">NemoClaw</a>
    </div>
  </div>
</body>
</html>
HTMLEOF

echo "Status page written to: $OUTPUT_FILE"

if [ "$OPEN_BROWSER" -eq 1 ]; then
  if command -v open >/dev/null 2>&1; then
    open "$OUTPUT_FILE"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$OUTPUT_FILE"
  else
    echo "Open $OUTPUT_FILE in your browser"
  fi
fi
