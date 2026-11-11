#!/bin/bash
# Run detached on the machine that holds the runs. Gives every harness container (agent and grading, both sides) the same memory limit,
# so one runaway test process cannot take the whole machine. The kernel then ends the largest process inside that
# container only. Added during the main run at 22:14Z Nov 10 after a test process in one run reached 34 GB.
# Usage: nohup setsid bash harness/memguard.sh >/dev/null 2>&1 &     (log: logs/memguard.log)
limit="${MEMGUARD_LIMIT:-8g}"
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
exec 9> locks/memguard.lock
flock -n 9 || exit 0
echo "$(date -u +%FT%TZ) memguard started, limit $limit per container" >> logs/memguard.log
while true; do
  for id in $(docker ps -q --filter name=^c0-); do
    line=$(docker inspect --format '{{.Name}} {{.HostConfig.Memory}}' "$id" 2>/dev/null) || continue
    set -- $line
    if [ "$2" = "0" ]; then
      if docker update --memory "$limit" --memory-swap "$limit" "$id" >/dev/null 2>&1; then
        echo "$(date -u +%FT%TZ) limit $limit set on ${1#/}" >> logs/memguard.log
      else
        echo "$(date -u +%FT%TZ) could not set the limit on ${1#/}" >> logs/memguard.log
      fi
    fi
  done
  # Containers the kernel ended a process in since the last look.
  for id in $(docker ps -q --filter name=^c0-); do
    events="/sys/fs/cgroup/system.slice/docker-$(docker inspect --format '{{.Id}}' "$id").scope/memory.events"
    [ -r "$events" ] || continue
    kills=$(awk '$1=="oom_kill"{print $2}' "$events")
    name=$(docker inspect --format '{{.Name}}' "$id"); name="${name#/}"
    seen_file="locks/memguard-kills-$name"
    seen=$(cat "$seen_file" 2>/dev/null || echo 0)
    if [ "${kills:-0}" -gt "$seen" ]; then
      echo "$(date -u +%FT%TZ) memory limit reached in $name: $kills processes ended so far" >> logs/memguard.log
      echo "$kills" > "$seen_file"
    fi
  done
  sleep 10
done
