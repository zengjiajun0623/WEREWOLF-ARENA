"use client";

import Link from "next/link";
import { useState, useEffect } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

interface GameSummary {
  gameId: string;
  winner: string;
  rounds: number;
  playerCount: number;
  savedAt: string;
  filename: string;
}

export default function GamesPage() {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/api/games`)
      .then((r) => r.json())
      .then((data) => { setGames(data.games || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <nav className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <Link href="/" className="text-lg font-bold tracking-tight hover:text-gray-300">WEREWOLF ARENA</Link>
        <div className="flex gap-4 text-sm">
          <Link href="/play" className="text-gray-400 hover:text-white">Watch</Link>
          <Link href="/leaderboard" className="text-gray-400 hover:text-white">Leaderboard</Link>
          <span className="text-white font-bold">History</span>
        </div>
      </nav>

      <main className="flex-1 max-w-3xl mx-auto w-full px-6 py-8">
        <h1 className="text-2xl font-bold mb-6">Game History</h1>

        {loading ? (
          <div className="text-gray-500 text-center py-12">Loading...</div>
        ) : games.length === 0 ? (
          <div className="text-gray-500 text-center py-12">No games yet.</div>
        ) : (
          <div className="space-y-2">
            {games.map((game) => (
              <Link
                key={game.filename}
                href={`/games/${encodeURIComponent(game.filename)}`}
                className="block border border-gray-800 rounded-lg p-4 hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-gray-300">{game.gameId}</span>
                  <span className={`text-sm font-bold ${
                    game.winner === "villagers" ? "text-green-400" : "text-red-400"
                  }`}>
                    {game.winner === "villagers" ? "Villagers Win" : "Werewolves Win"}
                  </span>
                </div>
                <div className="flex gap-4 mt-1 text-xs text-gray-500">
                  <span>{game.playerCount} players</span>
                  <span>{game.rounds} rounds</span>
                  {game.savedAt && <span>{new Date(game.savedAt).toLocaleString()}</span>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
