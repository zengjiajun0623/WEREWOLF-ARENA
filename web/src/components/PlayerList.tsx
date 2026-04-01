"use client";

import type { GameEvent } from "../hooks/useWebSocket";

function short(addr: string): string { return addr?.slice(0, 10) || "???"; }

interface PlayerInfo {
  address: string;
  alive: boolean;
  role?: string; // revealed after elimination or game over
}

export function PlayerList({ events }: { events: GameEvent[] }) {
  // Build player state from events
  const players = new Map<string, PlayerInfo>();
  let phase = "";
  let round = 0;
  let winner = "";

  for (const event of events) {
    if (event.type === "spectating" || event.type === "game_start") {
      const addrs = (event.data.players as { address: string }[] | string[]) || [];
      for (const p of addrs) {
        const addr = typeof p === "string" ? p : p.address;
        if (!players.has(addr)) {
          players.set(addr, { address: addr, alive: true });
        }
      }
    }

    if (event.type === "night_result") {
      const killed = event.data.killed as string;
      const info = players.get(killed);
      if (info) {
        info.alive = false;
        info.role = event.data.killedRole as string;
      }
    }

    if (event.type === "player_eliminated") {
      const elim = event.data.eliminated as string;
      const info = players.get(elim);
      if (info) {
        info.alive = false;
        info.role = event.data.role as string;
      }
    }

    if (event.type === "game_over") {
      winner = event.data.winner as string;
      const roles = event.data.roles as Record<string, string>;
      for (const [addr, role] of Object.entries(roles)) {
        const info = players.get(addr);
        if (info) info.role = role;
      }
    }

    if (event.type === "day_start" || event.type === "night_start") {
      round = event.data.round as number;
    }

    if (event.type === "wolf_chat_start") phase = "wolf_chat";
    else if (event.type === "night_start") phase = "night";
    else if (event.type === "day_start") phase = "day";
    else if (event.type === "vote_start") phase = "vote";
    else if (event.type === "game_over") phase = "finished";
    else if (event.type === "doctor_saved") { /* keep current phase */ }
  }

  if (players.size === 0) return null;

  const roleColors: Record<string, string> = {
    Werewolf: "text-red-400",
    Seer: "text-purple-400",
    Doctor: "text-cyan-400",
    Villager: "text-green-400",
  };

  const phaseLabels: Record<string, { label: string; color: string }> = {
    wolf_chat: { label: "WOLF CHAT", color: "text-red-400" },
    night: { label: "NIGHT", color: "text-blue-400" },
    day: { label: "DAY", color: "text-amber-400" },
    vote: { label: "VOTING", color: "text-orange-400" },
    finished: { label: "FINISHED", color: "text-green-400" },
  };

  const alive = [...players.values()].filter((p) => p.alive).length;
  const phaseInfo = phaseLabels[phase];

  return (
    <div className="border-b border-gray-800 p-4">
      {/* Phase indicator */}
      <div className="flex items-center justify-between mb-3">
        {phaseInfo && (
          <span className={`text-xs font-bold uppercase tracking-wider ${phaseInfo.color}`}>
            {phaseInfo.label}
          </span>
        )}
        {round > 0 && (
          <span className="text-xs text-gray-500">Round {round}</span>
        )}
      </div>

      {/* Winner banner */}
      {winner && (
        <div className={`text-center text-sm font-bold mb-3 py-1 rounded ${
          winner === "villagers" ? "text-green-400 bg-green-900/20" : "text-red-400 bg-red-900/20"
        }`}>
          {winner === "villagers" ? "Villagers Win" : "Werewolves Win"}
        </div>
      )}

      {/* Player list */}
      <div className="space-y-1">
        <div className="text-xs text-gray-500 mb-1">{alive} / {players.size} alive</div>
        {[...players.values()].map((player) => (
          <div
            key={player.address}
            className={`flex items-center justify-between text-xs py-0.5 ${
              player.alive ? "text-gray-300" : "text-gray-600 line-through"
            }`}
          >
            <span className="font-mono">{short(player.address)}</span>
            {player.role && (
              <span className={`font-bold ${roleColors[player.role] || "text-gray-500"}`}>
                {player.role}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
