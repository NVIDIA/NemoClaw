<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deep Agents Code Terminal

The author enables `harness.settings.interfaces.terminal`, as [docs/interfaces.md](../../../../docs/interfaces.md#open-deep-agents-codes-terminal) documents.
Apply prints the command that opens `dcode`'s terminal UI with the current runtime's launcher, and no forward or token.
In a terminal, the UI uses the configured model and answers a prompt; Ctrl-D quits it.

## Sub-features

- **DT1:** Apply lists `assistant/terminal` under **Agent interfaces** with an `Open` command, its `noexec` form, and `Sign in:  none…`.
- **DT2:** The `Open` command starts `dcode`'s terminal UI on the configured model, which answers a prompt with the requested word.
- **DT3:** Ctrl-D ends the session with exit status 0.
- **DT4:** After a sandbox replacement, the old launcher no longer exists, and the `Open` command from the latest apply works.

## How to get to it (user POV)

- The `Open` command apply prints, run from a terminal on the client host with the gateway and workspace selected; the `sh` form for an artifacts directory mounted `noexec`.
- `openshell sandbox connect` attaches to the sandbox's main process, not a shell, so it can't open the terminal UI.

## Driving it with the OpenShell CLI and util-linux `script`

Preconditions: [deploy-and-answer](deploy-and-answer.md)'s DA1 passed with the agent file's YAML edits; util-linux's `script` and `python3` are on the host.

The terminal UI needs a terminal; `script` gives it a 40-by-120 pseudo-terminal, and this driver types into it and reads the screen, as the `interfaces_live` test does:

```sh
cat > "$RUN_DIR/terminal.py" <<'PY'
import os, re, subprocess, sys, threading, time
command, word, transcript, home = sys.argv[1:5]
env = dict(os.environ, HOME=home, XDG_CONFIG_HOME=os.path.join(home, ".config"))
env.pop("OPENSHELL_GATEWAY", None)
child = subprocess.Popen(["script", "--quiet", "--flush", "--return", "--command",
                          f"stty rows 40 cols 120 && exec {command}", "/dev/null"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
screen, lock = bytearray(), threading.Lock()
def read():
    while chunk := child.stdout.read1(65536):
        with lock:
            screen.extend(chunk)
threading.Thread(target=read, daemon=True).start()
ansi = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78DEHM]")
def text(since=0):
    with lock:
        return ansi.sub(b"", bytes(screen[since:])).decode("utf-8", "replace")
def mark():
    with lock:
        return len(screen)
def send(keys):
    child.stdin.write(keys.encode()); child.stdin.flush()
def wait(test, timeout):
    end = time.time() + timeout
    while time.time() < end and child.poll() is None:
        if test():
            return True
        time.sleep(0.5)
    return test()
# A new home asks for a name and a model; Escape skips both and keeps the configured model.
first_run = wait(lambda: "Enter to continue" in text() or "Context:" in text(), 120)
send("\x1b"); time.sleep(2)
start = mark(); send(f"Reply with exactly {word}")
wait(lambda: word in text(start), 15)
start = mark(); send("\r")
# The answer is a line holding the word alone; the prompt line also says "Reply with exactly".
answered = wait(lambda: any(line.strip(" \t\u258e\u258c\u2502\u25cf\u2022>") == word for line in text(start).splitlines()), 200)
time.sleep(3); send("\x04")
exited = wait(lambda: child.poll() is not None, 30)
if not exited:
    child.kill()
open(transcript, "w").write(text())
print("ui", "ok" if first_run else "FAIL")
print("reply", "ok" if answered and "Interrupted by user" not in text(start) else "FAIL")
print("exit", child.returncode if exited else "FAIL")
PY
```

1. **DT1:**
   ```sh
   sed -n '/^Agent interfaces:/,/^$/p' "$EVIDENCE/apply.txt" | tee "$EVIDENCE/interfaces.txt"
   OPEN=$(sed -n 's|^    Open:     \(openshell sandbox exec .*\)$|\1|p' "$EVIDENCE/apply.txt")
   echo "$OPEN"
   ```
   Result: `assistant/terminal` with `Open:`, the `noexec` form, and `Sign in:  none…`; then `openshell sandbox exec -n assistant --tty -- /sandbox/artifacts/.fabric/deepagents-code/runtimes/RUNTIME_ID/interfaces/terminal`.
2. **DT2 and DT3:**
   ```sh
   WORD=TERM$(date +%s | tail -c 7)
   TERMINAL_HOME=$(mktemp -d)
   python3 "$RUN_DIR/terminal.py" "$OPEN" "$WORD" "$EVIDENCE/terminal-$WORD.txt" "$TERMINAL_HOME" | tee "$EVIDENCE/terminal.txt"
   rm -rf "$TERMINAL_HOME"
   grep -c 'openai:' "$EVIDENCE/terminal-$WORD.txt"
   ```
   Result: `ui ok`, `reply ok`, `exit 0`; then a nonzero count: the status line names the configured model, such as `openai:nemotron-3.5-super-vl`.
3. **DT4:** after [exposure-change](exposure-change.md) replaced the sandbox:
   ```sh
   script --quiet --return --command "$OPEN" /dev/null < /dev/null 2>&1 | tail -1 | tee "$EVIDENCE/old-launcher.txt"
   OPEN=$(sed -n 's|^    Open:     \(openshell sandbox exec .*\)$|\1|p' "$EVIDENCE/change-apply.txt")
   ```
   Result: `No such file or directory` for the old launcher. Then repeat step 2 with the new `$OPEN` and a new word.

## Gotchas

- The first-run screen appears once per runtime home; a second session in the same runtime goes straight to the prompt. The driver accepts either.
- Sending Ctrl-D before the answer finishes interrupts the turn: the transcript then shows `Interrupted by user`, which the driver counts as a failure.
- The terminal's session is separate from Fabric's invocations: it doesn't show them, and the runtime's own thread can't be resumed while the runtime holds it.
- The launcher refuses to start, printing `This NeMo Fabric runtime is not running.`, when the runtime has stopped.
- `dcode` notes that web search is disabled without a Tavily key; that doesn't affect this feature.
