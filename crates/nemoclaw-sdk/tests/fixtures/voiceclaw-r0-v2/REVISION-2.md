# Experimental R0 revision 2: shared implementation handoff

The maintainer amendments to NemoClaw #11746/#11747/#11749/#11752 select
`nemoclaw-voice-r0/2`. Revision 1 lifecycle and bootstrap rules remain in force.
This file supplies concrete interoperable payloads and failure normalization for
that decision. It is a shared implementation target, not live qualification evidence.

## Exact exchange

After admission via VoiceClaw GET /r0/events, the client may POST /r0/probe once:

```json
{"profile":"nemoclaw-voice-r0/2","question":"What is two plus two? Reply with only 4."}
```

VoiceClaw accepts exactly those keys and values (JSON whitespace/key order are
irrelevant). Authenticate with the separate VoiceClaw client bearer first.
Queries, duplicate/unknown fields, native selectors and arbitrary text fail locally
before any NemoClaw request. GET status is not admission. There is no general work API.

VoiceClaw derives `/r0/probe` from the already validated literal-loopback
`/r0/connect` URL; the caller cannot supply another endpoint. It sends the protected
NemoClaw bearer and adds only its existing opaque binding:

```json
{"profile":"nemoclaw-voice-r0/2","targetRef":"target-r0-fixture","question":"What is two plus two? Reply with only 4."}
```

Both requests use POST, Content-Type application/json (optional charset=utf-8),
Accept application/json. No redirects, proxy routing or retry. Request and response
bodies are bounded to 4096 UTF-8 bytes. JSON must reject duplicate keys and invalid
UTF-8. NemoClaw authenticates first, requires the active revision 2 stream, rechecks
target generation/native readiness immediately before dispatch, and enforces one
probe. A valid request reserves the run's one probe before async dispatch. A failed
or lost dispatched probe is never retryable. Locally rejected malformed requests
are not dispatches and do not consume the one probe.

Success on both interfaces: HTTP 200, Content-Type application/json,
Cache-Control no-store, exactly:

```json
{"profile":"nemoclaw-voice-r0/2","answer":"4"}
```

The answer must originate at the agent. Preserve its text if it contains exactly
one ASCII `4` with only Unicode whitespace or punctuation before/after it. Do not
synthesize 4, parse an embedded number out of prose, accept other digits/words, or
expose extra response fields. Invalid/oversized/unknown upstream responses fail
closed as 502 invalid_response. No native or credential data is returned.

The probe deadline is 60 seconds, bounded by scoped expiry and the existing
stream's liveness. NemoClaw should finish within this bound; a local deadline is
503 agent_unavailable. Stream loss while pending aborts the HTTP probe and yields
503 connection_lost where deliverable. No late success after invalidation.
A probe failure ends the VoiceClaw run; successful probing preserves status/close
until the ordinary lifecycle ends. Cleanup never cancels existing agent work.

## Normalized probe failures

Probe errors on both boundaries use exactly `{"error":{"code":"CODE"}}` with
Content-Type application/json and Cache-Control no-store. Unknown upstream errors
are not forwarded. Existing status/close error shapes are unchanged.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | authentication_failed | Missing/invalid bearer |
| 401 | credential_expired | Scoped access expired |
| 400 | invalid_request | Invalid UTF-8/JSON/schema/question/query or duplicate/extra field |
| 409 | unsupported_profile | Unsupported profile |
| 403 | target_not_authorized | Wrong public target |
| 409 | target_replaced | Bound generation changed |
| 503 | agent_unavailable | Agent unavailable or probe deadline |
| 409 | connection_required | No active semantic stream / no admitted VoiceClaw client |
| 409 | probe_already_used | A probe was already reserved in this run |
| 413 | request_too_large | Request exceeds 4096 bytes |
| 415 | unsupported_media_type | Request is not JSON |
| 503 | connection_lost | Connection invalidated or upstream transport failed |
| 502 | invalid_response | Upstream response violates the bounded semantic schema |

After cleanup the old client credential is invalid; a reachable gateway rejects
it, otherwise connection failure is expected. No endpoint must survive run shutdown.
The NemoClaw bearer is retained only in private run memory until probe dispatch or
cleanup; overwrite mutable credential buffers and discard transport-header references.
JavaScript/HTTP temporary string copies cannot be guaranteed physically zeroized.

## Fixtures and ownership

`fixtures.json` carries revision 2 connection cases plus probeCases and exact
client/semantic payloads. `fixture_server.py` is synthetic; its dispatch counter is
not native-agent evidence. Production NemoClaw must consume the corpus with real
binding/auth checks and an instrumented native adapter in tests. VoiceClaw consumes
it through its actual gateway and both unpacked artifacts. Share the exact corpus
SHA-256 in both repositories; do not silently change one side.

NemoClaw #11749 must implement this endpoint/normalization and protected dispatch;
#11751 must select revision 2 for prepare/connect; #11752 must demonstrate the
independent client through both gateways to the real sandboxed agent/inference
route. The old separately invoked native probe cannot satisfy that proof.
