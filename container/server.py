#!/usr/bin/env python3
"""HTTP front-end for the Sloptube media container.

Stdlib only. This exists because `socat TCP-LISTEN` piping into a shell
dispatcher is fragile (framing, keep-alive, body draining) and because a shell
HTTP parser would dwarf the actual media logic in media.sh.

The server owns nothing but transport: it parses the request, shells out to
`media.sh <op> <json-body>`, and passes that process's JSON straight through.
media.sh is therefore also runnable on its own for debugging:

    docker run --rm -it sloptube-media /app/media.sh probe '{"r2Key":...}'

Endpoints (contract §"media pipeline"):
    GET  /healthz   liveness only; not a media operation
    POST /probe     -> { sha256, bytes, durationS, width, height, videoCodec,
                         audioCodec, ok, reason }
    POST /transcode -> { segment, bytes, durationS, initBytes, r2Key, ok, reason }
    POST /scan      -> { verdict: "clean"|"infected", signature? }

Credentials are read from the request body per call and are never persisted.
"""

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.environ.get("APP_DIR", "/app")
MEDIA_SH = os.path.join(APP_DIR, "media.sh")
PORT = int(os.environ.get("PORT", "8080"))
HARD_TIMEOUT = int(os.environ.get("MEDIA_TIMEOUT", "600"))

# Bodies are JSON credentials, never media. 1 MiB is far more than enough.
MAX_BODY = 1024 * 1024

OPERATIONS = {"probe", "transcode", "scan"}

STATUS_BY_REASON = {
    "invalid_request": 400,
    "invalid_key": 400,
    "unknown_operation": 400,
    "payload_too_large": 413,
    "download_failed": 502,
    "upload_failed": 502,
    "sign_failed": 500,
    "ffprobe_failed": 422,
    "transcode_failed": 422,
    "scan_failed": 502,
    "scan_timeout": 504,
    "container_timeout": 504,
    "worker_unavailable": 500,
}


class Handler(BaseHTTPRequestHandler):
    server_version = "sloptube-media/1"
    sys_version = ""

    def log_message(self, fmt, *args):  # keep container logs quiet and structured
        sys.stderr.write("media %s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._send(200, {"ok": True, "reason": "alive"})
        else:
            self._send(404, {"ok": False, "reason": "not_found"})

    def do_POST(self) -> None:
        operation = self.path.rsplit("/", 1)[-1]
        if operation not in OPERATIONS:
            self._send(404, {"ok": False, "reason": "not_found"})
            return

        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self._send(400, {"ok": False, "reason": "invalid_request"})
            return
        if length > MAX_BODY:
            self._send(413, {"ok": False, "reason": "payload_too_large"})
            return

        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send(400, {"ok": False, "reason": "invalid_json"})
            return
        if not isinstance(body, dict):
            self._send(400, {"ok": False, "reason": "invalid_json"})
            return

        try:
            # The body goes in on stdin, not as an argv element: the JSON carries
            # R2 credentials, and /proc/<pid>/cmdline is readable by the ffmpeg
            # child process that runs as the same user.
            proc = subprocess.run(
                [MEDIA_SH, operation],
                input=json.dumps(body),
                capture_output=True,
                text=True,
                timeout=HARD_TIMEOUT + 30,
            )
        except subprocess.TimeoutExpired:
            self._send(504, {"ok": False, "reason": "container_timeout"})
            return
        except OSError as err:
            # media.sh missing, or not executable. Answer with JSON rather than
            # letting the exception tear down the connection.
            self._send(500, {"ok": False, "reason": "worker_unavailable", "detail": str(err)[:200]})
            return

        # media.sh prints exactly one JSON object on stdout in every case,
        # success or failure. If it somehow did not, surface its stderr.
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError:
            self._send(
                500,
                {
                    "ok": False,
                    "reason": "worker_crashed",
                    "detail": (proc.stderr or "")[-300:],
                },
            )
            return

        if payload.get("ok"):
            self._send(200, payload)
            return
        reason = str(payload.get("reason", "failed"))
        self._send(STATUS_BY_REASON.get(reason, 500), payload)


def main() -> int:
    if not os.access(MEDIA_SH, os.X_OK):
        sys.stderr.write(f"server: {MEDIA_SH} is not executable\n")
        return 1
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())