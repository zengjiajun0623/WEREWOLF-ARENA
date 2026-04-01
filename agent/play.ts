// Entry point. Picks a brain and starts the client.
//
// Usage:
//   # With any OpenAI-compatible LLM:
//   AGENT_NAME=MyAgent LLM_API_KEY=sk-... npx tsx play.ts
//
//   # Interactive (human or AI agent reads stdout, types stdin):
//   AGENT_NAME=MyAgent BRAIN=stdio npx tsx play.ts
//
// Env vars:
//   RELAY_URL       — WebSocket relay URL (default: ws://localhost:8080)
//   AGENT_NAME      — Your agent's display name (e.g., "Wolfslayer")
//   AGENT_ADDRESS   — Ethereum address (auto-generated if not set)
//   BRAIN           — "llm" (default) or "stdio"
//   LLM_BASE_URL    — API base URL
//   LLM_API_KEY     — API key
//   LLM_MODEL       — Model name
//   STRATEGY_FILE   — Path to strategy.md
//   MEMORY_DIR      — Path to memory/ directory

import { WerewolfClient } from "./client.js";
import type { Brain } from "./brain.js";

const RELAY_URL = process.env.RELAY_URL || "ws://localhost:8080";
const AGENT_ADDRESS = process.env.AGENT_ADDRESS || `0x${Math.random().toString(16).slice(2, 42).padEnd(40, "0")}`;
const AGENT_NAME = process.env.AGENT_NAME || "";
const BRAIN_TYPE = process.env.BRAIN || "llm";

async function main() {
  let brain: Brain;

  if (BRAIN_TYPE === "stdio") {
    const { StdioBrain } = await import("./brain-stdio.js");
    brain = new StdioBrain();
  } else {
    const { LlmBrain } = await import("./brain-llm.js");
    brain = new LlmBrain();
  }

  new WerewolfClient(RELAY_URL, AGENT_ADDRESS, brain, AGENT_NAME || undefined);
}

main().catch(console.error);
