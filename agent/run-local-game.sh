#!/bin/bash
# Run a local Werewolf game with 7 AI agents
#
# Usage:
#   LLM_API_KEY=sk-... ./run-local-game.sh [strategy_dir_1] [strategy_dir_2] ...
#
# Each strategy dir should contain strategy.md and optionally memory/.
# Agents without a dir use no strategy (default play).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELAY_URL="${RELAY_URL:-ws://localhost:8080}"

# Collect strategy dirs from args
DIRS=()
for arg in "$@"; do
  DIRS+=("$(cd "$arg" 2>/dev/null && pwd || echo "")")
done
while [ ${#DIRS[@]} -lt 7 ]; do
  DIRS+=("")
done

lsof -ti:8080 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

echo "Starting relay..."
cd "$SCRIPT_DIR/../relay"
npx tsx src/server.ts &
sleep 2

echo "Launching 7 agents..."
PIDS=()

for i in $(seq 0 6); do
  ADDR="0xAgent$((i+1))_$(openssl rand -hex 14)"
  DIR="${DIRS[$i]}"

  STRATEGY_ARG=""
  MEMORY_ARG=""
  LABEL="default"

  if [ -n "$DIR" ] && [ -d "$DIR" ]; then
    LABEL="$(basename "$DIR")"
    [ -f "$DIR/strategy.md" ] && STRATEGY_ARG="$DIR/strategy.md"
    [ -d "$DIR/memory" ] && MEMORY_ARG="$DIR/memory"
  fi

  echo "  Agent $((i+1)): $LABEL"

  cd "$SCRIPT_DIR"
  RELAY_URL=$RELAY_URL \
  AGENT_ADDRESS=$ADDR \
  STRATEGY_FILE=$STRATEGY_ARG \
  MEMORY_DIR=$MEMORY_ARG \
  LLM_API_KEY="${LLM_API_KEY:-}" \
  LLM_BASE_URL="${LLM_BASE_URL:-}" \
  LLM_MODEL="${LLM_MODEL:-}" \
  npx tsx play.ts &
  PIDS+=($!)
  sleep 0.5
done

echo ""
echo "Game starting. Press Ctrl+C to stop."

trap 'echo "Stopping..."; kill $(jobs -p) 2>/dev/null; exit 0' SIGINT SIGTERM
wait
