#!/usr/bin/env python3
"""The synap box runner: the only program the box template starts on boot.

It holds no credential. It fetches its job from the provisioner by the
provisioner's address on the isolated bridge, installs the declared packages
(setup phase: the egress proxy lets only the package registries through),
tells the provisioner it is done installing (run phase: only the declared
hosts), runs the script as the unprivileged user `box` with /in and /out,
streams the log back, uploads /out and reports the exit code.

The provisioner, not this program, enforces the wall clock: it destroys the box.
Python stdlib only (Debian 12's python3), so the template needs nothing else to
run it. Contract with the provisioner: synap-cli src/lib/box/job-server.ts.
"""

import json
import os
import pwd
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

BASE = os.environ.get("SYNAP_BOX_PROVISIONER", "http://10.20.0.1:8790")
PROXY = os.environ.get("SYNAP_BOX_PROXY", "http://10.20.0.1:3128")
WORK, IN, OUT = "/work", "/in", "/out"
USER = "box"
MAX_OUT_FILES = 20

# The job server is on the bridge: never through the proxy.
_direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(method, path, body=None, ctype="application/json", timeout=60):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", ctype)
    with _direct.open(req, timeout=timeout) as res:
        raw = res.read()
        return json.loads(raw) if raw and res.headers.get("content-type", "").startswith("application/json") else None


def fetch_job():
    # The box may boot before the provisioner registers its address: retry.
    deadline = time.time() + 180
    while True:
        try:
            return call("GET", "/job")
        except Exception as err:  # noqa: BLE001
            if time.time() > deadline:
                raise SystemExit(f"no job from {BASE}: {err}")
            time.sleep(2)


class LogPump:
    """Batches output and POSTs it to /log about twice a second."""

    def __init__(self):
        self.buf = bytearray()
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def write(self, data):
        with self.lock:
            self.buf += data

    def _flush(self):
        with self.lock:
            chunk, self.buf = bytes(self.buf), bytearray()
        if chunk:
            try:
                call("POST", "/log", chunk, "application/octet-stream")
            except Exception:  # noqa: BLE001 - a lost log chunk must not kill the run
                pass

    def _loop(self):
        while not self.stop.wait(0.5):
            self._flush()

    def close(self):
        self.stop.set()
        self.thread.join()
        self._flush()


def demote(user):
    pw = pwd.getpwnam(user)

    def run_as():
        os.setgroups([])
        os.setgid(pw.pw_gid)
        os.setuid(pw.pw_uid)

    return run_as, pw


def run(cmd, env, pump):
    """Run cmd as the box user; its stdout+stderr go to the log. Returns the exit code."""
    pre, pw = demote(USER)
    pump.write(("$ " + " ".join(cmd) + "\n").encode())
    proc = subprocess.Popen(
        cmd, cwd=WORK, env={**env, "HOME": pw.pw_dir, "USER": USER},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, preexec_fn=pre,
    )
    for chunk in iter(lambda: proc.stdout.read1(65536), b""):
        pump.write(chunk)
    return proc.wait()


def installed(job, env):
    try:
        if job["language"] == "python":
            out = subprocess.run(
                ["uv", "pip", "list", "--python", f"{WORK}/.venv/bin/python", "--format", "json"],
                cwd=WORK, env=env, capture_output=True, timeout=60,
            ).stdout
            return [{"name": p["name"], "version": p["version"], "manager": "pip"} for p in json.loads(out or b"[]")]
        out = subprocess.run(
            ["pnpm", "list", "--json", "--depth", "0"], cwd=WORK, env=env, capture_output=True, timeout=60,
        ).stdout
        deps = (json.loads(out or b"[{}]") or [{}])[0].get("dependencies", {}) or {}
        return [{"name": n, "version": d.get("version", ""), "manager": "npm"} for n, d in deps.items()]
    except Exception:  # noqa: BLE001 - the list is evidence, not the verdict
        return []


def upload_out(pump):
    sent = 0
    for root, _dirs, files in os.walk(OUT):
        for name in sorted(files):
            full = os.path.join(root, name)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            rel = os.path.relpath(full, OUT)
            if sent >= MAX_OUT_FILES:
                pump.write(f"\n[synap box] /out/{rel} skipped: at most {MAX_OUT_FILES} files\n".encode())
                continue
            try:
                with open(full, "rb") as fh:
                    call("PUT", "/out/" + urllib.parse.quote(rel), fh.read(), "application/octet-stream", timeout=600)
                sent += 1
            except Exception as err:  # noqa: BLE001
                pump.write(f"\n[synap box] /out/{rel} not uploaded: {err}\n".encode())


def main():
    job = fetch_job()
    pump = LogPump()
    for d in (WORK, IN, OUT):
        os.makedirs(d, exist_ok=True)
    pw = pwd.getpwnam(USER)
    for d in (WORK, OUT):
        os.chown(d, pw.pw_uid, pw.pw_gid)

    entry = os.path.normpath(job["entrypoint"])
    if entry.startswith("..") or os.path.isabs(entry):
        raise SystemExit(f"bad entrypoint {job['entrypoint']!r}")
    os.makedirs(os.path.dirname(os.path.join(WORK, entry)), exist_ok=True)
    with open(os.path.join(WORK, entry), "w") as fh:
        fh.write(job["code"])
    os.chown(os.path.join(WORK, entry), pw.pw_uid, pw.pw_gid)
    with open(os.path.join(IN, "parameters.json"), "w") as fh:
        json.dump(job.get("parameters"), fh)

    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HTTP_PROXY": PROXY, "HTTPS_PROXY": PROXY, "http_proxy": PROXY, "https_proxy": PROXY,
        "npm_config_proxy": PROXY, "npm_config_https_proxy": PROXY,
        # Node's own fetch ignores HTTP(S)_PROXY unless told (Node >= 22.21 / 24).
        "NODE_USE_ENV_PROXY": "1",
        "UV_CACHE_DIR": f"{WORK}/.cache/uv", "npm_config_cache": f"{WORK}/.cache/npm",
        "SYNAP_PARAMETERS_FILE": f"{IN}/parameters.json", "SYNAP_OUT_DIR": OUT,
    }
    pkgs = job.get("packages") or []
    if job["language"] == "python":
        code = run(["uv", "venv", f"{WORK}/.venv"], env, pump)
        if code == 0 and pkgs:
            code = run(["uv", "pip", "install", "--python", f"{WORK}/.venv/bin/python",
                        *[f"{p['name']}=={p['version']}" for p in pkgs]], env, pump)
        cmd = [f"{WORK}/.venv/bin/python", entry]
    else:
        with open(os.path.join(WORK, "package.json"), "w") as fh:
            json.dump({"private": True}, fh)
        os.chown(os.path.join(WORK, "package.json"), pw.pw_uid, pw.pw_gid)
        code = run(["pnpm", "add", *[f"{p['name']}@{p['version']}" for p in pkgs]], env, pump) if pkgs else 0
        cmd = ["node", entry]

    call("POST", "/phase", {"phase": "run"})
    if code == 0:
        code = run(cmd, env, pump)
    else:
        pump.write(f"\n[synap box] packages did not install (exit {code}); the script was not run\n".encode())

    upload_out(pump)
    pump.close()
    call("POST", "/done", {"exitCode": code, "installedPackages": installed(job, env)})


if __name__ == "__main__":
    sys.exit(main())
