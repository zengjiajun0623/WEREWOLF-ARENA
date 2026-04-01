// LLM brain — uses any OpenAI-compatible chat API.
// Works with: Claude (via proxy), OpenAI, local models, anything that speaks /v1/chat/completions.
//
// Env vars:
//   LLM_BASE_URL  — API base URL (default: https://api.openai.com/v1)
//   LLM_API_KEY   — API key
//   LLM_MODEL     — model name (default: gpt-4o)
//   STRATEGY_FILE  — path to strategy.md (optional)
//   MEMORY_DIR     — path to memory/ directory (optional)

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import type { Brain, GameContext, Message } from "./brain.js";

function short(addr: string): string { return addr?.slice(0, 10) || "???"; }

const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o";
const STRATEGY_FILE = process.env.STRATEGY_FILE || "";
const MEMORY_DIR = process.env.MEMORY_DIR || "";

// ── Load operator files ─────────────────────────────────────────────────────

function loadStrategy(): string {
  if (!STRATEGY_FILE) return "";
  try {
    const content = readFileSync(STRATEGY_FILE, "utf-8").trim();
    if (content) console.log(`Loaded strategy: ${STRATEGY_FILE}`);
    return content;
  } catch { return ""; }
}

function loadMemories(): string {
  if (!MEMORY_DIR || !existsSync(MEMORY_DIR)) return "";
  try {
    const files = readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md")).sort().slice(-10);
    if (files.length === 0) return "";
    const memories = files
      .map((f) => { try { return readFileSync(join(MEMORY_DIR, f), "utf-8").trim(); } catch { return ""; } })
      .filter(Boolean);
    if (memories.length > 0) console.log(`Loaded ${memories.length} game memories`);
    return `\n\n## Lessons from past games\n${memories.join("\n---\n")}`;
  } catch { return ""; }
}

const strategy = loadStrategy();
const memories = loadMemories();

// ── LLM call ────────────────────────────────────────────────────────────────

async function chat(system: string, user: string): Promise<string> {
  try {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 400,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.slice(0, 750) || fallback();
  } catch {
    return fallback();
  }
}

function fallback(): string {
  const lines = [
    "The voting patterns are telling. Let's look closer.",
    "Someone's lying. Their accusations feel rehearsed.",
    "Who benefits most from last night's kill?",
    "The quiet ones are often the most dangerous.",
    "I have a read but I'm waiting for more info.",
  ];
  return lines[Math.floor(Math.random() * lines.length)];
}

// ── Build system prompt ─────────────────────────────────────────────────────

function buildPrompt(ctx: GameContext): string {
  let prompt = `You are an AI agent playing Werewolf. Address: ${short(ctx.myAddress)}.
Role: ${ctx.myRole}. Round: ${ctx.round}. Alive: ${ctx.alivePlayers.map(short).join(", ")}.
Rules: 7 players — 2 werewolves, 1 seer, 1 doctor, 3 villagers.
Night: wolves kill, seer inspects, doctor protects. Day: discuss, then vote to eliminate.
Villagers win when all wolves dead. Wolves win when wolves ≥ non-wolves.
Keep responses under 600 characters. Be specific — reference player addresses.`;

  if (ctx.myRole === "Werewolf") {
    prompt += `\nYou are a WEREWOLF. Teammate: ${ctx.teammates.map(short).join(", ")}. Act like a villager.`;
  } else if (ctx.myRole === "Seer") {
    const findings = [...ctx.knownRoles.entries()].map(([a, w]) => `${short(a)}=${w ? "WOLF" : "safe"}`).join(", ");
    prompt += `\nYou are the SEER. Findings: ${findings || "none"}.`;
  } else if (ctx.myRole === "Doctor") {
    prompt += `\nYou are the DOCTOR. Last protected: ${ctx.lastProtectedTarget ? short(ctx.lastProtectedTarget) : "none"}.`;
  } else {
    prompt += `\nYou are a VILLAGER.`;
  }

  if (strategy) prompt += `\n\n## Operator Strategy\n${strategy}`;
  if (memories) prompt += memories;

  return prompt;
}

function formatTranscript(msgs: Message[]): string {
  if (!msgs.length) return "(no messages)";
  return msgs.map((m) => `[${short(m.sender)}]: ${m.content}`).join("\n");
}

// ── Brain implementation ────────────────────────────────────────────────────

export class LlmBrain implements Brain {
  async speak(ctx: GameContext, transcript: Message[]): Promise<string> {
    return chat(buildPrompt(ctx), `Transcript:\n${formatTranscript(transcript)}\n\nYour turn to speak.`);
  }

  async vote(ctx: GameContext, transcript: Message[], candidates: string[]): Promise<string> {
    const extra = ctx.myRole === "Werewolf" ? `\nVote DIFFERENT from your teammate.` : "";
    const res = await chat(
      buildPrompt(ctx),
      `Transcript:\n${formatTranscript(transcript)}\n\nVote to eliminate. Candidates: ${candidates.map(short).join(", ")}.${extra}\nReply with ONLY the address.`
    );
    return candidates.find((c) => res.includes(c) || res.includes(short(c))) || candidates[0];
  }

  async wolfKill(ctx: GameContext, targets: string[]): Promise<string> {
    const res = await chat(
      buildPrompt(ctx),
      `Choose kill target: ${targets.map(short).join(", ")}. Reply with ONLY the address.`
    );
    return targets.find((t) => res.includes(t) || res.includes(short(t))) || targets[0];
  }

  async seerInspect(ctx: GameContext, targets: string[]): Promise<string> {
    const res = await chat(
      buildPrompt(ctx),
      `Choose player to inspect: ${targets.map(short).join(", ")}. Reply with ONLY the address.`
    );
    return targets.find((t) => res.includes(t) || res.includes(short(t))) || targets[0];
  }

  async doctorProtect(ctx: GameContext, candidates: string[]): Promise<string> {
    const res = await chat(
      buildPrompt(ctx),
      `Choose player to protect: ${candidates.map(short).join(", ")}. Reply with ONLY the address.`
    );
    return candidates.find((c) => res.includes(c) || res.includes(short(c))) || candidates[0];
  }

  async wolfChat(ctx: GameContext, targets: string[]): Promise<string> {
    return chat(
      buildPrompt(ctx),
      `Private wolf chat. Targets: ${targets.map(short).join(", ")}. Coordinate kill and vote split. 2-3 sentences.`
    );
  }

  async onGameOver(ctx: GameContext, winner: string, roles: Record<string, string>, didWin: boolean): Promise<void> {
    if (!MEMORY_DIR) return;

    mkdirSync(MEMORY_DIR, { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const filename = join(MEMORY_DIR, `${ts}.md`);

    let reflection: string;
    try {
      reflection = await chat(
        "Write 3-5 bullet points of strategic lessons from this Werewolf game. Be specific and actionable.",
        `Result: ${winner} won. I was ${ctx.myRole}, I ${didWin ? "won" : "lost"}.\nRoles: ${Object.entries(roles).map(([a, r]) => `${short(a)}=${r}`).join(", ")}`
      );
    } catch {
      reflection = `- ${didWin ? "Won" : "Lost"} as ${ctx.myRole}. ${winner} won.`;
    }

    writeFileSync(filename, `# Game — ${ts}\nRole: ${ctx.myRole} | ${didWin ? "WIN" : "LOSS"} | ${winner} won\n\n${reflection}\n`);
    console.log(`Memory saved: ${filename}`);
  }
}
