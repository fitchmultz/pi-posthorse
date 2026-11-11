#!/bin/bash
# Run detached on the machine that holds the runs, beside memguard.sh (which logs every process the kernel ends at a limit).
# Usage: nohup setsid bash harness/memlimit.sh >/dev/null 2>&1 &     (log: logs/memguard.log)
#
# Keeps every harness container (agent and grading, every side) at MEMLIMIT (default 4g), also the containers
# that c0.py starts with 8g. Added 01:32Z Nov 11: with 38 sessions side by side, four jinja runs of the terra
# batch each had a test process growing towards 8 GB at the same moment and the machine had 0.2 GB left.
# When the machine still runs short (less than MEMLOW_MB available), the container that uses the most memory
# gets a 2g limit for one round, which makes the kernel end its largest process.
limit="${MEMLIMIT:-4g}"; low="${MEMLOW_MB:-2000}"
bytes=$(numfmt --from=iec "${limit^^}")
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs locks
exec 9> locks/memlimit.lock
flock -n 9 || exit 0
log() { echo "$(date -u +%FT%TZ) $*" >> logs/memguard.log; }
log "memlimit started, $limit per container, squeeze below $low MB available"
squeezed=""
while true; do
  for id in $(docker ps -q --filter name=^c0-); do
    line=$(docker inspect --format '{{.Name}} {{.HostConfig.Memory}}' "$id" 2>/dev/null) || continue
    set -- $line
    name="${1#/}"
    if [ "$2" != "$bytes" ] && [ "$name" != "$squeezed" ]; then
      docker update --memory "$limit" --memory-swap "$limit" "$id" >/dev/null 2>&1 || log "could not set $limit on $name"
    fi
  done
  squeezed=""
  available=$(awk '$1=="MemAvailable:"{print int($2/1024)}' /proc/meminfo)
  if [ "$available" -lt "$low" ]; then
    top=$(for id in $(docker ps -q --no-trunc --filter name=^c0-); do
      echo "$(cat /sys/fs/cgroup/system.slice/docker-$id.scope/memory.current 2>/dev/null || echo 0) $id"
    done | sort -rn | head -1)
    set -- $top
    if [ "${1:-0}" -gt $((2 * 1024 * 1024 * 1024)) ]; then
      squeezed=$(docker inspect --format '{{.Name}}' "$2"); squeezed="${squeezed#/}"
      docker update --memory 2g --memory-swap 2g "$2" >/dev/null 2>&1
      log "machine short of memory ($available MB available): $squeezed uses $(( $1 / 1048576 )) MB and gets a 2g limit for one round"
    fi
  fi
  sleep 10
done
