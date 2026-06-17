#!/usr/bin/env bash
# Waahyu Scheduler control — start/stop/status/restart/once/tail the heartbeat daemon.
#
# Usage:
#   scheduler-ctl.sh start      # start daemon (nohup, detached, PID file)
#   scheduler-ctl.sh stop       # stop daemon
#   scheduler-ctl.sh restart    # stop then start
#   scheduler-ctl.sh status     # show running state + last tick
#   scheduler-ctl.sh once       # run one tick in foreground (test)
#   scheduler-ctl.sh tail       # tail the heartbeat log
#   scheduler-ctl.sh drive      # start daemon WITH AGENT_DRIVER=claude (invokes agents headless — COST!)
#
# Env passthrough: TICK_SECONDS, STALE_1/2/3, MAX_HEARTBEAT_LINES, AGENT_DRIVER

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHED="$ROOT/scripts/agent-scheduler.sh"
RUN_DIR="$ROOT/agent-status"
PID_FILE="$RUN_DIR/.scheduler.pid"
OUT_LOG="$RUN_DIR/scheduler.out.log"

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start() {
  if is_running; then echo "scheduler: already running (pid $(cat "$PID_FILE"))"; return 0; fi
  : > "$OUT_LOG"
  nohup bash "$SCHED" >>"$OUT_LOG" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if is_running; then echo "scheduler: started (pid $(cat "$PID_FILE"), cadence ${TICK_SECONDS:-50}s, driver ${AGENT_DRIVER:-none})";
  else echo "scheduler: FAILED to start — see $OUT_LOG"; tail -5 "$OUT_LOG"; return 1; fi
}

stop() {
  if ! is_running; then echo "scheduler: not running"; rm -f "$PID_FILE"; return 0; fi
  local pid; pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null
  sleep 1
  kill -9 "$pid" 2>/dev/null
  rm -f "$PID_FILE"
  rm -rf "$RUN_DIR/.sched.lock"
  echo "scheduler: stopped (pid $pid)"
}

status() {
  if is_running; then echo "scheduler: RUNNING (pid $(cat "$PID_FILE"))"; else echo "scheduler: STOPPED"; fi
  [ -f "$RUN_DIR/SCHEDULER.md" ] && { echo "---"; cat "$RUN_DIR/SCHEDULER.md"; }
}

case "${1:-status}" in
  start)   start ;;
  drive)   AGENT_DRIVER=claude start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  once)    bash "$SCHED" --once ;;
  tail)    tail -f "$RUN_DIR/HEARTBEAT.md" ;;
  *) echo "usage: scheduler-ctl.sh {start|drive|stop|restart|status|once|tail}"; exit 1 ;;
esac
