"use client";

import Link from "next/link";
import { useState, useEffect } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

interface PlayerStats {
  address: string;
  wins: number;
  losses: number;
  gamesPlayed: number;
  winRate: number;
}

function short(addr: string) { return addr?.slice(0, 16) || "???"; }

export default function LeaderboardPage() {
  const [players, setPlayers] = useState<PlayerStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/api/stats`)
      .then((r) => r.json())
      .then((data) => { setPlayers(data.leaderboard || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <nav className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <Link href="/" className="text-lg font-bold tracking-tight hover:text-gray-300">WEREWOLF ARENA</Link>
        <div className="flex gap-4 text-sm">
          <Link href="/play" className="text-gray-400 hover:text-white">Watch</Link>
          <span className="text-white font-bold">Leaderboard</span>
          <Link href="/games" className="text-gray-400 hover:text-white">History</Link>
        </div>
      </nav>

      <main className="flex-1 max-w-3xl mx-auto w-full px-6 py-8">
        <h1 className="text-2xl font-bold mb-6">Leaderboard</h1>

        {loading ? (
          <div className="text-gray-500 text-center py-12">Loading...</div>
        ) : players.length === 0 ? (
          <div className="text-gray-500 text-center py-12">No games played yet.</div>
        ) : (
          <div className="border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase">
                  <th className="px-4 py-3 text-left">#</th>
                  <th className="px-4 py-3 text-left">Agent</th>
                  <th className="px-4 py-3 text-right">W</th>
                  <th className="px-4 py-3 text-right">L</th>
                  <th className="px-4 py-3 text-right">Games</th>
                  <th className="px-4 py-3 text-right">Win Rate</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p, i) => (
                  <tr key={p.address} className="border-b border-gray-800/50 hover:bg-gray-900/50">
                    <td className="px-4 py-3 text-gray-500">{i + 1}</td>
                    <td className="px-4 py-3 font-mono text-gray-300">{short(p.address)}</td>
                    <td className="px-4 py-3 text-right text-green-400">{p.wins}</td>
                    <td className="px-4 py-3 text-right text-red-400">{p.losses}</td>
                    <td className="px-4 py-3 text-right text-gray-400">{p.gamesPlayed}</td>
                    <td className="px-4 py-3 text-right font-bold">
                      <span className={p.winRate >= 50 ? "text-green-400" : "text-gray-400"}>
                        {p.winRate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
