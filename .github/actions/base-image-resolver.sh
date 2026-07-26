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

resolver_canonicalize_pull_diagnostic_records() {
  # Docker stderr is byte-bounded before this stream reaches the shell. Treat
  # CRLF, lone CR, and LF as record boundaries, remove terminal decoration,
  # and remove other controls before any record-boundary security decisions.
  LC_ALL=C sed -E \
    -e $'s/\033\\][^\007\033]*(\007|\033\\\\)//g' \
    -e $'s/\033\\[[0-?]*[ -\\/]*[@-~]//g' \
    | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177-\377' \
    | LC_ALL=C awk '
      BEGIN { cr = sprintf("%c", 13) }
      {
        if (length($0) == 0) {
          print
          next
        }
        count = split($0, records, cr)
        last = count
        if (count > 1 && records[count] == "" && substr($0, length($0), 1) == cr) {
          last--
        }
        for (i = 1; i <= last; i++) print records[i]
      }
    '
}

resolver_sanitize_canonical_pull_diagnostic() {
  # Redact complete sensitive headers, then flatten the records so untrusted
  # text cannot create a GitHub command.
  LC_ALL=C awk '
      BEGIN { sensitive_continuation = 0 }
      {
        lower = tolower($0)
        if (match(lower, /(proxy-authorization|authorization|cookie|set-cookie|x-registry-auth|x-registry-config|x-api-key|x-auth-token)[[:space:]]*[:=]/)) {
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
    | LC_ALL=C tr '\011' ' ' \
    | LC_ALL=C sed -E \
      -e 's#([Hh][Tt][Tt][Pp][Ss]?://)[^/@[:space:]]+@#\1[redacted]@#g' \
      -e 's#([?&][^=[:space:]&]*=)[^&[:space:]]+#\1[redacted]#g' \
      -e 's#(([Bb][Ee][Aa][Rr][Ee][Rr]|[Bb][Aa][Ss][Ii][Cc]|[Tt][Oo][Kk][Ee][Nn]|[Nn][Ee][Gg][Oo][Tt][Ii][Aa][Tt][Ee])[[:space:]]+)[^[:space:],;]+#\1[redacted]#g' \
      -e 's#(([Tt][Oo][Kk][Ee][Nn]|[Aa][Cc][Cc][Ee][Ss][Ss][_-][Tt][Oo][Kk][Ee][Nn]|[Rr][Ee][Ff][Rr][Ee][Ss][Hh][_-][Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Cc][Ll][Ii][Ee][Nn][Tt][_-][Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Uu][Tt][Hh]|[Ss][Ii][Gg]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Xx]-[Aa][Mm][Zz]-([Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Ss][Ee][Cc][Uu][Rr][Ii][Tt][Yy]-[Tt][Oo][Kk][Ee][Nn]|[Ss][Ii][Gg][Nn][Aa][Tt][Uu][Rr][Ee]))[[:space:]]*=[[:space:]]*)[^&[:space:],;]+#\1[redacted]#g' \
      -e 's#eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_.-]+#[redacted]#g' \
      -e 's#(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}#[redacted]#g' \
      -e 's#(sk-|nvapi-|hf_)[A-Za-z0-9._-]{12,}#[redacted]#g' \
    | LC_ALL=C tr '\012' ' '
}

resolver_sanitize_pull_diagnostic() {
  resolver_canonicalize_pull_diagnostic_records \
    | resolver_sanitize_canonical_pull_diagnostic
}

resolver_emit_pull_diagnostic() {
  local diagnostic="$1" truncated="$2"
  if [[ -z "$diagnostic" ]]; then
    echo "docker pull: command failed without diagnostic output" >&2
  else
    if ((${#diagnostic} > 500)); then
      diagnostic="${diagnostic: -500}"
    fi
    printf 'docker pull: %.500s\n' "$diagnostic" >&2
  fi

  if [[ "$truncated" == 1 ]]; then
    echo "docker pull: diagnostic truncated to final ${RESOLVER_PULL_DIAGNOSTIC_BYTE_LIMIT} bytes" >&2
  fi
}

resolver_pull_diagnostic_is_deterministic() {
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
    return 0
  fi
  return 1
}

resolver_pull_diagnostic_is_transient() {
  local diagnostic normalized
  diagnostic="${1:-}"
  normalized="$(printf '%s' "$diagnostic" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  [[ -n "$normalized" ]] || return 1
  resolver_pull_diagnostic_is_deterministic "$diagnostic" && return 1

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

resolver_collect_pull_diagnostic_cleanup() {
  if [[ -n "${counter_pid:-}" ]]; then
    kill "$counter_pid" 2>/dev/null || true
    wait "$counter_pid" 2>/dev/null || true
  fi
  if [[ -n "${collector_raw_file:-}" ]]; then
    rm -f -- "$collector_raw_file"
  fi
}

resolver_collect_pull_diagnostic() (
  local collector_count_fifo="$1" collector_count_file="$2"
  local collector_raw_file="$3" collector_diagnostic_file="$4"
  local counter_pid="" pipeline_status=0 counter_status=0 byte_count

  set -o pipefail
  trap resolver_collect_pull_diagnostic_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  LC_ALL=C wc -c <"$collector_count_fifo" >"$collector_count_file" &
  counter_pid=$!
  if LC_ALL=C tee "$collector_count_fifo" \
    | LC_ALL=C tail -c "$RESOLVER_PULL_DIAGNOSTIC_BYTE_LIMIT" >"$collector_raw_file"; then
    pipeline_status=0
  else
    pipeline_status=$?
  fi
  if wait "$counter_pid"; then
    counter_status=0
  else
    counter_status=$?
  fi
  counter_pid=""
  ((pipeline_status == 0 && counter_status == 0)) || exit 74

  byte_count="$(LC_ALL=C tr -d '[:space:]' <"$collector_count_file")" || exit 74
  [[ "$byte_count" =~ ^[0-9]+$ ]] || exit 74
  if ((byte_count > RESOLVER_PULL_DIAGNOSTIC_BYTE_LIMIT)); then
    # A bounded tail can begin inside a credential value. Drop that partial
    # record and any folded continuations before sanitizing so an omitted
    # header cannot expose its suffix.
    if ! resolver_canonicalize_pull_diagnostic_records <"$collector_raw_file" \
      | LC_ALL=C awk '
          !discarded {
            if (length($0) == 0) next
            discarded = 1
            skip_continuations = 1
            next
          }
          skip_continuations && /^[ \t]/ { next }
          { skip_continuations = 0; print }
        ' \
      | resolver_sanitize_canonical_pull_diagnostic \
      | LC_ALL=C tail -c "$RESOLVER_PULL_DIAGNOSTIC_BYTE_LIMIT" >"$collector_diagnostic_file"; then
      exit 74
    fi
  elif ! resolver_sanitize_pull_diagnostic <"$collector_raw_file" \
    | LC_ALL=C tail -c "$RESOLVER_PULL_DIAGNOSTIC_BYTE_LIMIT" >"$collector_diagnostic_file"; then
    exit 74
  fi

  rm -f -- "$collector_raw_file"
  collector_raw_file=""
)

resolver_capture_pull_cleanup() {
  if [[ -n "${collector_pid:-}" ]]; then
    kill "$collector_pid" 2>/dev/null || true
    wait "$collector_pid" 2>/dev/null || true
  fi
  if [[ -n "${capture_dir:-}" ]]; then
    rm -f -- "$diagnostic_file" "$raw_file" "$count_file" "$count_fifo" "$stderr_fifo"
    rmdir -- "$capture_dir" 2>/dev/null || true
  fi
}

resolver_capture_pull() (
  local ref="$1" capture_dir="" diagnostic_file raw_file count_file count_fifo stderr_fifo
  local collector_pid="" byte_count collector_status status truncated=0
  local temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

  # The collector continuously drains Docker stderr, retains only its final
  # 64 KiB in a mode-0700 directory, and removes the mode-0600 raw tail before
  # any diagnostic enters the parent shell.
  umask 077
  capture_dir="$(mktemp -d "${temp_root%/}/nemoclaw-docker-pull.XXXXXX")" || exit 74
  diagnostic_file="$capture_dir/diagnostic"
  raw_file="$capture_dir/raw-tail"
  count_file="$capture_dir/byte-count"
  count_fifo="$capture_dir/count.fifo"
  stderr_fifo="$capture_dir/stderr.fifo"
  trap resolver_capture_pull_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  mkfifo "$count_fifo" "$stderr_fifo" || exit 74
  resolver_collect_pull_diagnostic \
    "$count_fifo" "$count_file" "$raw_file" "$diagnostic_file" <"$stderr_fifo" &
  collector_pid=$!

  if docker pull "$ref" >/dev/null 2>"$stderr_fifo"; then
    status=0
  else
    status=$?
  fi

  if wait "$collector_pid"; then
    collector_status=0
  else
    collector_status=$?
  fi
  collector_pid=""
  ((collector_status == 0)) || exit 74

  byte_count="$(LC_ALL=C tr -d '[:space:]' <"$count_file")" || exit 74
  [[ "$byte_count" =~ ^[0-9]+$ ]] || exit 74
  if ((byte_count > RESOLVER_PULL_DIAGNOSTIC_BYTE_LIMIT)); then
    truncated=1
  fi

  printf '%s\n%s\n' "$status" "$truncated"
  LC_ALL=C head -c "$RESOLVER_PULL_DIAGNOSTIC_BYTE_LIMIT" "$diagnostic_file"
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

    if resolver_pull_diagnostic_is_deterministic "$diagnostic"; then
      return "$status"
    fi
    if ! resolver_pull_diagnostic_is_transient "$diagnostic"; then
      if [[ "$truncated" == 1 ]]; then
        echo "::error::Truncated base-image pull diagnostics were not classifiable; refusing a local build fallback" >&2
        exit 75
      fi
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
