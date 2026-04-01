// Stdin/stdout brain — prompts are written to stdout, decisions read from stdin.
// Any AI agent (Claude Code, Codex, a human) can drive this.

import * as readline from "readline";
import type { Brain, GameContext, Message } from "./brain.js";

function short(addr: string): string { return addr?.slice(0, 10) || "???"; }

function formatCtx(ctx: GameContext): string {
  let s = `You are ${short(ctx.myAddress)}, role: ${ctx.myRole}. Round ${ctx.round}.`;
  s += `\nAlive: ${ctx.alivePlayers.map(short).join(", ")}`;
  if (ctx.teammates.length > 0) s += `\nTeammates: ${ctx.teammates.map(short).join(", ")}`;
  if (ctx.knownRoles.size > 0) {
    const findings = [...ctx.knownRoles.entries()]
      .map(([a, w]) => `${short(a)}=${w ? "WOLF" : "safe"}`)
      .join(", ");
    s += `\nSeer findings: ${findings}`;
  }
  return s;
}

function formatTranscript(msgs: Message[]): string {
  if (!msgs.length) return "(no messages yet)";
  return msgs.map((m) => `[${short(m.sender)}]: ${m.content}`).join("\n");
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    // Write the prompt as a structured block so AI agents can parse it
    process.stdout.write(`\n--- DECISION NEEDED ---\n${prompt}\n--- END ---\n`);
    rl.once("line", (line) => resolve(line.trim()));
  });
}

export class StdioBrain implements Brain {
  async speak(ctx: GameContext, transcript: Message[]): Promise<string> {
    return ask(
      `${formatCtx(ctx)}\n\nTranscript:\n${formatTranscript(transcript)}\n\nIt's your turn to speak. What do you say? (type your message)`
    );
  }

  async vote(ctx: GameContext, transcript: Message[], candidates: string[]): Promise<string> {
    const response = await ask(
      `${formatCtx(ctx)}\n\nTranscript:\n${formatTranscript(transcript)}\n\nVote to eliminate. Candidates:\n${candidates.map((c, i) => `  ${i + 1}. ${short(c)}`).join("\n")}\n\nType the player address or number:`
    );
    // Support numeric selection
    const num = parseInt(response);
    if (!isNaN(num) && num >= 1 && num <= candidates.length) return candidates[num - 1];
    return candidates.find((c) => response.includes(c) || response.includes(short(c))) || candidates[0];
  }

  async wolfKill(ctx: GameContext, targets: string[]): Promise<string> {
    const response = await ask(
      `${formatCtx(ctx)}\n\nChoose a kill target:\n${targets.map((t, i) => `  ${i + 1}. ${short(t)}`).join("\n")}\n\nType address or number:`
    );
    const num = parseInt(response);
    if (!isNaN(num) && num >= 1 && num <= targets.length) return targets[num - 1];
    return targets.find((t) => response.includes(t) || response.includes(short(t))) || targets[0];
  }

  async seerInspect(ctx: GameContext, targets: string[]): Promise<string> {
    const response = await ask(
      `${formatCtx(ctx)}\n\nChoose a player to inspect:\n${targets.map((t, i) => `  ${i + 1}. ${short(t)}`).join("\n")}\n\nType address or number:`
    );
    const num = parseInt(response);
    if (!isNaN(num) && num >= 1 && num <= targets.length) return targets[num - 1];
    return targets.find((t) => response.includes(t) || response.includes(short(t))) || targets[0];
  }

  async doctorProtect(ctx: GameContext, candidates: string[]): Promise<string> {
    const response = await ask(
      `${formatCtx(ctx)}\n\nChoose a player to protect:\n${candidates.map((c, i) => `  ${i + 1}. ${short(c)}`).join("\n")}\n\nType address or number:`
    );
    const num = parseInt(response);
    if (!isNaN(num) && num >= 1 && num <= candidates.length) return candidates[num - 1];
    return candidates.find((c) => response.includes(c) || response.includes(short(c))) || candidates[0];
  }

  async wolfChat(ctx: GameContext, targets: string[]): Promise<string> {
    return ask(
      `${formatCtx(ctx)}\n\nPrivate wolf chat. Targets to kill: ${targets.map(short).join(", ")}\n\nCoordinate with your teammate:`
    );
  }

  async onGameOver(_ctx: GameContext, winner: string, _roles: Record<string, string>, didWin: boolean): Promise<void> {
    console.log(`\nGame over. ${winner} won. You ${didWin ? "won" : "lost"}.`);
  }
}
