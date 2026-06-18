# Examples of discovery modes

## Wide-net discovery — cast the widest net, fast

For exploratory searches when recall matters more than precision.
Start broad (high result count e.g. 50–100, low similarity threshold e.g. 0.1, critic disabled exceptionally) then refine based on returned results.

```bash
curl -s -X POST http://${HOST_IP}:8000/generate \
  -H "Content-Type: application/json" \
  -d '{"input_message": "find unusual activity, return top 100 results, any similarity, disable critic"}' | jq .
```

Typical follow-ups:
- Take the most promising results and re-run with high-precision mode (higher similarity threshold, lower top_k to filter noise) 
- Scope to cameras/time — if certain cameras or time windows surfaced interesting results, re-run narrowed to those specific video sources and time ranges
- Search based on attributes — if a person of interest appeared in the results, follow up with an appearance-based query (e.g., "person wearing red jacket and blue jeans") to find other occurrences across cameras.

## Narrow to specific cameras and/or time — scope to a known incident

When the camera location and time window are known. Reduces search space and returns faster, more relevant results.

Specify camera names as the video sources in the user input. Set explicit time range, keep critic enabled.
For RTSP camera streams, use the RTSP `messages` + `search_source_type` request shape from the main SKILL.md instead of the `input_message` shortcut.

```bash
curl -s -X POST http://${HOST_IP}:8000/generate \
  -H "Content-Type: application/json" \
  -d '{"input_message": "find person carrying a box at loading_dock_cam and warehouse_entrance between 10pm and 6am"}' | jq .
```

## High-precision search — raise the similarity bar

When false positives are very costly (e.g., compliance audits, PPE verification) and there must be very low tolerance.
Low result count, high similarity threshold (e.g. 0.5+) plus critic gives the tightest filter.

```bash
curl -s -X POST http://${HOST_IP}:8000/generate \
  -H "Content-Type: application/json" \
  -d '{"input_message": "find person wearing high-visibility vest, top 5 results, minimum similarity 0.5"}' | jq .
```

## Metadata-based filtering — filter by camera tags

Only useful when cameras are tagged with location or category metadata (e.g., "parking lot", "warehouse", "lobby"). Reduce pollution of the semantic search.

When considering this mode, first check if cameras have metadata or tags set using the `vss-manage-video-io-storage` skill to list sensors and show their descriptions. If no tags exist, offer the user the option to add metadata tags via the `vss-manage-video-io-storage` skill before relying on this type of filtering.

Mention the camera metadata tag (location, category) explicitly in the query. Can add other filters (camera names, time-ranges for further scoping etc.)

```bash
curl -s -X POST http://${HOST_IP}:8000/generate \
  -H "Content-Type: application/json" \
  -d '{"input_message": "find person running, only from cameras tagged as parking lot, top 10 results"}' | jq .
```
