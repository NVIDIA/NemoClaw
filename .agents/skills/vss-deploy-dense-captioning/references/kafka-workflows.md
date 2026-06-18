# RTVI VLM Kafka Workflows

### 3. Dense captions with alerts from an RTSP stream (Kafka incidents)

The same `/v1/generate_captions` endpoint emits alerts — there is no
per-request alert flag. Alerts are driven by **prompt design + server-side phrase
detection**: the server lower-cases each chunk's VLM response and checks for the tokens
**`"yes"` or `"true"`**. If either appears, the server builds an incident protobuf
(`isAnomaly=True`, `info["triggerPhrase"]=<matched tokens>`, `info["verdict"]="confirmed"`)
and publishes it to `KAFKA_INCIDENT_TOPIC` in addition to the normal caption message on
`KAFKA_TOPIC`. Per <https://docs.nvidia.com/vss/latest/real-time-vlm.html>.

**Recommended prompt pattern** (from the docs):
```
Anomaly Detected: Yes/No
Reason: [Brief explanation]
```
Pair it with `system_prompt` that constrains the model to answer Yes/No.
For Kafka wiring validation, use a deterministic positive prompt first, such as
asking the model to output exactly `Anomaly Detected: Yes` with a short reason.
Once offsets move on both caption and incident topics, switch back to the real
scene-analysis prompt.

### 4. HTTP response vs. Kafka message bus

When `KAFKA_ENABLED=true`, the same request produces both outputs: an HTTP
response to the caller and Kafka records for downstream message-bus consumers.

**HTTP response** from `POST /v1/generate_captions`:
- **`stream=true`** — Server-Sent Events. One SSE event per chunk containing the
  `VlmCaptionResponse` fields (`start_time`, `end_time`, `content`, `chunk_id`
  when supported). Terminated by `[DONE]` per OpenAI-style SSE convention.
- **`stream=false`** (default) — single JSON object wrapping all chunks:
  ```json
  {
    "id": "<request_id>",
    "object": "caption",
    "chunk_responses": [
      {"start_time": "...", "end_time": "...", "content": "..."}
    ],
    "usage": {...}
  }
  ```

**Kafka publish** (when `KAFKA_ENABLED=true`):
- Every caption → **`KAFKA_TOPIC`** with header `message_type: vision_llm`
  and `info["incidentDetected"] = "true"|"false"`.
- Alert-positive chunks → **also** published to **`KAFKA_INCIDENT_TOPIC`**
  with header `message_type: incident`.
- Any upstream/VLM error → **`ERROR_MESSAGE_TOPIC`** (default `vision-llm-errors`)
  with header `message_type: error`.
- **Partition key:** `<request_id>:<chunk_idx>` — all messages for one (request, chunk)
  pair land on the same partition so a consumer can join the caption and the incident.
- **Value format:** NvSchema protobuf, not JSON. Use metadata-only consumers for
  quick verification; use the protobuf descriptors under
  `deploy/docker/services/infra/elk/pb_definitions/descriptors/` for structured decoding.

Source-backed topic sets:

| Deployment source | Caption topic | Incident topic | Error topic |
| --- | --- | --- | --- |
| Checked-in `deploy/docker/services/rtvi/rtvi-vlm/.env` | `mdx-vlm` | `mdx-vlm-incidents` | `vision-llm-errors` |
| VSS alerts / real-time Helm profiles | `mdx-vlm` | `mdx-vlm-incidents` | `vision-llm-errors` |
| LVS Helm override | `mdx-vlm-captions` | `mdx-vlm-incidents` | `vision-llm-errors` |
| Bare copied `rtvi-vlm-docker-compose.yml` without env overrides | `vision-llm-messages` | `vision-llm-events-incidents` | `vision-llm-errors` |

Always confirm the live container before validating Kafka, because these env vars
are fixed at RT-VLM container start. In a full VSS alerts real-time profile, the
Kafka container is `mdx-kafka`; use that exact container name in consumer
commands and final proof snippets. Do not shorten it to `kafka`, even if another
container with that name exists. Run this shared setup once before the topic
checks and consumer snippets below:
```bash
if [ -z "${KAFKA_CONTAINER:-}" ]; then
  if docker ps --format '{{.Names}}' | grep -qx mdx-kafka; then
    KAFKA_CONTAINER=mdx-kafka
  elif docker ps --format '{{.Names}}' | grep -qx rtvi-vlm-kafka; then
    KAFKA_CONTAINER=rtvi-vlm-kafka
  elif docker ps --format '{{.Names}}' | grep -qx kafka; then
    KAFKA_CONTAINER=kafka
  else
    KAFKA_CONTAINER=rtvi-vlm-kafka
  fi
fi
CAPTION_TOPIC="${CAPTION_TOPIC:-$(docker exec vss-rtvi-vlm printenv KAFKA_TOPIC 2>/dev/null || true)}"
INCIDENT_TOPIC="${INCIDENT_TOPIC:-$(docker exec vss-rtvi-vlm printenv KAFKA_INCIDENT_TOPIC 2>/dev/null || true)}"
ERROR_TOPIC="${ERROR_TOPIC:-$(docker exec vss-rtvi-vlm printenv ERROR_MESSAGE_TOPIC 2>/dev/null || true)}"
CAPTION_TOPIC="${CAPTION_TOPIC:-mdx-vlm}"
INCIDENT_TOPIC="${INCIDENT_TOPIC:-mdx-vlm-incidents}"
ERROR_TOPIC="${ERROR_TOPIC:-vision-llm-errors}"

kafka_cli() {
  docker exec "$KAFKA_CONTAINER" sh -lc '
    tool="$1"; shift
    if command -v "$tool" >/dev/null 2>&1; then
      exec "$tool" "$@"
    fi
    exec "/opt/kafka/bin/${tool}.sh" "$@"
  ' sh "$@"
}

docker exec vss-rtvi-vlm printenv KAFKA_TOPIC KAFKA_INCIDENT_TOPIC ERROR_MESSAGE_TOPIC 2>/dev/null || true
printf 'Kafka container: %s\n' "$KAFKA_CONTAINER"
```

For deterministic validation, first check topic offsets:
```bash
for T in "$CAPTION_TOPIC" "$INCIDENT_TOPIC" "$ERROR_TOPIC"; do
  kafka_cli kafka-get-offsets \
    --bootstrap-server 127.0.0.1:9092 \
    --topic "$T"
done
```

### Standalone Kafka Listener Setup

The RT-VLM compose does not bundle Kafka. For standalone tests, start an
equivalent broker before starting RT-VLM. The critical requirement is that the
broker advertises the same `${HOST_IP}:9092` value that RT-VLM uses for
`KAFKA_BOOTSTRAP_SERVERS=${HOST_IP}:9092`.

First choose how Kafka should be provided:

- **Use existing Kafka** if a broker is already running and the user confirms it
  is safe to reuse for validation.
- **Launch a dedicated broker** only when port `9092` is free, or after the user
  explicitly confirms that the existing broker/container may be stopped or
  replaced.
- **Disable Kafka** for API-only validation by setting
  `RTVI_VLM_KAFKA_ENABLED=false`.

Never stop or replace an existing Kafka container without user confirmation.
Preflight the host before choosing:

```bash
list_kafka_ports() {
  if command -v ss >/dev/null 2>&1 && ports="$(ss -ltn 2>/dev/null)"; then
    printf '%s\n' "$ports" | grep -E ':(9092|9093)([[:space:]]|$)' || true
  elif command -v netstat >/dev/null 2>&1 && ports="$(netstat -ltn 2>/dev/null)"; then
    printf '%s\n' "$ports" | grep -E '[:.](9092|9093)[[:space:]]' || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:9092 -iTCP:9093 -sTCP:LISTEN 2>/dev/null || true
  else
    echo "No host socket-listing tool available; inspect docker ps below and ask before replacing Kafka."
  fi
}
list_kafka_ports
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' \
  | grep -Ei 'kafka|9092' || true
```

If reusing an existing broker, set `KAFKA_CONTAINER` to its container name and
confirm RT-VLM can reach its advertised listener. `localhost:9092` as an
advertised listener is usually wrong for RT-VLM running in a different
container; it may make Kafka CLI checks pass while RT-VLM publish fails.

```bash
: "${KAFKA_CONTAINER:?Set this to the existing Kafka container name}"
# HOST_IP must match the listener RT-VLM uses in KAFKA_BOOTSTRAP_SERVERS.
```

If launching a dedicated broker, first confirm that port `9092` is free. If it
is occupied, ask the user whether to use the existing broker or stop/replace it
before continuing.

```bash
: "${HOST_IP:=host.docker.internal}"
KAFKA_CONTAINER="${KAFKA_CONTAINER:-rtvi-vlm-kafka}"
KAFKA_IMAGE="${KAFKA_IMAGE:-apache/kafka:4.1.1}"

if docker ps -a --format '{{.Names}}' | grep -qx "$KAFKA_CONTAINER"; then
  echo "Kafka container $KAFKA_CONTAINER already exists."
  echo "Set CONFIRMED_REPLACE_KAFKA=true only after explicit confirmation."
  [ "${CONFIRMED_REPLACE_KAFKA:-false}" = "true" ] || exit 1
  docker rm -f "$KAFKA_CONTAINER"
fi

host_port_in_use() {
  port="$1"
  if command -v ss >/dev/null 2>&1 && ports="$(ss -ltn 2>/dev/null)"; then
    printf '%s\n' "$ports" | grep -Eq ":${port}([[:space:]]|$)"
    return $?
  elif command -v netstat >/dev/null 2>&1 && ports="$(netstat -ltn 2>/dev/null)"; then
    printf '%s\n' "$ports" | grep -Eq "[:.]${port}[[:space:]]"
    return $?
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
    return $?
  fi
  return 2
}

host_port_in_use 9092
port_status=$?
if [ "$port_status" = "0" ]; then
  echo "Host port 9092 is already in use by another service."
  echo "Use the existing broker, or stop it only after user confirmation, then rerun."
  exit 1
elif [ "$port_status" = "2" ]; then
  echo "Could not inspect host port 9092 in this environment."
  echo "Ask the user whether Kafka is already running before launching a broker."
  exit 1
fi

# If Docker Hub rate-limits apache/kafka with HTTP 429, set:
#   KAFKA_IMAGE=confluentinc/cp-kafka:8.2.0
case "$KAFKA_IMAGE" in
  apache/kafka:*)
    docker run -d --name "$KAFKA_CONTAINER" \
      --add-host=host.docker.internal:host-gateway \
      -p 9092:9092 -p 9093:9093 \
      -e KAFKA_NODE_ID=1 \
      -e KAFKA_PROCESS_ROLES=broker,controller \
      -e KAFKA_LISTENERS=PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093 \
      -e KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://${HOST_IP}:9092 \
      -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
      -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT \
      -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 \
      -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
      -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 \
      -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 \
      "$KAFKA_IMAGE"
    ;;
  confluentinc/cp-kafka:*)
    KAFKA_CLUSTER_ID="${KAFKA_CLUSTER_ID:-MkU3OEVBNTcwNTJENDM2Qk}"
    docker run -d --name "$KAFKA_CONTAINER" \
      --add-host=host.docker.internal:host-gateway \
      -p 9092:9092 -p 9093:9093 \
      -e CLUSTER_ID="$KAFKA_CLUSTER_ID" \
      -e KAFKA_NODE_ID=1 \
      -e KAFKA_PROCESS_ROLES=broker,controller \
      -e KAFKA_LISTENERS=PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093 \
      -e KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://${HOST_IP}:9092 \
      -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
      -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT \
      -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 \
      -e KAFKA_INTER_BROKER_LISTENER_NAME=PLAINTEXT \
      -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
      -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 \
      -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 \
      -e KAFKA_LOG_DIRS=/tmp/kraft-combined-logs \
      "$KAFKA_IMAGE"
    ;;
  *)
    echo "Unsupported KAFKA_IMAGE=$KAFKA_IMAGE; use apache/kafka:4.1.1 or confluentinc/cp-kafka:8.2.0"
    exit 1
    ;;
esac

# Assumes the shared kafka_cli helper from "HTTP response vs. Kafka message bus"
# is loaded in this shell.

for i in $(seq 1 60); do
  kafka_cli kafka-topics --bootstrap-server 127.0.0.1:9092 --list >/dev/null 2>&1 && break
  sleep 2
  [ "$i" = 60 ] && { docker logs --tail 80 "$KAFKA_CONTAINER"; exit 1; }
done

# Override CAPTION_TOPIC, INCIDENT_TOPIC, and ERROR_TOPIC before creating
# topics if your copied compose uses non-default names such as vision-llm-*.

for T in "$CAPTION_TOPIC" "$INCIDENT_TOPIC" "$ERROR_TOPIC"; do
  kafka_cli kafka-topics \
    --bootstrap-server 127.0.0.1:9092 \
    --create --if-not-exists --topic "$T"
done
```

Do not advertise `localhost:9094` or `kafka:9092` unless RT-VLM is intentionally
using that same network alias. Those settings can let producer/consumer tests
inside the Kafka container pass while RT-VLM fails with
`KafkaTimeoutError: Failed to update metadata after 60.0 secs`.

The full repo infra compose (`deploy/docker/services/infra/compose.yml`) is a
full-profile building block, not the safest minimal standalone Kafka path. It
includes SDRC compose fragments; without the full profile env/config it can fail
Compose validation with errors such as `service "render-config" refers to
undefined volume "./configs"/configs`. Use it only when a full VSS profile has
already supplied the required env/config and `docker compose config --quiet`
passes.

After Kafka is running, confirm RT-VLM can reach the same broker address it was
configured with:

```bash
# Assumes the shared topic variables and kafka_cli helper are loaded.
docker exec vss-rtvi-vlm printenv KAFKA_BOOTSTRAP_SERVERS
docker logs vss-rtvi-vlm 2>&1 | grep -i 'KafkaTimeoutError\\|Failed to update metadata' || true

for T in "$CAPTION_TOPIC" "$INCIDENT_TOPIC" "$ERROR_TOPIC"; do
  kafka_cli kafka-get-offsets \
    --bootstrap-server 127.0.0.1:9092 \
    --topic "$T"
done
```

The standalone RT-VLM compose sets `KAFKA_BOOTSTRAP_SERVERS=${HOST_IP}:9092`; a
`.env` value named `KAFKA_BOOTSTRAP_SERVERS` is ignored unless you edit the
compose. If Kafka was not reachable when RT-VLM started, or if you changed the
broker advertised listener, restart/recreate RT-VLM before checking offsets:

```bash
docker compose --env-file .env -f rtvi-vlm-docker-compose.yml \
  --profile bp_developer_alerts_2d_vlm up -d --force-recreate rtvi-vlm
```

Then consume bounded, metadata-only samples from all three topics. `--timeout-ms`
prevents a no-message topic from hanging indefinitely; `print.value=false` avoids
printing protobuf bytes:
```bash
# Assumes the shared topic variables and kafka_cli helper are loaded.
for T in "$CAPTION_TOPIC" "$INCIDENT_TOPIC" "$ERROR_TOPIC"; do
  kafka_cli kafka-console-consumer \
    --bootstrap-server 127.0.0.1:9092 \
    --topic "$T" \
    --from-beginning \
    --timeout-ms 5000 \
    --max-messages 20 \
    --property print.timestamp=true \
    --property print.key=true \
    --property print.headers=true \
    --property print.value=false
done
```

For a full VSS alerts real-time profile, the incident-topic proof should include
`mdx-kafka` explicitly. Skip this block for standalone RT-VLM; use the
`kafka_cli` consumer above instead.

```bash
docker exec mdx-kafka kafka-console-consumer \
  --bootstrap-server 127.0.0.1:9092 \
  --topic "${INCIDENT_TOPIC:-mdx-vlm-incidents}" \
  --from-beginning \
  --timeout-ms 5000 \
  --max-messages 20 \
  --property print.timestamp=true \
  --property print.key=true \
  --property print.headers=true \
  --property print.value=false
```

Typical proof of an HTTP + Kafka alert pass:
```text
mdx-vlm:0:8
mdx-vlm-incidents:0:1
vision-llm-errors:0:0

CreateTime:<ms> message_type:vision_llm <request_id>:5
CreateTime:<ms> message_type:incident   <request_id>:5
```

The incident key matching the caption key (`<request_id>:<chunk_idx>`) is the
join point between the normal caption message and the alert-positive incident.
On recent Confluent Kafka images, do not override the formatter with the older
`kafka.tools.DefaultMessageFormatter`; the default consumer formatter already
supports the `print.*` properties above.

**Docs reference:** <https://docs.nvidia.com/vss/latest/real-time-vlm.html>

---
