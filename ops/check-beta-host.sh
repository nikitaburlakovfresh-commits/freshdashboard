#!/usr/bin/env bash
# Read-only, run on the deployment host. No installation or cleanup.
set -euo pipefail
total_kib=$(awk '/MemTotal:/ {print $2}' /proc/meminfo)
available_kib=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
free_kib=$(df -Pk /opt/fresh 2>/dev/null | awk 'NR==2 {print $4}')
printf 'HOST_MEMORY_TOTAL_KIB=%s\nHOST_MEMORY_AVAILABLE_KIB=%s\n' "$total_kib" "$available_kib"
# Conservative engineering gate, not an approved business capacity model:
# app 2304MiB + updater 1536MiB + DB 1024MiB + proxy128MiB + OS/headroom.
# 8GiB provisioning recommended. A host with less than 6GiB is not accepted.
if (( total_kib < 6*1024*1024 )); then
  printf 'BLOCKED: beta AV composition requires at least 6 GiB; recommend 8 GiB.\n'
  exit 1
fi
if [[ -z "$free_kib" ]] || (( free_kib < 8*1024*1024 )); then
  printf 'BLOCKED: require at least 8 GiB free at /opt/fresh for images and rehearsal backups.\n'
  exit 1
fi
printf 'STATIC_HOST_BUDGET_OK: still requires representative concurrent-load measurement.\n'
