function acquireLock() {
  const maxRetries = LOCK_MAX_RETRIES;
  const initialRetryDelay = LOCK_RETRY_MS;
  let retryCount = 0;
  let retryDelay = initialRetryDelay;
  while (retryCount < maxRetries) {
    try {
      fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true, mode: 0o700 });
      const lockDir = LOCK_DIR;
      const ownerFile = LOCK_OWNER;
      const ownerTmp = ownerFile + ".tmp." + process.pid;
      try {
        fs.mkdirSync(lockDir);
        fs.writeFileSync(ownerTmp, String(process.pid), { mode: 0o600 });
        fs.renameSync(ownerTmp, ownerFile);
        return;
      } catch (err) {
        if (err.code !== "EEXIST") {
          throw err;
        }
        // Check if the lock owner is still alive
        let ownerChecked = false;
        try {
          const ownerPid = parseInt(fs.readFileSync(ownerFile, "utf-8").trim(), 10);
          if (Number.isFinite(ownerPid) && ownerPid > 0) {
            ownerChecked = true;
            let alive;
            try {
              process.kill(ownerPid, 0);
              alive = true;
            } catch (killErr) {
              alive = killErr.code === "EPERM";
            }
            if (!alive) {
              const recheck = parseInt(fs.readFileSync(ownerFile, "utf-8").trim(), 10);
              if (recheck === ownerPid) {
                fs.rmSync(lockDir, { recursive: true, force: true });
                retryCount++;
                retryDelay = initialRetryDelay;
                continue;
              }
            }
          }
        } catch {
          // No owner file or lock dir released
        }
        if (!ownerChecked) {
          try {
            const stat = fs.statSync(lockDir);
            if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
              fs.rmSync(lockDir, { recursive: true, force: true });
              retryCount++;
              retryDelay = initialRetryDelay;
              continue;
            }
          } catch {
            retryCount++;
            retryDelay = initialRetryDelay;
            continue;
          }
        }
      } finally {
        try {
          fs.unlinkSync(ownerTmp);
        } catch {
          /* best effort */
        }
      }
      const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sleepBuf, 0, 0, retryDelay);
      retryCount++;
      retryDelay *= 2;
    } catch (err) {
      throw new Error(`Failed to acquire lock on ${REGISTRY_FILE} after ${maxRetries} retries`);
    }
  }
