#!/usr/bin/env bash
set -e

# Kill any processes listening on 8080 or 18789
for p in 8080 18789; do
  sudo lsof -t -i :$p -sTCP:LISTEN | xargs -r sudo kill
done

# Stop all OpenShell forwards that use port 18789
openshell forward list 2>/dev/null | awk 'NR>1 {print $1, $2}' | while read port sandbox; do
  if [ "$port" = "18789" ]; then
    openshell forward stop "$port" "$sandbox"
  fi
done
