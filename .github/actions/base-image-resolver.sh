# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash

# Shared mechanics for the sandbox base-image resolver actions. Agent-specific
# candidate construction and validation intentionally remain in each action.

resolver_glibc_version() {
  docker run --rm --entrypoint /usr/bin/ldd "$1" --version 2>/dev/null \
    | sed -nE 's/.*GLIBC ([0-9]+\.[0-9]+).*/\1/p; s/.* ([0-9]+\.[0-9]+)$/\1/p' \
    | head -n 1
}

resolver_glibc_ok() {
  local have="$1" minimum="$2"
  [[ -n "$have" ]] \
    && [[ "$(printf '%s\n%s\n' "$minimum" "$have" | sort -V | head -n 1)" == "$minimum" ]]
}

resolver_sanitize_pull_diagnostic() {
  local diagnostic="${1:-}"
  printf '%s' "$diagnostic" \
    | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177' \
    | tr '\n' ' ' \
    | sed -E \
      -e 's#([Hh][Tt][Tt][Pp][Ss]?://)[^/@[:space:]]+@#\1[redacted]@#g' \
      -e 's#([?&][^=[:space:]&]{1,80}=)[^&[:space:]]+#\1[redacted]#g' \
      -e 's#(([Pp][Rr][Oo][Xx][Yy]-)?[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy]|[Xx]-[Aa][Uu][Tt][Hh]-[Tt][Oo][Kk][Ee][Nn]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Tt]-[Cc][Oo][Oo][Kk][Ii][Ee])([[:space:]]*[:=][[:space:]]*([Bb][Ee][Aa][Rr][Ee][Rr]|[Bb][Aa][Ss][Ii][Cc]|[Tt][Oo][Kk][Ee][Nn])?[[:space:]]*)[^[:space:],;]+#\1\3[redacted]#g' \
      -e 's#(([Bb][Ee][Aa][Rr][Ee][Rr]|[Bb][Aa][Ss][Ii][Cc]|[Tt][Oo][Kk][Ee][Nn])[[:space:]]+)[^[:space:],;]+#\1[redacted]#g' \
      -e 's#(([Tt][Oo][Kk][Ee][Nn]|[Aa][Cc][Cc][Ee][Ss][Ss][_-][Tt][Oo][Kk][Ee][Nn]|[Rr][Ee][Ff][Rr][Ee][Ss][Hh][_-][Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Cc][Ll][Ii][Ee][Nn][Tt][_-][Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Uu][Tt][Hh]|[Ss][Ii][Gg]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Xx]-[Aa][Mm][Zz]-([Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Ss][Ee][Cc][Uu][Rr][Ii][Tt][Yy]-[Tt][Oo][Kk][Ee][Nn]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]))[[:space:]]*=[[:space:]]*)[^&[:space:],;]+#\1[redacted]#g' \
      -e 's#eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_.-]+#[redacted]#g' \
      -e 's#(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}#[redacted]#g' \
      -e 's#(sk-|nvapi-|hf_)[A-Za-z0-9._-]{12,}#[redacted]#g'
}

resolver_emit_pull_diagnostic() {
  local diagnostic="$1" line line_count=0
  if [[ -z "$diagnostic" ]]; then
    echo "docker pull: command failed without diagnostic output" >&2
    return 0
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_count=$((line_count + 1))
    if ((line_count > 20)); then
      echo "docker pull: additional sanitized diagnostics omitted" >&2
      break
    fi
    printf 'docker pull: %.500s\n' "$line" >&2
  done <<<"$diagnostic"
}

resolver_pull_diagnostic_is_transient() {
  local diagnostic normalized
  diagnostic="${1:-}"
  normalized="$(printf '%s' "$diagnostic" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  [[ -n "$normalized" ]] || return 1

  # Deterministic failures take precedence even if a daemon appends a generic
  # transport phrase to the same diagnostic.
  if [[ "$normalized" =~ manifest[[:space:]]+(unknown|invalid) ]] \
    || [[ "$normalized" =~ no[[:space:]]+matching[[:space:]]+manifest ]] \
    || [[ "$normalized" =~ (manifest|repository|reference|name).*(not[[:space:]]+found|does[[:space:]]+not[[:space:]]+exist) ]] \
    || [[ "$normalized" =~ pull[[:space:]]+access[[:space:]]+denied ]] \
    || [[ "$normalized" =~ access[[:space:]]+denied ]] \
    || [[ "$normalized" =~ requested[[:space:]]+access.*denied ]] \
    || [[ "$normalized" =~ (^|[[:space:]])(denied:|forbidden([[:space:]:]|$)) ]] \
    || [[ "$normalized" =~ (unauthorized|authentication[[:space:]]+required|insufficient[_[:space:]-]+scope) ]] \
    || [[ "$normalized" =~ (http[^[:alnum:]]+[^[:space:]]*[[:space:]]+|status([[:space:]]+code)?[^0-9]{0,12})(401|403|404)([^0-9]|$) ]] \
    || [[ "$normalized" =~ (^|[^[:alnum:]])(401|403|404)[[:space:]]+(unauthorized|forbidden|not[[:space:]]+found) ]] \
    || [[ "$normalized" =~ invalid[[:space:]]+(reference|repository|tag) ]] \
    || [[ "$normalized" =~ (digest|checksum|integrity).*(invalid|mismatch|verification|does[[:space:]]+not[[:space:]]+match|failed) ]] \
    || [[ "$normalized" =~ (does[[:space:]]+not[[:space:]]+match|mismatch|unexpected).*(digest|checksum) ]] \
    || [[ "$normalized" =~ (failed|unable).*(verify|validate).*(digest|checksum|integrity) ]] \
    || [[ "$normalized" =~ (layer|content).*(verification[[:space:]]+failed|size[[:space:]]+validation[[:space:]]+failed) ]] \
    || [[ "$normalized" =~ (unsupported|incompatible)[[:space:]]+platform ]] \
    || [[ "$normalized" =~ no[[:space:]]+match[[:space:]]+for[[:space:]]+platform ]] \
    || [[ "$normalized" =~ does[[:space:]]+not[[:space:]]+match[[:space:]]+the[[:space:]]+specified[[:space:]]+platform ]]; then
    return 1
  fi

  if [[ "$normalized" =~ (http[^[:alnum:]]+[^[:space:]]*[[:space:]]+|status([[:space:]]+code)?[^0-9]{0,12})(429|5[0-9][0-9])([^0-9]|$) ]] \
    || [[ "$normalized" =~ (too[[:space:]]+many[[:space:]]+requests|toomanyrequests|rate[[:space:]_-]*limit) ]] \
    || [[ "$normalized" =~ (bad[[:space:]]+gateway|service[[:space:]]+unavailable|gateway[[:space:]]+timeout|internal[[:space:]]+server[[:space:]]+error) ]] \
    || [[ "$normalized" =~ (tls[[:space:]]+handshake|i/o|connection)[[:space:]]+timeout ]] \
    || [[ "$normalized" =~ (client[.]timeout[[:space:]]+exceeded|connection[[:space:]]+timed[[:space:]]+out) ]] \
    || [[ "$normalized" =~ request[[:space:]]+(canceled|cancelled).*waiting[[:space:]]+for[[:space:]]+connection ]] \
    || [[ "$normalized" =~ (context[[:space:]]+)?deadline[[:space:]]+exceeded ]] \
    || [[ "$normalized" =~ connection[[:space:]]+(reset|refused|aborted|closed) ]] \
    || [[ "$normalized" =~ (network[[:space:]]+is[[:space:]]+unreachable|no[[:space:]]+route[[:space:]]+to[[:space:]]+host) ]] \
    || [[ "$normalized" =~ temporary[[:space:]]+failure[[:space:]]+in[[:space:]]+name[[:space:]]+resolution ]] \
    || [[ "$normalized" =~ (dial|proxyconnect)[[:space:]]+(tcp|udp) ]] \
    || [[ "$normalized" =~ lookup.*(no[[:space:]]+such[[:space:]]+host|server[[:space:]]+misbehaving) ]] \
    || [[ "$normalized" =~ (eai_again|etimedout|econnreset|econnrefused) ]] \
    || [[ "$normalized" =~ ((^|[[:space:]:])eof([[:space:]]|$)|unexpected[[:space:]]+eof|broken[[:space:]]+pipe|transport[[:space:]]+is[[:space:]]+closing) ]] \
    || [[ "$normalized" =~ failed[[:space:]]+to[[:space:]]+do[[:space:]]+request ]] \
    || [[ "$normalized" =~ temporar(il)?y[[:space:]]+unavailable ]]; then
    return 0
  fi
  return 1
}

resolver_pull() {
  local ref="$1" raw_diagnostic diagnostic status attempt delay

  for attempt in 1 2 3; do
    if raw_diagnostic="$(docker pull "$ref" 2>&1 >/dev/null)"; then
      return 0
    else
      status=$?
    fi

    if ! diagnostic="$(resolver_sanitize_pull_diagnostic "$raw_diagnostic")"; then
      echo "::error::Docker pull diagnostics could not be sanitized; refusing a local base-image fallback" >&2
      exit 75
    fi
    resolver_emit_pull_diagnostic "$diagnostic"

    if ! resolver_pull_diagnostic_is_transient "$diagnostic"; then
      return "$status"
    fi
    if ((attempt == 3)); then
      echo "::error::Base-image pull failed with a transient registry or transport error after 3 attempts; refusing a local build fallback" >&2
      # The resolver actions intentionally treat ordinary pull failures as a
      # missing candidate. Terminating the sourced action with EX_TEMPFAIL is
      # therefore the only way to preserve this distinct failure at present.
      exit 75
    fi

    delay="$attempt"
    echo "::warning::Transient base-image pull failure; retrying attempt $((attempt + 1))/3 after ${delay}s" >&2
    if ! sleep "$delay"; then
      echo "::error::Could not wait before retrying the transient base-image pull" >&2
      exit 75
    fi
  done
}

resolver_repo_digest() {
  local ref="$1" repository="$2"
  docker image inspect "$ref" --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    | grep -F -m 1 "${repository}@sha256:"
}

resolver_try_candidates() {
  local callback="$1" ref
  shift
  for ref in "$@"; do
    if "$callback" "$ref"; then
      return 0
    fi
  done
  return 1
}

resolver_build_local() {
  local dockerfile="$1" tag="$2"
  docker build -f "$dockerfile" -t "$tag" .
}

resolver_write_env() {
  local name="$1" value="$2"
  [[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]] || {
    echo "::error::Invalid GitHub environment variable name: ${name}" >&2
    return 1
  }
  [[ "$value" != *$'\n'* && -n "$value" ]] || {
    echo "::error::Invalid empty or multiline image reference" >&2
    return 1
  }
  printf '%s=%s\n' "$name" "$value" >>"$GITHUB_ENV"
}
