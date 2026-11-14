"""Reload nginx only when the renewed NASA certificate differs from the served one.

The existing server-wide Certbot cron renews files. This job makes nginx pick up
the renewed certificate without restarting any project containers.
"""

import hashlib
from pathlib import Path
import socket
import ssl
import subprocess


def main():
    pem = Path("/root/platforms/certbot/live/nasa.aican.cloud/fullchain.pem").read_text()
    first = pem.split("-----END CERTIFICATE-----", 1)[0] + "-----END CERTIFICATE-----\n"
    expected = hashlib.sha256(ssl.PEM_cert_to_DER_cert(first)).digest()
    # Inspect the local server's fingerprint even if its old certificate expired.
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    with socket.create_connection(("127.0.0.1", 443), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname="nasa.aican.cloud") as connection:
            actual = hashlib.sha256(connection.getpeercert(binary_form=True)).digest()
    if actual == expected:
        print("NASA certificate on disk matches the served certificate")
        return
    subprocess.run(["docker", "exec", "nginx", "nginx", "-t"], check=True)
    subprocess.run(["docker", "exec", "nginx", "nginx", "-s", "reload"], check=True)
    print("Reloaded nginx to use the renewed NASA certificate")


if __name__ == "__main__":
    main()
