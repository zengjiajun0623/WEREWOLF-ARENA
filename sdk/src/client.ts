import WebSocket from "ws";
import type {
  WerewolfAgentConfig,
  GameEvent,
  GameMessage,
} from "./types.js";

export class WerewolfAgent {
  private ws: WebSocket | null = null;
  private config: WerewolfAgentConfig;
  private myRole: string = "unknown";
  private teammates: string[] = [];
  private knownRoles: Map<string, boolean> = new Map(); // address -> isWerewolf (seer knowledge)
  private gameId: string | null = null;
  private eventListeners: ((event: GameEvent) => void)[] = [];

  constructor(config: WerewolfAgentConfig) {
    this.config = config;
  }

  onEvent(listener: (event: GameEvent) => void) {
    this.eventListeners.push(listener);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.relayUrl);

      this.ws.on("open", () => {
        this.send({ type: "register", data: { address: this.config.address } });
        resolve();
      });

      this.ws.on("message", (data) => {
        try {
          const event: GameEvent = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch (e) {
          console.error("Failed to parse message:", e);
        }
      });

      this.ws.on("error", reject);
      this.ws.on("close", () => {
        console.log("Disconnected from relay");
      });
    });
  }

  async joinGame(): Promise<void> {
    this.send({ type: "join_game" });
  }

  private async handleEvent(event: GameEvent) {
    // Emit to listeners
    for (const listener of this.eventListeners) {
      listener(event);
    }

    switch (event.type) {
      case "joined":
        this.gameId = event.data.gameId as string;
        console.log(
          `[${this.shortAddr()}] Joined ${this.gameId} (${event.data.playerCount}/7)`
        );
        break;

      case "role_assigned":
        this.myRole = event.data.role as string;
        this.teammates = (event.data.teammates as string[]) || [];
        console.log(`[${this.shortAddr()}] Role: ${this.myRole}`);
        if (this.teammates.length > 0) {
          console.log(
            `[${this.shortAddr()}] Teammates: ${this.teammates.map((t) => t.slice(0, 8)).join(", ")}`
          );
        }
        break;

      case "game_start":
        console.log(`[${this.shortAddr()}] Game started! Round ${event.data.round}`);
        break;

      case "night_start":
        console.log(`[${this.shortAddr()}] Night ${event.data.round} begins`);
        await this.handleNight(event);
        break;

      case "seer_result":
        const isWolf = event.data.isWerewolf as boolean;
        const target = event.data.target as string;
        this.knownRoles.set(target, isWolf);
        console.log(
          `[${this.shortAddr()}] Seer vision: ${target.slice(0, 8)} is ${isWolf ? "WEREWOLF" : "not a werewolf"}`
        );
        break;

      case "night_result":
        console.log(
          `[${this.shortAddr()}] Night result: ${(event.data.killed as string).slice(0, 8)} was killed (${event.data.killedRole})`
        );
        break;

      case "day_start":
        console.log(
          `[${this.shortAddr()}] Day ${event.data.round} begins. ${(event.data.alivePlayers as string[]).length} alive.`
        );
        break;

      case "speak_turn":
        await this.handleSpeakTurn(event);
        break;

      case "day_message": {
        const msg = event.data.message as GameMessage;
        console.log(`[${msg.sender.slice(0, 8)}] ${msg.content}`);
        break;
      }

      case "vote_start":
        console.log(`[${this.shortAddr()}] Voting phase`);
        await this.handleVote(event);
        break;

      case "vote_result":
        console.log(
          `[${this.shortAddr()}] Vote result: ${event.data.eliminated ? (event.data.eliminated as string).slice(0, 8) + " eliminated" : "no elimination (tie)"}`
        );
        break;

      case "player_eliminated":
        console.log(
          `[${this.shortAddr()}] ${(event.data.eliminated as string).slice(0, 8)} eliminated (was ${event.data.role})`
        );
        break;

      case "game_over":
        console.log(
          `[${this.shortAddr()}] Game over! ${event.data.winner} win!`
        );
        break;

      case "error":
        console.error(`[${this.shortAddr()}] Error: ${event.data.message}`);
        break;
    }
  }

  private async handleNight(event: GameEvent) {
    const alivePlayers = event.data.alivePlayers as string[];

    if (this.myRole === "Werewolf" && this.config.onNightWerewolf) {
      const target = await this.config.onNightWerewolf(
        alivePlayers.filter((a) => !this.teammates.includes(a)),
        this.teammates,
        this.config.address
      );
      this.send({ type: "night_action", data: { target } });
    } else if (this.myRole === "Seer" && this.config.onNightSeer) {
      const target = await this.config.onNightSeer(
        alivePlayers.filter((a) => a !== this.config.address),
        this.knownRoles,
        this.config.address
      );
      this.send({ type: "night_action", data: { target } });
    }
    // Villagers do nothing at night
  }

  private async handleSpeakTurn(event: GameEvent) {
    const transcript = (event.data.transcript as GameMessage[]) || [];
    const alivePlayers = event.data.alivePlayers as string[];

    const message = await this.config.onDay(
      transcript,
      alivePlayers,
      this.myRole,
      this.config.address
    );

    this.send({ type: "day_message", data: { content: message } });
  }

  private async handleVote(event: GameEvent) {
    const transcript = (event.data.transcript as GameMessage[]) || [];
    const alivePlayers = event.data.alivePlayers as string[];

    const target = await this.config.onVote(
      transcript,
      alivePlayers.filter((a) => a !== this.config.address),
      this.myRole,
      this.config.address
    );

    this.send({ type: "vote", data: { target } });
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private shortAddr(): string {
    return this.config.address.slice(0, 8);
  }

  disconnect() {
    this.ws?.close();
  }
}
