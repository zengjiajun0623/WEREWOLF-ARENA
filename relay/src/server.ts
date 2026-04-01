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

  // Allow reconnection: address -> gameId
  private playerGameMap: Map<string, string> = new Map();

  private wolfChatTimers: Map<string, NodeJS.Timeout> = new Map();
  private nightTimers: Map<string, NodeJS.Timeout> = new Map();
  private dayTimers: Map<string, NodeJS.Timeout> = new Map();
  private voteTimers: Map<string, NodeJS.Timeout> = new Map();
  private speakerTimers: Map<string, NodeJS.Timeout> = new Map();

  // Heartbeat
  private heartbeatInterval: NodeJS.Timeout;

  constructor(port: number) {
    mkdirSync("transcripts", { recursive: true });
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (ws) => this.handleConnection(ws));

    // Ping clients every 30s to detect dead connections
    this.heartbeatInterval = setInterval(() => {
      for (const [ws] of this.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, 30_000);

    console.log(`Werewolf relay running on ws://localhost:${port}`);
  }

  private handleConnection(ws: WebSocket) {
    const client: Client = { ws, address: "", gameId: null, isSpectator: false };
    this.clients.set(ws, client);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(client, msg);
      } catch {
        this.send(ws, { type: "error", data: { message: "invalid message format" } });
      }
    });

    ws.on("close", () => this.handleDisconnect(client));
    ws.on("error", () => this.handleDisconnect(client));
  }

  private handleDisconnect(client: Client) {
    this.clients.delete(client.ws);

    if (!client.address || !client.gameId) return;

    const game = this.games.get(client.gameId);
    if (!game) return;

    // If game is in lobby, remove the player
    if (game.phase === Phase.Lobby) {
      game.removePlayer(client.address);
      this.playerGameMap.delete(client.address);
      console.log(`[${client.address.slice(0, 10)}] Left lobby (${game.players.length}/${game.config.maxPlayers})`);

      // Notify remaining players
      for (const [, c] of this.clients) {
        if (c.gameId === client.gameId) {
          this.send(c.ws, {
            type: "waiting_for_players",
            gameId: game.gameId,
            data: {
              playerCount: game.players.length,
              maxPlayers: game.config.maxPlayers,
              players: game.players.map((p) => p.address),
            },
          });
        }
      }

      // Clean up empty games
      if (game.players.length === 0) {
        this.games.delete(client.gameId);
      }
      return;
    }

    // During active game: player is AFK. Timeouts will handle their missing actions.
    console.log(`[${client.address.slice(0, 10)}] Disconnected during ${game.phase} (round ${game.round}). Timeouts will force their actions.`);

    // Notify spectators
    for (const [, c] of this.clients) {
      if (c.gameId === client.gameId && c.isSpectator) {
        this.send(c.ws, {
          type: "player_disconnected",
          gameId: game.gameId,
          data: { player: client.address, phase: game.phase },
        } as GameEvent);
      }
    }
  }

  private handleMessage(client: Client, msg: { type: string; data?: Record<string, unknown> }) {
    switch (msg.type) {
      case "register":
        client.address = msg.data?.address as string;
        this.send(client.ws, { type: "registered", data: { address: client.address } });

        // Check for reconnection
        const existingGameId = this.playerGameMap.get(client.address);
        if (existingGameId) {
          const game = this.games.get(existingGameId);
          if (game && game.phase !== Phase.Finished) {
            client.gameId = existingGameId;
            this.send(client.ws, {
              type: "reconnected",
              data: game.getGameState(),
            });
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
        this.handleWolfChat(client, msg.data?.content as string);
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
      default:
        this.send(client.ws, { type: "error", data: { message: `unknown type: ${msg.type}` } });
    }
  }

  private handleJoinGame(client: Client) {
    if (!client.address) {
      this.send(client.ws, { type: "error", data: { message: "must register first" } });
      return;
    }

    // Already in a game?
    if (client.gameId && this.games.has(client.gameId)) {
      const game = this.games.get(client.gameId)!;
      if (game.phase !== Phase.Finished) {
        this.send(client.ws, { type: "error", data: { message: "already in a game" } });
        return;
      }
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

    const added = game.addPlayer(client.address);
    if (!added) {
      this.send(client.ws, { type: "error", data: { message: "could not join game" } });
      return;
    }

    client.gameId = game.gameId;
    this.playerGameMap.set(client.address, game.gameId);
    this.send(client.ws, { type: "joined", data: { gameId: game.gameId, playerCount: game.players.length } });
  }

  private handleSpectate(client: Client, gameId: string) {
    const game = this.games.get(gameId);
    if (!game) {
      this.send(client.ws, { type: "error", data: { message: "game not found" } });
      return;
    }
    client.gameId = gameId;
    client.isSpectator = true;
    this.send(client.ws, { type: "spectating", data: game.getGameState() });
  }

  private handleWolfChat(client: Client, content: string) {
    const game = this.getClientGame(client);
    if (!game) return;
    game.submitWolfChat(client.address, content);
  }

  private handleListGames(client: Client) {
    const gameList = [...this.games.entries()].map(([id, game]) => ({
      gameId: id,
      phase: game.phase,
      playerCount: game.players.length,
      alivePlayers: game.getAlivePlayers().length,
      round: game.round,
    }));
    this.send(client.ws, { type: "game_list", data: { games: gameList } });
  }

  private handleGameEvent(event: GameEvent) {
    const game = this.games.get(event.gameId);
    if (!game) return;

    // Phase timeouts
    if (event.type === "wolf_chat_start") {
      this.clearTimers(event.gameId);
      this.wolfChatTimers.set(
        event.gameId,
        setTimeout(() => game.forceWolfChatEnd(), game.config.wolfChatTimeoutMs)
      );
    } else if (event.type === "night_start") {
      this.clearTimers(event.gameId);
      this.nightTimers.set(
        event.gameId,
        setTimeout(() => game.forceNightResolve(), game.config.nightTimeoutMs)
      );
    } else if (event.type === "day_start") {
      this.clearTimers(event.gameId);
      this.dayTimers.set(
        event.gameId,
        setTimeout(
          () => game.forceDayEnd(),
          game.config.dayTimeoutMs * game.config.discussionRounds
        )
      );
    } else if (event.type === "vote_start") {
      this.clearTimers(event.gameId);
      this.voteTimers.set(
        event.gameId,
        setTimeout(() => game.forceVoteResolve(), game.config.voteTimeoutMs)
      );
    } else if (event.type === "speak_turn") {
      // Per-speaker timeout: skip after 30s if no response
      const st = this.speakerTimers.get(event.gameId);
      if (st) clearTimeout(st);
      this.speakerTimers.set(
        event.gameId,
        setTimeout(() => {
          console.log(`[${(event.data.speaker as string).slice(0, 10)}] Speaker timeout, skipping`);
          game.skipCurrentSpeaker();
        }, 30_000)
      );
    } else if (event.type === "game_over") {
      this.clearTimers(event.gameId);
      this.saveTranscript(event);
      // Clean up player-game mappings
      for (const [addr, gid] of this.playerGameMap) {
        if (gid === event.gameId) this.playerGameMap.delete(addr);
      }
    }

    // Route events to clients
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

      // Private: wolf chat (only wolves + spectators see it)
      if (event.type === "wolf_chat_start" || event.type === "wolf_chat_message" || event.type === "wolf_chat_end") {
        const wolves = event.data.wolves as string[] | undefined;
        const isWolf = wolves?.includes(client.address);
        if (isWolf || client.isSpectator) this.send(client.ws, event);
        continue;
      }

      // Private: speak turn only to the speaker + set timeout
      if (event.type === "speak_turn") {
        if (client.address === event.data.speaker) this.send(client.ws, event);
        continue;
      }

      // When a day message arrives, clear the speaker timer
      if (event.type === "day_message") {
        const st = this.speakerTimers.get(event.gameId);
        if (st) { clearTimeout(st); this.speakerTimers.delete(event.gameId); }
      }

      // Public: all players + spectators
      this.send(client.ws, event);
    }
  }

  private saveTranscript(event: GameEvent) {
    try {
      const filename = `transcripts/${event.gameId}_${Date.now()}.json`;
      writeFileSync(filename, JSON.stringify({
        gameId: event.gameId,
        winner: event.data.winner,
        roles: event.data.roles,
        rounds: event.data.rounds,
        transcript: event.data.transcript,
        savedAt: new Date().toISOString(),
      }, null, 2));
      console.log(`Transcript saved: ${filename}`);
    } catch (e) {
      console.error("Failed to save transcript:", e);
    }
  }

  private getClientGame(client: Client): WerewolfEngine | null {
    if (!client.gameId || !this.games.has(client.gameId)) {
      this.send(client.ws, { type: "error", data: { message: "not in a game" } });
      return null;
    }
    return this.games.get(client.gameId)!;
  }

  private clearTimers(gameId: string) {
    for (const map of [this.wolfChatTimers, this.nightTimers, this.dayTimers, this.voteTimers, this.speakerTimers]) {
      const t = map.get(gameId);
      if (t) clearTimeout(t);
      map.delete(gameId);
    }
  }

  private send(ws: WebSocket, data: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  close() {
    clearInterval(this.heartbeatInterval);
    for (const [gameId] of this.games) this.clearTimers(gameId);
    this.wss.close();
  }
}

const PORT = parseInt(process.env.PORT || "8080");
const relay = new WerewolfRelay(PORT);

process.on("SIGINT", () => {
  console.log("Shutting down...");
  relay.close();
  process.exit(0);
});
