"use client";

import Link from "next/link";
import { useState, useEffect, use } from "react";
import { GameTranscript } from "../../../components/GameTranscript";
import type { GameEvent } from "../../../hooks/useWebSocket";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://abundant-radiance-production.up.railway.app";

interface TranscriptData {
  gameId: string;
  winner: string;
  roles: Record<string, string>;
  playerNames?: Record<string, string>;
  rounds: number;
  transcript: { sender: string; content: string; round: number; phase: string }[];
  savedAt: string;
}

const roleColors: Record<string, string> = {
  Werewolf: "text-red-400",
  Seer: "text-purple-400",
  Doctor: "text-cyan-400",
  Villager: "text-green-400",
};

export default function GameReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<TranscriptData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/api/games/${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-500">Loading...</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center text-gray-500">Game not found</div>;

  const playerNames = data.playerNames || {};
  const allPlayers = Object.keys(data.roles);
  const name = (addr: string) => playerNames[addr] || addr?.slice(0, 10) || "???";

  // Convert transcript to GameEvent format for the GameTranscript component
  const events: GameEvent[] = [];

  // Game start
  events.push({
    type: "game_start",
    gameId: data.gameId,
    data: { players: allPlayers },
  });

  // Transcript messages as day_message events
  let lastRound = 0;
  let lastPhase = "";
  // Track alive players: start with all, remove one per round (killed at night)
  let aliveCount = allPlayers.length;

  for (const msg of data.transcript) {
    if (msg.round !== lastRound) {
      lastRound = msg.round;
      lastPhase = "";
      // Each new round means a night kill happened (one fewer alive)
      if (lastRound > 1) aliveCount--;
    }

    if (msg.phase !== lastPhase) {
      if (msg.phase === "day") {
        // After night kill, one fewer player alive
        const dayAlive = lastRound === 1 ? allPlayers.length - 1 : aliveCount;
        events.push({
          type: "day_start",
          gameId: data.gameId,
          data: { round: msg.round, alivePlayers: allPlayers.slice(0, dayAlive) },
        });
      }
      lastPhase = msg.phase;
    }

    if (msg.phase === "day") {
      events.push({
        type: "day_message",
        gameId: data.gameId,
        data: { message: { sender: msg.sender, content: msg.content } },
      });
    }
  }

  // Game over with roles
  events.push({
    type: "game_over",
    gameId: data.gameId,
    data: { winner: data.winner, roles: data.roles },
  });

  return (
    <div className="min-h-screen flex flex-col">
      <nav className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <Link href="/" className="text-lg font-bold tracking-tight hover:text-gray-300">WEREWOLF ARENA</Link>
        <div className="flex gap-4 text-sm">
          <Link href="/play" className="text-gray-400 hover:text-white">Watch</Link>
          <Link href="/games" className="text-gray-400 hover:text-white">History</Link>
        </div>
      </nav>

      <main className="flex-1 flex max-w-5xl mx-auto w-full">
        {/* Transcript */}
        <div className="flex-1 flex flex-col border-r border-gray-800">
          <div className="p-4 border-b border-gray-800">
            <h1 className="font-mono text-sm text-gray-300">{data.gameId}</h1>
            <div className="flex gap-4 text-xs text-gray-500 mt-1">
              <span className={data.winner === "villagers" ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                {data.winner === "villagers" ? "Villagers Win" : "Werewolves Win"}
              </span>
              <span>{data.rounds} rounds</span>
              {data.savedAt && <span>{new Date(data.savedAt).toLocaleString()}</span>}
            </div>
          </div>
          <GameTranscript events={events} playerNames={playerNames} />
        </div>

        {/* Roles sidebar */}
        <div className="w-56 p-4 max-md:hidden">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Roles</h2>
          <div className="space-y-2">
            {Object.entries(data.roles).map(([addr, role]) => (
              <div key={addr} className="flex items-center justify-between text-xs">
                <span className="font-mono text-gray-400">{name(addr)}</span>
                <span className={`font-bold ${roleColors[role] || "text-gray-500"}`}>{role}</span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
