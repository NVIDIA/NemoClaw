#!/usr/bin/env bash
# Test inference.local routing through OpenShell provider
echo '{"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"say hello"}]}' > /tmp/req.json
curl -s https://inference.local/v1/chat/completions -H "Content-Type: application/json" -d @/tmp/req.json
