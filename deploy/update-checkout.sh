#!/usr/bin/env bash
set -euo pipefail
project=/root/platforms/projects/nasa-space-apps
export GIT_SSH_COMMAND="ssh -i $project/shared/keys/github-readonly -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$project/shared/keys/known_hosts"
git -c safe.directory="$project/repository" -C "$project/repository" fetch origin main
git -c safe.directory="$project/repository" -C "$project/repository" merge --ff-only origin/main
# Preserve a verifiable revision alongside the shared data and in deployment logs.
git -c safe.directory="$project/repository" -C "$project/repository" rev-parse HEAD
if docker image inspect nasa-space-apps-web:current >/dev/null 2>&1; then
    docker image tag nasa-space-apps-web:current nasa-space-apps-web:rollback
fi
