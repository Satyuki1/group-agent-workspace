#!/usr/bin/env python3
"""Run on the deployment host once; output contains no secret values."""
import os
import ipaddress
import pathlib
import secrets
from cryptography.hazmat.primitives.asymmetric import ec

host = str(ipaddress.IPv4Address(os.environ["GROUP_AGENT_HOST"]))
ROOT = pathlib.Path("/mnt/group-agent")
DEST = ROOT / "secrets"
DEST.mkdir(mode=0o700, exist_ok=True)

def write(name, body):
    path = DEST / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(body)

if (DEST / "compose.env").exists():
    raise SystemExit("Secrets already exist; refusing to rotate them implicitly")

owner = ec.generate_private_key(ec.SECP256K1())
owner_private = f"{owner.private_numbers().private_value:064x}"
owner_public = f"{owner.public_key().public_numbers().x:064x}"
values = {key: secrets.token_hex(24) for key in (
    "POSTGRES_PASSWORD", "APP_DB_PASSWORD", "REDIS_PASSWORD", "BUZZ_S3_SECRET_KEY"
)}
values["GROUP_AGENT_HOST"] = host
values["BUZZ_S3_ACCESS_KEY"] = "ga-" + secrets.token_hex(8)
write("compose.env", "".join(f"{k}={v}\n" for k,v in values.items()))
write("vault.key", secrets.token_hex(32) + "\n")
write("owner.key", owner_private + "\n")
write("relay.env", "\n".join([
    f"RELAY_URL=wss://{host}:18444",
    f"BUZZ_MEDIA_BASE_URL=https://{host}:18444/media",
    f"BUZZ_MEDIA_SERVER_DOMAIN={host}:18444",
    f"BUZZ_CORS_ORIGINS=https://{host}:18443,http://127.0.0.1:1470",
    "BUZZ_REQUIRE_AUTH_TOKEN=true", "BUZZ_REQUIRE_RELAY_MEMBERSHIP=true",
    "BUZZ_ALLOW_NIP_OA_AUTH=true", "BUZZ_AUTO_MIGRATE=true",
    "BUZZ_GIT_CONFORMANCE_PROBE=true", "BUZZ_PUSH_ENABLED=false",
    "RELAY_OWNER_PUBKEY=" + owner_public,
    "BUZZ_RELAY_PRIVATE_KEY=" + secrets.token_hex(32),
    "BUZZ_GIT_HOOK_HMAC_SECRET=" + secrets.token_hex(32),
    "RUST_LOG=buzz_relay=info,buzz_db=info,buzz_auth=info,buzz_pubsub=info,tower_http=warn", ""
]))
print("Deployment secrets initialized. Existing values were not printed.")
