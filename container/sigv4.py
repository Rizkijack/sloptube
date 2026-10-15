#!/usr/bin/env python3
"""AWS SigV4 (service=s3) signer that emits a curl config file.

Why not aws-cli: the Debian `awscli` package drags in a very large Python
dependency tree, which defeats the "small public base image" requirement for a
container whose whole job is ffmpeg + clamscan. Hand-rolling the four HMACs is
~40 lines of stdlib, so the image only needs `python3` (already required for the
HTTP front-end) instead of a second Python runtime plus deps.

Why a curl config file and not `curl -H`: the secret never appears in argv of the
curl process, so it cannot leak through `ps` or a crash dump.

Usage:
  SLOPTUBE_AK=<accessKeyId> SLOPTUBE_SK=<secret> \
      sigv4.py <out-curlrc> <METHOD> <URL> <payload-file|-> [region]

Credentials arrive through the **environment**, never argv: `/proc/<pid>/cmdline`
is world-readable, `/proc/<pid>/environ` is readable only by the process owner.
That is a real improvement, not a complete one — see the note in README.md: a
compromised ffmpeg runs as the same uid and can still reach same-uid secrets, so
prefix-scoped R2 credentials remain the follow-up.

The output file is created with mode 0600. It contains one `header = "..."` line
per signed header and nothing else.
"""

import hashlib
import hmac
import os
import stat
import sys
import urllib.parse

ALGO = "AWS4-HMAC-SHA256"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret: str, date: str, region: str, service: str) -> bytes:
    k = _sign(("AWS4" + secret).encode("utf-8"), date)
    k = _sign(k, region)
    k = _sign(k, service)
    return _sign(k, "aws4_request")


def payload_sha256(path: str) -> str:
    if path == "-":
        return EMPTY_SHA256
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def uri_encode(value: str, encode_slash: bool) -> str:
    # RFC 3986 unreserved set; AWS requires '/' to survive in the canonical URI.
    safe = "-_.~" if encode_slash else "-_.~/"
    return urllib.parse.quote(value, safe=safe)


def main(argv: list[str]) -> int:
    # out, method, url, payload[, region] — credentials come from the environment.
    if len(argv) < 5 or len(argv) > 6:
        sys.stderr.write("sigv4: bad argument count\n")
        return 2
    out, method, url, payload = argv[1:5]
    region = argv[5] if len(argv) == 6 else "auto"

    access_key = os.environ.get("SLOPTUBE_AK", "")
    secret = os.environ.get("SLOPTUBE_SK", "")
    if not access_key or not secret:
        sys.stderr.write("sigv4: SLOPTUBE_AK/SLOPTUBE_SK not set\n")
        return 2

    # A newline would let a crafted key inject extra lines into the curl config
    # file written below. Refuse rather than try to escape.
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in url):
        sys.stderr.write("sigv4: refusing to sign a URL containing control characters\n")
        return 2

    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https":
        sys.stderr.write("sigv4: refusing to sign a non-https URL\n")
        return 2
    host = parts.netloc
    # Canonical URI: the raw (still-encoded) path, so encode only what AWS
    # requires to be encoded. Keys are validated by media.sh before we get here.
    canonical_uri = uri_encode(urllib.parse.unquote(parts.path), encode_slash=False)

    now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
    amzdate = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")

    body_hash = payload_sha256(payload)
    headers = {
        "host": host,
        "x-amz-content-sha256": body_hash,
        "x-amz-date": amzdate,
    }
    signed_headers = ";".join(sorted(headers))
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    canonical_request = "\n".join(
        [method, canonical_uri, "", canonical_headers, signed_headers, body_hash]
    )

    scope = f"{datestamp}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        [
            ALGO,
            amzdate,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        signing_key(secret, datestamp, region, "s3"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    auth = (
        f"{ALGO} Credential={access_key}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(f'header = "Authorization: {auth}"\n')
        fh.write(f'header = "x-amz-date: {amzdate}"\n')
        fh.write(f'header = "x-amz-content-sha256: {body_hash}"\n')
        fh.write(f'url = "{url}"\n')
    # Belt and braces: os.open honours umask, force the mode explicitly.
    os.chmod(out, stat.S_IRUSR | stat.S_IWUSR)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))