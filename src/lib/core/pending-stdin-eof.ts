// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** How long to let a queued terminal read complete before a prompt starts. */
export const PENDING_STDIN_WINDOW_MS = 10;

interface PendingStdinInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
}

/**
 * Recover a Ctrl-D that reached the terminal while no prompt was reading.
 *
 * Interactive prompts own stdin only while a question is outstanding: each
 * prompt pauses stdin when it settles so onboarding steps between questions
 * (and any child process sharing the terminal) are not competing for input.
 * A Ctrl-D typed inside one of those gaps — the reporter's "close stdin"
 * while the Ollama model loads and the configuration summary prints — stays
 * queued in the terminal, because nothing is reading it yet.
 *
 * The next prompt never sees it. `readline.createInterface()` switches a TTY
 * to raw mode before its first read, and the queued end-of-file indication
 * does not survive that mode change; in raw mode the byte would no longer
 * mean EOF either. The prompt therefore waits for an answer that can never
 * arrive: `nemoclaw onboard` hangs at `Choose [1]:` instead of reporting the
 * cancellation and exiting non-zero (#12169). A Ctrl-D typed while the
 * question is on screen is unaffected — that one reaches readline directly.
 *
 * Reading stdin for one queued-read window before the prompt takes over
 * surfaces the pending EOF as a normal stream `end`. Anything that is real
 * input instead (type-ahead) is pushed back so the prompt still answers with
 * it. Only a TTY needs this: a pipe or `< /dev/null` reports its EOF through
 * the same stream end whenever the prompt gets around to reading, so those
 * callers are left completely untouched.
 *
 * Returns `false` — synchronously, not a promise — when there is nothing to
 * recover, so every non-TTY caller keeps today's exact prompt timing and only
 * a real terminal pays the window. Otherwise resolves `true` when stdin ended
 * during the window, meaning the caller must cancel instead of asking its
 * question.
 */
export function takePendingStdinEof(
  input: PendingStdinInput = process.stdin,
  windowMs: number = PENDING_STDIN_WINDOW_MS,
): Promise<boolean> | false {
  if (input.isTTY !== true) return false;
  return new Promise((resolve) => {
    const chunks: Array<string | Uint8Array> = [];
    let settled = false;

    function onData(chunk: string | Uint8Array): void {
      chunks.push(chunk);
    }

    function finish(ended: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      if (typeof input.pause === "function") input.pause();
      // Restore type-ahead in arrival order. After `end` the stream rejects
      // unshift(), and the buffered text is moot anyway: the caller cancels.
      if (!ended) {
        for (let index = chunks.length - 1; index >= 0; index -= 1) {
          input.unshift(chunks[index]);
        }
      }
      resolve(ended);
    }

    function onEnd(): void {
      finish(true);
    }

    // Deliberately ref'd: an unref'd window would let the process exit
    // mid-prompt, which is the silent exit-0 shape of this very bug.
    const timer = setTimeout(() => finish(false), windowMs);
    input.on("data", onData);
    // Both settle the prompt readers, so both count as a closed stdin here.
    input.once("end", onEnd);
    input.once("close", onEnd);
    if (typeof input.resume === "function") input.resume();
  });
}

/** The rejection every prompt uses for a stdin EOF that arrived before an answer. */
export function pendingStdinEofError(): Error {
  return Object.assign(new Error("Prompt closed before input"), { code: "EOF" });
}
