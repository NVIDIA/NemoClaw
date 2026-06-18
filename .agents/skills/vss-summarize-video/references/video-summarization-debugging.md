# Video Summarization Debugging Reference

Use this for video summarization-specific troubleshooting after the `lvs` profile has been
deployed or partially deployed.

## Fast Status

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "${LVS_BACKEND_URL:-http://localhost:38111}/v1/ready"

docker ps --filter name=vss-lvs --format '{{.Names}} {{.Status}}'
docker logs --tail 100 vss-lvs
```

HTTP 200 on `/v1/ready` means ready. HTTP 503 means the service is warming or a
dependency is unavailable.

## Video Summarization Service Not Ready

Check dependencies:

```bash
curl -sf "http://${HOST_IP}:8018/v1/models" | jq '.data[].id'
curl -sf "http://${HOST_IP}:9200/_cluster/health" | jq .
docker logs --tail 100 vss-rtvi-vlm
docker logs --tail 100 vss-lvs
```

Common causes:

| Symptom | Likely cause | Fix |
|---|---|---|
| `400 BadParameters: No such model` | `VLM_NAME` does not match RT-VLM `/v1/models`. | Copy the advertised id into `VLM_NAME` and recreate `vss-lvs` / `vss-agent`. |
| `/v1/ready` returns 503 | LLM, RT-VLM, ES, or another dependency is warming/unreachable. | Check dependency logs and endpoint URLs. |
| `curl` to the video summarization service works on host but not in an agent sandbox | Network namespace or sandbox visibility differs. | Use host-visible shell/deployment context. |
| Summarize returns 503 | The video summarization service is busy processing another file. | Wait and retry. |
| Empty or weak event output | Scenario/events too narrow or no matching content. | Re-run with broader events or scenario. |

## Model Id Mismatch

The default `lvs` profile routes VLM calls through RT-VLM. Verify:

```bash
curl -sf "http://${HOST_IP}:8018/v1/models" | jq -r '.data[].id'
```

For the default integrated Cosmos Reason 2 path, `VLM_NAME` should be:

```text
nim_nvidia_cosmos-reason2-8b_hf-1208
```

Do not use `nvidia/cosmos-reason2-8b` unless the endpoint advertises that id.

## Kafka / Logstash Path

The 3.2 `lvs` profile uses Kafka and shared Logstash for streaming captions and
structured summaries.

Expected topics:

| Topic | Producer / consumer |
|---|---|
| `mdx-vlm-captions` | RT-VLM produces raw captions; Logstash consumes. |
| `mdx-structured-events-summary` | the video summarization service publishes structured summaries; Logstash consumes. |

Checks:

```bash
docker logs --tail 100 logstash
docker exec kafka kafka-topics --bootstrap-server localhost:9092 --list
docker exec kafka kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic mdx-vlm-captions \
  --max-messages 1
```

If Logstash starts but does not index video summarization data, check that the shared infra
Logstash pipeline is loading the video summarization pipeline and that protobuf
definitions are mounted from `deploy/docker/services/infra/elk/logstash`.

## API Validation Failures

`422` usually means the request body violates the OpenAPI schema.

Rules:

- `model`, `scenario`, and `events` are required for `/v1/summarize`.
- `additionalProperties: false` means extra fields can fail validation.
- Prefer `num_frames_per_second_or_fixed_frames_chunk` and
  `use_fps_for_chunking`; `num_frames_per_chunk` is deprecated.
- `schema` is a JSON schema serialized as a string, not a nested object.

## Logs

```bash
docker logs -f vss-lvs
docker logs -f vss-rtvi-vlm
docker logs -f logstash
docker logs -f kafka
```

Use bounded logs in automated checks:

```bash
docker logs --tail 200 --since 10m vss-lvs
```
