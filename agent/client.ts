// Thin WebSocket protocol client. No AI dependency.
// Connects to relay, handles game events, delegates decisions to a Brain.
// Reconnects automatically on disconnect.

import WebSocket from "ws";
import type { Brain, GameContext, Message } from "./brain.js";

function short(addr: string): string { return addr?.slice(0, 10) || "???"; }

export class WerewolfClient {
  private ws: WebSocket | null = null;
  private brain: Brain;
  private address: string;
  private relayUrl: string;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  // Game state
  private role = "unknown";
  private teammates: string[] = [];
  private knownRoles = new Map<string, boolean>();
  private lastProtectedTarget: string | null = null;
  private gameId = "";
  private round = 0;
  private allPlayers: string[] = [];
  private transcript: Message[] = [];
  private eliminatedPlayers: { address: string; role: string; round: number; method: string }[] = [];

  constructor(relayUrl: string, address: string, brain: Brain) {
    this.address = address;
    this.brain = brain;
    this.relayUrl = relayUrl;
    this.connect();
  }

  private connect() {
    this.ws = new WebSocket(this.relayUrl);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.send({ type: "register", data: { address: this.address } });
      // If not reconnecting to an existing game, join a new one
      if (!this.gameId) {
        setTimeout(() => this.send({ type: "join_game" }), 500);
      }
    });

    this.ws.on("message", (data) => {
      try {
        this.handleEvent(JSON.parse(data.toString()));
      } catch (e) {
        console.error("Parse error:", e);
      }
    });

    this.ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
    });

    this.ws.on("close", () => {
      console.log(`[${short(this.address)}] Disconnected`);
      if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        console.log(`[${short(this.address)}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
        setTimeout(() => this.connect(), delay);
      }
    });
  }

  private ctx(): GameContext {
    return {
      myAddress: this.address,
      myRole: this.role,
      alivePlayers: [],
      round: this.round,
      teammates: this.teammates,
      knownRoles: this.knownRoles,
      lastProtectedTarget: this.lastProtectedTarget,
    };
  }

  private async handleEvent(event: { type: string; data: Record<string, unknown> }) {
    switch (event.type) {
      case "registered":
        console.log(`[${short(this.address)}] Registered`);
        break;

      case "reconnected":
        this.gameId = event.data.gameId as string;
        console.log(`[${short(this.address)}] Reconnected to ${this.gameId} (${event.data.phase}, round ${event.data.round})`);
        break;

      case "joined":
        this.gameId = event.data.gameId as string;
        console.log(`[${short(this.address)}] Joined ${this.gameId} (${event.data.playerCount}/7)`);
        break;

      case "waiting_for_players":
        console.log(`[${short(this.address)}] Waiting... ${event.data.playerCount}/7`);
        break;

      case "role_assigned":
        this.role = event.data.role as string;
        this.teammates = (event.data.teammates as string[]) || [];
        console.log(`[${short(this.address)}] Role: ${this.role}${this.teammates.length ? ` | Teammate: ${this.teammates.map(short).join(", ")}` : ""}`);
        break;

      case "game_start":
        this.allPlayers = event.data.players as string[];
        console.log(`\n=== GAME STARTED ===\n`);
        break;

      // ── Wolf Chat ──────────────────────────────────────────────────────────
      case "wolf_chat_start": {
        const alive = event.data.alivePlayers as string[];
        this.round = event.data.round as number;
        console.log(`\n--- [WOLF CHAT] Round ${this.round} ---`);
        if (this.role === "Werewolf") {
          const targets = alive.filter((a) => a !== this.address && !this.teammates.includes(a));
          const ctx = { ...this.ctx(), alivePlayers: alive };
          const msg = await this.brain.wolfChat(ctx, targets);
          this.send({ type: "wolf_chat", data: { content: msg } });
        }
        break;
      }

      case "wolf_chat_message":
        if (this.role === "Werewolf" && event.data.sender !== this.address) {
          console.log(`[WOLF] ${short(event.data.sender as string)}: ${event.data.content}`);
        }
        break;

      // ── Night ──────────────────────────────────────────────────────────────
      case "night_start": {
        const alive = event.data.alivePlayers as string[];
        this.round = event.data.round as number;
        console.log(`\n--- Night ${this.round} ---`);
        const ctx = { ...this.ctx(), alivePlayers: alive };

        if (this.role === "Werewolf") {
          const targets = alive.filter((a) => a !== this.address && !this.teammates.includes(a));
          const target = await this.brain.wolfKill(ctx, targets);
          this.send({ type: "night_action", data: { target } });
          console.log(`[${short(this.address)}] (wolf) → ${short(target)}`);

        } else if (this.role === "Seer") {
          const uninspected = alive.filter((a) => a !== this.address && !this.knownRoles.has(a));
          const pool = uninspected.length > 0 ? uninspected : alive.filter((a) => a !== this.address);
          const target = await this.brain.seerInspect(ctx, pool);
          this.send({ type: "night_action", data: { target } });
          console.log(`[${short(this.address)}] (seer) → ${short(target)}`);

        } else if (this.role === "Doctor") {
          const candidates = alive.filter((a) => a !== this.lastProtectedTarget);
          const target = await this.brain.doctorProtect(ctx, candidates);
          this.lastProtectedTarget = target;
          this.send({ type: "night_action", data: { target } });
          console.log(`[${short(this.address)}] (doctor) → ${short(target)}`);
        }
        break;
      }

      case "seer_result":
        this.knownRoles.set(event.data.target as string, event.data.isWerewolf as boolean);
        console.log(`[${short(this.address)}] SEER: ${short(event.data.target as string)} is ${event.data.isWerewolf ? "WEREWOLF!" : "safe"}`);
        break;

      case "night_result": {
        const killed = event.data.killed as string;
        this.eliminatedPlayers.push({ address: killed, role: event.data.killedRole as string, round: this.round, method: "killed" });
        console.log(`\n${short(killed)} killed (${event.data.killedRole})\n`);
        break;
      }

      case "doctor_saved":
        console.log(`\nDoctor saved someone. No one died.\n`);
        break;

      // ── Day ────────────────────────────────────────────────────────────────
      case "day_start":
        console.log(`\n--- Day ${event.data.round} --- (${(event.data.alivePlayers as string[]).length} alive)`);
        break;

      case "speak_turn": {
        const dayTranscript = (event.data.transcript as Message[]) || [];
        const alive = event.data.alivePlayers as string[];
        const ctx = { ...this.ctx(), alivePlayers: alive };
        const msg = await this.brain.speak(ctx, dayTranscript);
        this.send({ type: "day_message", data: { content: msg } });
        break;
      }

      case "day_message": {
        const msg = event.data.message as Message;
        this.transcript.push(msg);
        if (msg.sender !== this.address) {
          console.log(`[${short(msg.sender)}]: ${msg.content}`);
        }
        break;
      }

      // ── Vote ───────────────────────────────────────────────────────────────
      case "vote_start": {
        const dayTranscript = (event.data.transcript as Message[]) || [];
        const alive = event.data.alivePlayers as string[];
        const candidates = alive.filter((a) => a !== this.address);
        const ctx = { ...this.ctx(), alivePlayers: alive };
        const target = await this.brain.vote(ctx, dayTranscript, candidates);
        this.send({ type: "vote", data: { target } });
        console.log(`[${short(this.address)}] Voted → ${short(target)}`);
        break;
      }

      case "vote_result":
        console.log(`\nVote: ${event.data.eliminated ? short(event.data.eliminated as string) + " eliminated" : "tie"}`);
        break;

      case "player_eliminated": {
        const elim = event.data.eliminated as string;
        this.eliminatedPlayers.push({ address: elim, role: event.data.role as string, round: event.data.round as number, method: "voted" });
        console.log(`${short(elim)} was ${event.data.role}`);
        break;
      }

      case "player_disconnected":
        console.log(`[${short(event.data.player as string)}] disconnected`);
        break;

      // ── Game Over ──────────────────────────────────────────────────────────
      case "game_over": {
        const winner = event.data.winner as string;
        const roles = event.data.roles as Record<string, string>;
        const myActualRole = roles[this.address] || this.role;
        const isWolf = myActualRole === "Werewolf";
        const didWin = (winner === "werewolves" && isWolf) || (winner === "villagers" && !isWolf);

        console.log(`\n=== ${winner.toUpperCase()} WIN — ${didWin ? "YOU WON" : "YOU LOST"} ===`);
        for (const [addr, role] of Object.entries(roles)) {
          console.log(`  ${short(addr)}: ${role}`);
        }

        const ctx = { ...this.ctx(), alivePlayers: [] };
        await this.brain.onGameOver(ctx, winner, roles, didWin);

        this.shouldReconnect = false;
        setTimeout(() => process.exit(0), 2000);
        break;
      }

      case "error":
        console.error(`[${short(this.address)}] Error: ${event.data.message}`);
        break;
    }
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
