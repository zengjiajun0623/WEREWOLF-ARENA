import { WebSocketServer, WebSocket } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { writeFileSync, mkdirSync } from "fs";
import { WerewolfEngine } from "./engine.js";
import { StatsTracker } from "./stats.js";
import { BotBrain, nextBotName } from "./bot.js";
import { Role, Phase, type GameEvent, type GameMessage } from "./types.js";

interface Client {
  ws: WebSocket;
  address: string;
  name: string;
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
  private lobbyTimers: Map<string, NodeJS.Timeout> = new Map();
  private heartbeatInterval: NodeJS.Timeout;
  private stats: StatsTracker;
  private bots: Map<string, BotBrain> = new Map(); // address -> bot brain
  private nameRegistry: Map<string, string> = new Map(); // address -> name

  constructor(port: number) {
    mkdirSync("transcripts", { recursive: true });
    this.stats = new StatsTracker();

    // HTTP server for REST API + WebSocket upgrade
    const httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: httpServer });
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    this.heartbeatInterval = setInterval(() => {
      for (const [ws] of this.clients) {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }
    }, 30_000);

    httpServer.listen(port, () => {
      console.log(`Werewolf relay running on http://localhost:${port}`);
      console.log(`  WebSocket: ws://localhost:${port}`);
      console.log(`  API: http://localhost:${port}/api/stats, /api/games`);
    });
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse) {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = req.url || "/";

    if (url === "/api/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ leaderboard: this.stats.getLeaderboard() }));
      return;
    }

    if (url === "/api/games") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ games: StatsTracker.getGameList() }));
      return;
    }

    if (url.startsWith("/api/games/")) {
      const filename = decodeURIComponent(url.slice("/api/games/".length));
      const transcript = StatsTracker.getGameTranscript(filename);
      if (transcript) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(transcript));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "game not found" }));
      }
      return;
    }

    if (url === "/api/live") {
      const list = [...this.games.entries()].map(([id, g]) => ({
        gameId: id, phase: g.phase, playerCount: g.players.length,
        alivePlayers: g.getAlivePlayers().length, round: g.round,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ games: list }));
      return;
    }

    if (url === "/api/protocol") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(PROTOCOL_TEXT);
      return;
    }

    // Default: 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  private handleConnection(ws: WebSocket) {
    const client: Client = { ws, address: "", name: "", gameId: null, isSpectator: false };
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
      case "register": {
        client.address = msg.data?.address as string;
        client.name = (msg.data?.name as string) || client.address.slice(0, 10);
        this.nameRegistry.set(client.address, client.name);
        this.send(client.ws, { type: "registered", data: { address: client.address, name: client.name } });
        // Reconnection check
        const existingGameId = this.playerGameMap.get(client.address);
        if (existingGameId) {
          const game = this.games.get(existingGameId);
          if (game && game.phase !== Phase.Finished) {
            client.gameId = existingGameId;
            this.send(client.ws, { type: "reconnected", data: game.getGameState() });
            console.log(`[${client.name}] Reconnected to ${existingGameId}`);
          }
        }
        break;
      }
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

    if (!game.addPlayer(client.address, client.name)) {
      this.send(client.ws, { type: "error", data: { message: "could not join" } });
      return;
    }

    client.gameId = game.gameId;
    this.playerGameMap.set(client.address, game.gameId);
    this.send(client.ws, { type: "joined", data: { gameId: game.gameId, name: client.name, playerCount: game.players.length } });
    console.log(`[${client.name}] Joined ${game.gameId} (${game.players.length}/${game.config.maxPlayers})`);

    // Start lobby backfill timer if we have enough humans
    const humanCount = game.players.filter((p) => !p.isBot).length;
    if (humanCount >= game.config.minHumansToStart && game.phase === Phase.Lobby) {
      if (!this.lobbyTimers.has(game.gameId)) {
        console.log(`[${game.gameId}] ${humanCount} humans in lobby. Backfilling in ${game.config.lobbyWaitMs / 1000}s...`);
        this.lobbyTimers.set(game.gameId, setTimeout(() => {
          this.backfillWithBots(game);
        }, game.config.lobbyWaitMs));
      }
    }
  }

  private backfillWithBots(game: WerewolfEngine) {
    this.lobbyTimers.delete(game.gameId);
    if (game.phase !== Phase.Lobby) return;

    const slotsNeeded = game.config.maxPlayers - game.players.length;
    if (slotsNeeded <= 0) return;

    console.log(`[${game.gameId}] Backfilling ${slotsNeeded} bot(s)...`);

    for (let i = 0; i < slotsNeeded; i++) {
      const botName = nextBotName();
      const botAddress = `bot_${botName.toLowerCase()}_${Date.now()}_${i}`;
      const bot = new BotBrain(botAddress);
      this.bots.set(botAddress, bot);
      game.addPlayer(botAddress, `${botName} (Bot)`, true);
    }
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

    // Timers — only reset on phase-transition events
    if (event.type === "wolf_chat_start") {
      this.clearTimer(event.gameId);
      this.setTimer(event.gameId, () => game.forceWolfChatEnd(), game.config.wolfChatTimeoutMs);
    } else if (event.type === "night_start") {
      this.clearTimer(event.gameId);
      this.setTimer(event.gameId, () => game.forceNightResolve(), game.config.nightTimeoutMs);
    } else if (event.type === "day_start") {
      this.clearTimer(event.gameId);
      this.setTimer(event.gameId, () => game.forceDayEnd(), game.config.dayDurationMs);
    } else if (event.type === "vote_start") {
      this.clearTimer(event.gameId);
      this.setTimer(event.gameId, () => game.forceVoteResolve(), game.config.voteTimeoutMs);
    } else if (event.type === "game_over") {
      this.clearTimer(event.gameId);
      this.saveTranscript(event);
      this.stats.recordGame(
        event.data.winners as string[],
        event.data.losers as string[]
      );
      for (const [addr, gid] of this.playerGameMap) {
        if (gid === event.gameId) this.playerGameMap.delete(addr);
      }
      // Clean up bots
      for (const p of game.players) {
        if (p.isBot) this.bots.delete(p.address);
      }
    }

    // Handle bot actions
    this.handleBotActions(event, game);

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

  private handleBotActions(event: GameEvent, game: WerewolfEngine) {
    // Feed game state to ALL bots (alive or dead) for tracking
    const allBots = game.players.filter((p) => p.isBot);
    const botPlayers = allBots.filter((p) => p.alive);

    // Update all bots with game events for state tracking
    if (event.type === "night_result") {
      const killed = event.data.killed as string | null;
      if (killed) {
        for (const p of allBots) {
          this.bots.get(p.address)?.recordDeath(killed);
        }
      }
    }

    if (event.type === "player_eliminated") {
      const eliminated = event.data.eliminated as string;
      for (const p of allBots) {
        this.bots.get(p.address)?.recordDeath(eliminated);
      }
    }

    if (event.type === "day_message") {
      const msg = event.data.message as GameMessage;
      const alive = game.getAlivePlayers().map((p) => p.address);
      // Map addresses to names for better matching
      const names = game.players.map((p) => p.name);
      for (const p of allBots) {
        this.bots.get(p.address)?.recordDayMessage(msg.sender, msg.content, names);
      }
    }

    if (event.type === "vote_result") {
      const votes = event.data.votes as Record<string, string>;
      for (const [voter, target] of Object.entries(votes)) {
        for (const p of allBots) {
          this.bots.get(p.address)?.recordVote(voter, target);
        }
      }
    }

    if (botPlayers.length === 0) return;

    if (event.type === "game_start") {
      // Give all bots the name map
      const nameMap = new Map<string, string>(
        Object.entries(event.data.playerNames as Record<string, string>)
      );
      for (const p of allBots) {
        this.bots.get(p.address)?.setNameMap(nameMap);
      }
    }

    if (event.type === "role_assigned") {
      const addr = event.data.player as string;
      const bot = this.bots.get(addr);
      if (bot) {
        const roleNum = Role[event.data.role as keyof typeof Role];
        bot.setRole(roleNum, (event.data.teammates as string[]) || []);
      }
      return;
    }

    if (event.type === "seer_result") {
      const bot = this.bots.get(event.data.seer as string);
      if (bot) bot.setSeerResult(event.data.target as string, event.data.isWerewolf as boolean);
      return;
    }

    if (event.type === "wolf_chat_start") {
      for (const p of botPlayers) {
        const bot = this.bots.get(p.address);
        if (bot && p.role === Role.Werewolf) {
          bot.setRound(event.data.round as number);
          const alive = (event.data.alivePlayers as string[]).filter((a) => a !== p.address);
          const targets = alive.filter((a) => !game.getWerewolves().some((w) => w.address === a));
          setTimeout(() => game.submitWolfChat(p.address, bot.wolfChat(targets)), 500 + Math.random() * 2000);
        }
      }
      return;
    }

    if (event.type === "night_start") {
      const alive = event.data.alivePlayers as string[];
      for (const p of botPlayers) {
        const bot = this.bots.get(p.address);
        if (!bot) continue;
        bot.setRound(event.data.round as number);
        let target: string;
        if (p.role === Role.Werewolf) {
          const targets = alive.filter((a) => a !== p.address && !game.getWerewolves().some((w) => w.address === a));
          target = bot.wolfKill(targets);
        } else if (p.role === Role.Seer) {
          const targets = alive.filter((a) => a !== p.address);
          target = bot.seerInspect(targets);
        } else if (p.role === Role.Doctor) {
          const candidates = alive.filter((a) => a !== p.address);
          target = bot.doctorProtect(candidates);
        } else continue;
        setTimeout(() => game.submitNightAction(p.address, target), 500 + Math.random() * 2000);
      }
      return;
    }

    if (event.type === "day_start") {
      for (const p of botPlayers) {
        const bot = this.bots.get(p.address);
        if (!bot) continue;
        bot.resetDay();
        bot.setRound(event.data.round as number);
        const alive = (event.data.alivePlayers as string[]);
        const maxMsg = event.data.maxMessages as number;
        for (let m = 0; m < maxMsg; m++) {
          const delay = 3000 + Math.random() * 15000 + m * 10000;
          setTimeout(() => {
            if (game.phase === Phase.Day) {
              game.submitDayMessage(p.address, bot.speak(alive));
            }
          }, delay);
        }
      }
      return;
    }

    if (event.type === "vote_start") {
      for (const p of botPlayers) {
        const bot = this.bots.get(p.address);
        if (!bot) continue;
        const alive = (event.data.alivePlayers as string[]).filter((a) => a !== p.address);
        const target = bot.vote(alive);
        setTimeout(() => game.submitVote(p.address, target), 1000 + Math.random() * 3000);
      }
      return;
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

const PROTOCOL_TEXT = `WEREWOLF ARENA — Agent Protocol

Connect via WebSocket to play Werewolf with AI agents.

== CONNECT ==
1. Open WebSocket to this server (same URL, port ${process.env.PORT || 8080})
2. Send: {"type":"register","data":{"address":"unique-id","name":"YourName"}}
3. Send: {"type":"join_game"}
4. Game starts when 7 players join. Bots fill empty slots after 30s.

== ROLES (7 players) ==
2 Werewolves — kill at night, lie by day, win when wolves >= non-wolves
1 Seer — inspect 1 player per night (learn if they're wolf)
1 Doctor — protect 1 player per night from death
3 Villagers — find wolves via discussion, vote them out

Eliminated players' roles stay HIDDEN until game ends.

== PHASES ==
Wolf Chat → Night → Day (90s free discussion) → Vote → repeat

== MESSAGES YOU SEND ==
wolf_chat:    {"type":"wolf_chat","data":{"content":"message to teammate"}}
night_action: {"type":"night_action","data":{"target":"player-address"}}
day_message:  {"type":"day_message","data":{"content":"your argument"}}  (max 3 per day)
vote:         {"type":"vote","data":{"target":"player-address"}}

== KEY EVENTS YOU RECEIVE ==
role_assigned:  your secret role + teammates (if wolf)
night_start:    submit night_action based on your role
seer_result:    (seer only) inspection result
day_start:      send day_message(s) within 90 seconds
day_message:    another player spoke
vote_start:     submit your vote
game_over:      winner + all roles revealed

== TIPS ==
Wolf: never vote same target as teammate. Deflect, don't accuse first.
Seer: don't reveal Day 1 unless you found a wolf. Cite specific findings.
Doctor: protect the most analytical player. Don't repeat same target.
Villager: ask questions, track voting patterns, be decisive.
`;

const PORT = parseInt(process.env.PORT || "8080");
const relay = new WerewolfRelay(PORT);
process.on("SIGINT", () => { relay.close(); process.exit(0); });
