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

RESOLVER_PULL_DIAGNOSTIC_BYTE_LIMIT=65536

resolver_sanitize_pull_diagnostic() {
  # Docker stderr is byte-bounded before this stream reaches the shell. Treat
  # CR and LF as record boundaries while redacting complete sensitive headers,
  # then flatten the records so untrusted text cannot create a GitHub command.
  LC_ALL=C tr '\015' '\012' \
    | LC_ALL=C tr -d '\000-\011\013\014\016-\037\177-\237' \
    | LC_ALL=C awk '
      BEGIN { sensitive_continuation = 0 }
      {
        lower = tolower($0)
        if (match(lower, /(^|[[:space:]])(proxy-authorization|authorization|cookie|set-cookie|x-registry-auth|x-registry-config|x-api-key|x-auth-token)[[:space:]]*[:=]/)) {
          print substr($0, 1, RSTART + RLENGTH - 1) "[redacted]"
          sensitive_continuation = 1
          next
        }
        if (sensitive_continuation && $0 ~ /^[[:space:]]+/) {
          print "[redacted]"
          next
        }
        sensitive_continuation = 0
        print
      }
    ' \
    | sed -E \
      -e 's#([Hh][Tt][Tt][Pp][Ss]?://)[^/@[:space:]]+@#\1[redacted]@#g' \
      -e 's#([?&][^=[:space:]&]{1,80}=)[^&[:space:]]+#\1[redacted]#g' \
      -e 's#(([Bb][Ee][Aa][Rr][Ee][Rr]|[Bb][Aa][Ss][Ii][Cc]|[Tt][Oo][Kk][Ee][Nn]|[Nn][Ee][Gg][Oo][Tt][Ii][Aa][Tt][Ee])[[:space:]]+)[^[:space:],;]+#\1[redacted]#g' \
      -e 's#(([Tt][Oo][Kk][Ee][Nn]|[Aa][Cc][Cc][Ee][Ss][Ss][_-][Tt][Oo][Kk][Ee][Nn]|[Rr][Ee][Ff][Rr][Ee][Ss][Hh][_-][Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Cc][Ll][Ii][Ee][Nn][Tt][_-][Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Uu][Tt][Hh]|[Ss][Ii][Gg]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Xx]-[Aa][Mm][Zz]-([Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Ss][Ee][Cc][Uu][Rr][Ii][Tt][Yy]-[Tt][Oo][Kk][Ee][Nn]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]))[[:space:]]*=[[:space:]]*)[^&[:space:],;]+#\1[redacted]#g' \
      -e 's#eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_.-]+#[redacted]#g' \
      -e 's#(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}#[redacted]#g' \
      -e 's#(sk-|nvapi-|hf_)[A-Za-z0-9._-]{12,}#[redacted]#g' \
    | tr '\012' ' '
}

resolver_emit_pull_diagnostic() {
  local diagnostic="$1" truncated="$2"
  if [[ -z "$diagnostic" ]]; then
    echo "docker pull: command failed without diagnostic output" >&2
  else
    printf 'docker pull: %.500s\n' "$diagnostic" >&2
  fi

  if [[ "$truncated" == 1 ]]; then
    echo "docker pull: diagnostic truncated at ${RESOLVER_PULL_DIAGNOSTIC_BYTE_LIMIT} bytes" >&2
  fi
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
    || [[ "$normalized" =~ does[[:space:]]+not[[:space:]]+match[[:space:]]+the[[:space:]]+specified[[:space:]]+platform ]] \
    || [[ "$normalized" =~ x509: ]] \
    || [[ "$normalized" =~ (certificate|cert).*(unknown[[:space:]]+authority|verif|expired|not[[:space:]]+yet[[:space:]]+valid|hostname|not[[:space:]]+valid|untrusted|self[[:space:]-]*signed) ]] \
    || [[ "$normalized" =~ tls:.*bad[[:space:]]+certificate ]] \
    || [[ "$normalized" =~ tls:.*failed[[:space:]]+to[[:space:]]+verify[[:space:]]+certificate ]] \
    || [[ "$normalized" =~ (http[^0-9]{0,20}|status([[:space:]]+code)?[^0-9]{0,12})4([01][0-9]|2[0-8]|[3-9][0-9])([^0-9]|$) ]]; then
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
    || [[ "$normalized" =~ lookup.*(no[[:space:]]+such[[:space:]]+host|server[[:space:]]+misbehaving) ]] \
    || [[ "$normalized" =~ (eai_again|etimedout|econnreset|econnrefused) ]] \
    || [[ "$normalized" =~ ((^|[[:space:]:])eof([[:space:]]|$)|unexpected[[:space:]]+eof|broken[[:space:]]+pipe|transport[[:space:]]+is[[:space:]]+closing) ]] \
    || [[ "$normalized" =~ temporar(il)?y[[:space:]]+unavailable ]]; then
    return 0
  fi
  return 1
}

resolver_capture_pull() (
  local ref="$1" diagnostic_file="" byte_count status truncated=0
  local temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

  # mktemp creates the capture with mode 0600 under this restrictive umask.
  # The 64 KiB prefix is sanitized before it enters the parent shell.
  umask 077
  diagnostic_file="$(mktemp "${temp_root%/}/nemoclaw-docker-pull.XXXXXX")" || exit 74
  trap 'rm -f -- "$diagnostic_file"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if docker pull "$ref" >/dev/null 2>"$diagnostic_file"; then
    status=0
  else
    status=$?
  fi

  byte_count="$(wc -c <"$diagnostic_file")" || exit 74
  if ((byte_count > RESOLVER_PULL_DIAGNOSTIC_BYTE_LIMIT)); then
    truncated=1
  fi

  printf '%s\n%s\n' "$status" "$truncated"
  LC_ALL=C head -c "$RESOLVER_PULL_DIAGNOSTIC_BYTE_LIMIT" "$diagnostic_file" \
    | resolver_sanitize_pull_diagnostic
)

resolver_pull() {
  local ref="$1" capture payload diagnostic status truncated attempt delay

  for attempt in 1 2 3; do
    if ! capture="$(resolver_capture_pull "$ref")"; then
      echo "::error::Docker pull diagnostics could not be captured securely; refusing a local base-image fallback" >&2
      exit 75
    fi

    if [[ "$capture" != *$'\n'* ]]; then
      echo "::error::Docker pull diagnostics returned an invalid status; refusing a local base-image fallback" >&2
      exit 75
    fi
    status="${capture%%$'\n'*}"
    payload="${capture#*$'\n'}"
    truncated="${payload%%$'\n'*}"
    if [[ "$payload" == *$'\n'* ]]; then
      diagnostic="${payload#*$'\n'}"
    else
      diagnostic=""
    fi
    if [[ ! "$status" =~ ^[0-9]+$ ]] || ((status > 255)) || [[ ! "$truncated" =~ ^[01]$ ]]; then
      echo "::error::Docker pull diagnostics returned invalid metadata; refusing a local base-image fallback" >&2
      exit 75
    fi
    if ((status == 0)); then
      return 0
    fi

    resolver_emit_pull_diagnostic "$diagnostic" "$truncated"

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
