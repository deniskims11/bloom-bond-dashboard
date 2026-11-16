#!/usr/bin/env python3
"""Encrypt public/data/latest.json so the published site only serves ciphertext.

Reads the password from DASHBOARD_PASSWORD. Without it the script exits with an
error, so the deploy fails and the live site keeps its previous (encrypted)
version instead of publishing readable data.

Output keeps the same path (data/latest.json) with only `generated_at` in the
clear (the deploy gate reads it). The browser asks for the password and decrypts
with Web Crypto: PBKDF2-SHA256 -> AES-256-GCM over the gzipped JSON.
"""
import base64, gzip, hashlib, json, os, pathlib, shutil, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data"
ITERATIONS = 600_000
# Fixed per-site salt so a browser can remember the derived key between refreshes.
SALT = hashlib.sha256(b"bloom-bond-dashboard/v1").digest()[:16]


def main():
    pw = os.environ.get("DASHBOARD_PASSWORD", "")
    if not pw:
        sys.exit("DASHBOARD_PASSWORD is not set; refusing to publish unencrypted data")
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "cryptography"], check=True)
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    src = OUT / "latest.json"
    raw = src.read_bytes()
    meta = json.loads(raw)
    if meta.get("encrypted"):
        sys.exit("latest.json is already encrypted")
    # Copy for the Claude connector (bb-dashboard-mcp): same data, its own key (repo
    # secret MCP_KEY, 32 random bytes base64url). The connector URL carries that key.
    mk = os.environ.get("MCP_KEY", "")
    if mk:
        mkey = base64.urlsafe_b64decode(mk + "=" * (-len(mk) % 4))
        miv = os.urandom(12)
        keep = ["ad_name", "new_ad_name", "batch_no", "creative_no", "meta_ad_ids", "launch_date",
                "preview_link", "video_url", "thumbnail_url", "dd", "concept", "reason", "angle",
                "sub_angle", "icp", "type", "format", "origin", "awareness_stage", "funnel",
                "landing_page", "profile", "strategist", "writer", "editor", "creator", "agency",
                "maker", "product", "ad_account", "launch_status"]
        slim = {k: meta.get(k) for k in ["generated_at", "brand", "nc_start", "ad_accounts", "scope_note", "days"]}
        slim["ads"] = [{k: a.get(k) for k in keep} for a in meta.get("ads", [])]
        mct = AESGCM(mkey).encrypt(miv, gzip.compress(json.dumps(slim, separators=(",", ":")).encode(), 9), None)
        (OUT / "mcp.json").write_text(json.dumps({"generated_at": meta.get("generated_at"),
            "iv": base64.b64encode(miv).decode(), "data": base64.b64encode(mct).decode()}, separators=(",", ":")))
        print(f"encrypted mcp.json for the Claude connector: {(OUT / 'mcp.json').stat().st_size / 1e6:.1f} MB")
    key = hashlib.pbkdf2_hmac("sha256", pw.encode(), SALT, ITERATIONS, 32)
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, gzip.compress(raw, 9), None)
    b64 = lambda b: base64.b64encode(b).decode()
    src.write_text(json.dumps({
        "encrypted": 1, "generated_at": meta.get("generated_at"),
        "kdf": "PBKDF2-SHA256", "iterations": ITERATIONS, "salt": b64(SALT), "iv": b64(iv),
        "data": b64(ct),
    }, separators=(",", ":")))
    # Plain snapshots must not be published either.
    shutil.rmtree(OUT / "history", ignore_errors=True)
    print(f"encrypted latest.json: {len(raw) / 1e6:.1f} MB -> {src.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
