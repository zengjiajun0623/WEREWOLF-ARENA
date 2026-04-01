import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";

interface PlayerStats {
  wins: number;
  losses: number;
  gamesPlayed: number;
  lastSeen: string;
}

interface GameSummary {
  gameId: string;
  winner: string;
  roles: Record<string, string>;
  rounds: number;
  playerCount: number;
  savedAt: string;
  filename: string;
}

const STATS_FILE = "stats.json";

export class StatsTracker {
  private stats: Map<string, PlayerStats> = new Map();

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (existsSync(STATS_FILE)) {
        const data = JSON.parse(readFileSync(STATS_FILE, "utf-8"));
        for (const [addr, s] of Object.entries(data)) {
          this.stats.set(addr, s as PlayerStats);
        }
      }
    } catch { /* fresh start */ }
  }

  private save() {
    try {
      writeFileSync(STATS_FILE, JSON.stringify(Object.fromEntries(this.stats), null, 2));
    } catch (e) {
      console.error("Failed to save stats:", e);
    }
  }

  recordGame(winners: string[], losers: string[]) {
    const now = new Date().toISOString();
    for (const addr of winners) {
      if (addr.startsWith("bot_")) continue;
      const s = this.stats.get(addr) || { wins: 0, losses: 0, gamesPlayed: 0, lastSeen: "" };
      s.wins++;
      s.gamesPlayed++;
      s.lastSeen = now;
      this.stats.set(addr, s);
    }
    for (const addr of losers) {
      if (addr.startsWith("bot_")) continue;
      const s = this.stats.get(addr) || { wins: 0, losses: 0, gamesPlayed: 0, lastSeen: "" };
      s.losses++;
      s.gamesPlayed++;
      s.lastSeen = now;
      this.stats.set(addr, s);
    }
    this.save();
  }

  getLeaderboard(): { address: string; wins: number; losses: number; gamesPlayed: number; winRate: number }[] {
    return [...this.stats.entries()]
      .map(([address, s]) => ({
        address,
        ...s,
        winRate: s.gamesPlayed > 0 ? Math.round((s.wins / s.gamesPlayed) * 100) : 0,
      }))
      .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate);
  }

  static getGameList(): GameSummary[] {
    try {
      if (!existsSync("transcripts")) return [];
      const files = readdirSync("transcripts").filter((f) => f.endsWith(".json")).sort().reverse();
      return files.map((f) => {
        try {
          const data = JSON.parse(readFileSync(`transcripts/${f}`, "utf-8"));
          return {
            gameId: data.gameId || f.replace(".json", ""),
            winner: data.winner || "unknown",
            roles: data.roles || {},
            rounds: data.rounds || 0,
            playerCount: Object.keys(data.roles || {}).length,
            savedAt: data.savedAt || "",
            filename: f,
          };
        } catch { return null; }
      }).filter(Boolean) as GameSummary[];
    } catch { return []; }
  }

  static getGameTranscript(filename: string): unknown | null {
    try {
      const path = `transcripts/${filename}`;
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch { return null; }
  }
}
