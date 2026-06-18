## End-to-end example

Assume the `vss-manage-video-io-storage` skill has already given you
`$CLIP` (clip URL) and `$DURATION` (seconds, for the user-facing
header). The flow probes the video summarization service once, runs
HITL + LVS when it is up, and falls back to the VLM with the default
prompt only when it is not.

```bash
VIDEO_SUMMARIZATION_URL=${LVS_BACKEND_URL:-http://${HOST_IP:-localhost}:38111}

# Readiness = HTTP 200 on /v1/ready. Body may be empty — do not inspect it.
# Retry on 503 (warmup) for up to ~30s before concluding the service is unavailable.
video_sum_code=000
for i in $(seq 1 10); do
  video_sum_code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 "$VIDEO_SUMMARIZATION_URL/v1/ready")
  case "$video_sum_code" in 200) break ;; 503) sleep 3 ;; *) break ;; esac
done

if [ "$video_sum_code" = "200" ]; then
  # ── Primary path: video summarization microservice with HITL ──
  # HITL (required, before the curl): post the Step 2 scenario/events message and
  # wait for the user's reply. Substitute their values (or the `defaults` opt-in)
  # into $SCENARIO, $EVENTS_JSON, and $OBJECTS_JSON below. Do not run the curl
  # without that reply.
  SCENARIO='warehouse monitoring'            # or whatever the user gave
  EVENTS_JSON='["notable activity"]'         # jq-compatible JSON array
  OBJECTS_JSON=''                            # '' to omit, else '["cars","trucks"]'

  curl -s --max-time 300 -X POST "$VIDEO_SUMMARIZATION_URL/v1/summarize" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg url "$CLIP" \
          --arg model "${VLM_NAME:-nim_nvidia_cosmos-reason2-8b_hf-1208}" \
          --arg scenario "$SCENARIO" \
          --argjson events "$EVENTS_JSON" \
          --argjson objects "${OBJECTS_JSON:-null}" '{
      url: $url,
      model: $model,
      scenario: $scenario,
      events: $events,
      chunk_duration: 10,
      num_frames_per_second_or_fixed_frames_chunk: 20,
      use_fps_for_chunking: false,
      seed: 1
    } + (if $objects == null then {} else {objects_of_interest: $objects} end)')" \
    | jq -r '.choices[0].message.content' | jq '{video_summary, events}'
else
  # ── Fallback path: VLM with the default prompt, no HITL ──
  # Prepend the Routing fallback note to the response so the user knows.
  echo "⚠ Note: the video summarization service returned HTTP $video_sum_code; falling back to VLM with the default prompt."
  VLM="${VLM_BASE_URL:-${RTVI_VLM_BASE_URL:-http://${HOST_IP:-localhost}:8018}}"
  VLM="${VLM%/v1}"
  PROMPT='Describe in detail what is happening in this video,
including all visible people, vehicles, equipments, objects,
actions, and environmental conditions.
OUTPUT REQUIREMENTS:
[timestamp-timestamp] Description of what is happening.
EXAMPLE:
[0.0s-4.0s] <description of the first event>
[4.0s-12.0s] <description of the second event>'

  curl -s --max-time 300 -X POST "$VLM/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg url "$CLIP" --arg text "$PROMPT" \
          --arg model "${VLM_NAME:-nim_nvidia_cosmos-reason2-8b_hf-1208}" '{
      model: $model,
      temperature: 0.0,
      max_tokens: 1024,
      messages: [{role:"user", content:[
        {type:"text", text:$text},
        {type:"video_url", video_url:{url:$url}}
      ]}]
    }')" | jq -r '.choices[0].message.content'
fi
```
