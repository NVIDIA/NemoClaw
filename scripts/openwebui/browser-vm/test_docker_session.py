import asyncio, logging, os, re, sys, time, uuid, subprocess
src = open("relay/relay.py").read()
lines = src.split("\n")
start = next(i for i,l in enumerate(lines) if l.startswith("class DockerSession:"))
end   = next(i for i,l in enumerate(lines) if l.startswith("async def _docker_native_handler"))
ds_src = "\n".join(lines[start:end])

ns = {"__name__":"relaytest"}
exec(compile("\n".join([
  "import asyncio,os,re,subprocess,sys,time,uuid,logging",
  "log=logging.getLogger('t')",
  "def log_info(*a,**k): pass",
  "DOCKER_SHELL='/bin/bash'",
  "DOCKER_TARGET=''",
  "DOCKER_CWD_DEFAULT='/root'",
  "DOCKER_CONNECT_TIMEOUT=15",
  "DOCKER_SCROLLBACK_BYTES=262144",
  "EXEC_TIMEOUT_GRACE_SECONDS=5",
  "class RelayInternalError(Exception): pass",
  "class ExecTimedOut(RelayInternalError): pass",
  'def _q(p): return "\'" + str(p).replace("\'", "\'\\\\\'\'") + "\'"',
  ds_src,
]), "DockerSession", "exec"), ns)
DockerSession = ns["DockerSession"]

async def main():
    s = DockerSession("t"); await s.connect()
    print("connected ready=%s" % s.ready)
    cases = [
        ("echo hello-from-pty", "/root", 0),
        ("id -u; pwd",          None,   0),
        ("echo multi; echo line",None,   0),
        ("printf 'a\\tb\\n'",     None,   0),
        ("exit 7",               None,   7),   # must NOT kill the session
        ("echo still-alive",     None,   0),   # proves the session survived
        ("nosuchcmd_xyz",        None, 127),  # non-zero from a real failure
    ]
    ok = True
    for cmd, cwd, want in cases:
        try:
            r = await s.run(cmd, 15000, cwd)
        except Exception as e:
            print("  FAIL %-22r raised %s" % (cmd, type(e).__name__)); ok=False; continue
        good = (r["exit"] == want)
        ok &= good
        print("  %s %-22r exit=%-3s want=%-3s stdout=%r" % ("ok " if good else "BAD", cmd, r["exit"], want, r["stdout"][:60]))
    await s.close()
    print("closed OK")
    print("RESULT:", "PASS" if ok else "FAIL")

asyncio.run(main())
