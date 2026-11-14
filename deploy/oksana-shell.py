#!/usr/bin/python3 -I
"""Root-owned SSH entrypoint: run every Oksana command as her container UID.

Never evaluate client input on the host. Do not install this file in a directory
writable by the SSH user. UID/GID come from the root-owned host configuration.
"""

import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    if len(sys.argv) != 1:
        raise SystemExit("Arguments are not accepted")
    identity = json.loads(Path("/etc/nasa-space-apps/oksana.json").read_text())
    original = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    args = ["/usr/bin/docker", "exec", "-i"]
    if sys.stdin.isatty() and sys.stdout.isatty():
        args.append("-t")
    args += ["--user", f"{identity['uid']}:{identity['gid']}", "--workdir", "/workspace",
             "--env", "HOME=/home/oksana", "--env", "USER=oksana", "--env", "LOGNAME=oksana",
             "nasa-space-apps-oksana"]
    if original in ("internal-sftp", "/usr/lib/openssh/sftp-server"):
        args += ["/usr/lib/openssh/sftp-server", "-d", "/workspace"]
    elif original:
        args += ["/bin/bash", "-c", original]
    else:
        args += ["/bin/bash", "-l"]
    raise SystemExit(subprocess.call(args))


if __name__ == "__main__":
    main()
