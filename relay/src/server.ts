import { WebSocketServer, WebSocket } from "ws";
import { writeFileSync, mkdirSync } from "fs";
import { WerewolfEngine } from "./engine.js";
import { Phase, type GameEvent } from "./types.js";

interface Client {
  ws: WebSocket;
  address: string;
  gameId: string | null;
  isSpectator: boolean;
}

export class WerewolfRelay {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, Client> = new Map();
  private games: Map<string, WerewolfEngine> = new Map();
  private nextGameId: number = 0;
  private playerGameMap: Map<string, string> = new Map();

  private timers: Map<string, NodeJS.Timeout> = new Map();
  private heartbeatInterval: NodeJS.Timeout;

  constructor(port: number) {
    mkdirSync("transcripts", { recursive: true });
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    this.heartbeatInterval = setInterval(() => {
      for (const [ws] of this.clients) {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }
    }, 30_000);
    console.log(`Werewolf relay running on ws://localhost:${port}`);
  }

  private handleConnection(ws: WebSocket) {
    const client: Client = { ws, address: "", gameId: null, isSpectator: false };
    this.clients.set(ws, client);

    ws.on("message", (data) => {
      try { this.handleMessage(client, JSON.parse(data.toString())); }
      catch { this.send(ws, { type: "error", data: { message: "invalid format" } }); }
    });

    ws.on("close", () => this.handleDisconnect(client));
    ws.on("error", () => this.handleDisconnect(client));
  }

  private handleDisconnect(client: Client) {
    this.clients.delete(client.ws);
    if (!client.address || !client.gameId) return;

    const game = this.games.get(client.gameId);
    if (!game) return;

    if (game.phase === Phase.Lobby) {
      game.removePlayer(client.address);
      this.playerGameMap.delete(client.address);
      console.log(`[${client.address.slice(0, 10)}] Left lobby`);
      this.broadcastToGame(client.gameId, {
        type: "waiting_for_players",
        gameId: client.gameId,
        data: { playerCount: game.players.length, maxPlayers: game.config.maxPlayers, players: game.players.map((p) => p.address) },
      });
      if (game.players.length === 0) this.games.delete(client.gameId);
      return;
    }

    console.log(`[${client.address.slice(0, 10)}] Disconnected during ${game.phase}`);
  }

  private handleMessage(client: Client, msg: { type: string; data?: Record<string, unknown> }) {
    switch (msg.type) {
      case "register":
        client.address = msg.data?.address as string;
        this.send(client.ws, { type: "registered", data: { address: client.address } });
        // Reconnection check
        const existingGameId = this.playerGameMap.get(client.address);
        if (existingGameId) {
          const game = this.games.get(existingGameId);
          if (game && game.phase !== Phase.Finished) {
            client.gameId = existingGameId;
            this.send(client.ws, { type: "reconnected", data: game.getGameState() });
            console.log(`[${client.address.slice(0, 10)}] Reconnected to ${existingGameId}`);
          }
        }
        break;
      case "join_game":
        this.handleJoinGame(client);
        break;
      case "spectate":
        this.handleSpectate(client, msg.data?.gameId as string);
        break;
      case "wolf_chat":
        this.getClientGame(client)?.submitWolfChat(client.address, msg.data?.content as string);
        break;
      case "night_action":
        this.getClientGame(client)?.submitNightAction(client.address, msg.data?.target as string);
        break;
      case "day_message":
        this.getClientGame(client)?.submitDayMessage(client.address, msg.data?.content as string);
        break;
      case "vote":
        this.getClientGame(client)?.submitVote(client.address, msg.data?.target as string);
        break;
      case "list_games":
        this.handleListGames(client);
        break;
    }
  }

  private handleJoinGame(client: Client) {
    if (!client.address) {
      this.send(client.ws, { type: "error", data: { message: "must register first" } });
      return;
    }
    if (client.gameId && this.games.has(client.gameId) && this.games.get(client.gameId)!.phase !== Phase.Finished) {
      this.send(client.ws, { type: "error", data: { message: "already in a game" } });
      return;
    }

    let game: WerewolfEngine | null = null;
    for (const [, g] of this.games) {
      if (g.phase === Phase.Lobby) { game = g; break; }
    }
    if (!game) {
      const gameId = `game_${this.nextGameId++}`;
      game = new WerewolfEngine(gameId);
      this.games.set(gameId, game);
      game.onEvent((event) => this.handleGameEvent(event));
    }

    if (!game.addPlayer(client.address)) {
      this.send(client.ws, { type: "error", data: { message: "could not join" } });
      return;
    }

    client.gameId = game.gameId;
    this.playerGameMap.set(client.address, game.gameId);
    this.send(client.ws, { type: "joined", data: { gameId: game.gameId, playerCount: game.players.length } });
  }

  private handleSpectate(client: Client, gameId: string) {
    const game = this.games.get(gameId);
    if (!game) { this.send(client.ws, { type: "error", data: { message: "game not found" } }); return; }
    client.gameId = gameId;
    client.isSpectator = true;
    this.send(client.ws, { type: "spectating", data: game.getGameState() });
  }

  private handleListGames(client: Client) {
    const list = [...this.games.entries()].map(([id, g]) => ({
      gameId: id, phase: g.phase, playerCount: g.players.length,
      alivePlayers: g.getAlivePlayers().length, round: g.round,
    }));
    this.send(client.ws, { type: "game_list", data: { games: list } });
  }

  private handleGameEvent(event: GameEvent) {
    const game = this.games.get(event.gameId);
    if (!game) return;

    // Timers
    this.clearTimer(event.gameId);
    if (event.type === "wolf_chat_start") {
      this.setTimer(event.gameId, () => game.forceWolfChatEnd(), game.config.wolfChatTimeoutMs);
    } else if (event.type === "night_start") {
      this.setTimer(event.gameId, () => game.forceNightResolve(), game.config.nightTimeoutMs);
    } else if (event.type === "day_start") {
      this.setTimer(event.gameId, () => game.forceDayEnd(), game.config.dayDurationMs);
    } else if (event.type === "vote_start") {
      this.setTimer(event.gameId, () => game.forceVoteResolve(), game.config.voteTimeoutMs);
    } else if (event.type === "game_over") {
      this.saveTranscript(event);
      for (const [addr, gid] of this.playerGameMap) {
        if (gid === event.gameId) this.playerGameMap.delete(addr);
      }
    }

    // Route events
    for (const [, client] of this.clients) {
      if (client.gameId !== event.gameId) continue;

      // Private: role assignment
      if (event.type === "role_assigned") {
        if (client.address === event.data.player) this.send(client.ws, event);
        continue;
      }

      // Private: seer result
      if (event.type === "seer_result") {
        if (client.address === event.data.seer) this.send(client.ws, event);
        continue;
      }

      // Private: wolf chat
      if (event.type === "wolf_chat_start" || event.type === "wolf_chat_message" || event.type === "wolf_chat_end") {
        const wolves = event.data.wolves as string[] | undefined;
        if (wolves?.includes(client.address) || client.isSpectator) this.send(client.ws, event);
        continue;
      }

      // Public: everything else goes to all players + spectators
      this.send(client.ws, event);
    }
  }

  private broadcastToGame(gameId: string, event: GameEvent) {
    for (const [, client] of this.clients) {
      if (client.gameId === gameId) this.send(client.ws, event);
    }
  }

  private saveTranscript(event: GameEvent) {
    try {
      const filename = `transcripts/${event.gameId}_${Date.now()}.json`;
      writeFileSync(filename, JSON.stringify({
        gameId: event.gameId, winner: event.data.winner, roles: event.data.roles,
        rounds: event.data.rounds, transcript: event.data.transcript,
        savedAt: new Date().toISOString(),
      }, null, 2));
      console.log(`Transcript saved: ${filename}`);
    } catch (e) { console.error("Failed to save transcript:", e); }
  }

  private getClientGame(client: Client): WerewolfEngine | null {
    if (!client.gameId || !this.games.has(client.gameId)) return null;
    return this.games.get(client.gameId)!;
  }

  private setTimer(gameId: string, fn: () => void, ms: number) {
    this.timers.set(gameId, setTimeout(fn, ms));
  }

  private clearTimer(gameId: string) {
    const t = this.timers.get(gameId);
    if (t) clearTimeout(t);
    this.timers.delete(gameId);
  }

  private send(ws: WebSocket, data: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  close() {
    clearInterval(this.heartbeatInterval);
    for (const [id] of this.timers) this.clearTimer(id);
    this.wss.close();
  }
}

const PORT = parseInt(process.env.PORT || "8080");
const relay = new WerewolfRelay(PORT);
process.on("SIGINT", () => { relay.close(); process.exit(0); });
