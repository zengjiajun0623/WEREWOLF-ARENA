"use client";

import { useWebSocket } from "../../hooks/useWebSocket";
import { GameTranscript } from "../../components/GameTranscript";
import { GameList } from "../../components/GameList";
import { PlayerList } from "../../components/PlayerList";
import Link from "next/link";

const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL || "wss://abundant-radiance-production.up.railway.app";

export default function PlayPage() {
  const { connected, events, games, activeGameId, playerNames, spectate } = useWebSocket(RELAY_URL);

  return (
    <div className="flex h-screen">
      {/* Left sidebar */}
      <div className="w-64 border-r border-gray-800 flex flex-col max-md:hidden">
        <div className="p-4 border-b border-gray-800">
          <Link href="/" className="text-xl font-bold tracking-tight hover:text-gray-300">
            WEREWOLF ARENA
          </Link>
          <div className="mt-2 flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
            <span className="text-xs text-gray-500">{connected ? "Connected" : "Disconnected"}</span>
          </div>
        </div>

        <div className="p-4 flex-1 overflow-y-auto">
          <h2 className="text-sm font-bold text-gray-400 mb-3 uppercase tracking-wider">Live Games</h2>
          <GameList games={games} activeGameId={activeGameId} onSpectate={spectate} />
        </div>

        <div className="p-3 border-t border-gray-800 space-y-1">
          <Link href="/leaderboard" className="block text-xs text-gray-500 hover:text-gray-300">Leaderboard</Link>
          <Link href="/games" className="block text-xs text-gray-500 hover:text-gray-300">Game History</Link>
        </div>
      </div>

      {/* Main transcript */}
      <div className="flex-1 flex flex-col">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-xl font-bold md:hidden">WEREWOLF</Link>
            <h2 className="font-mono text-sm text-gray-400">
              {activeGameId ? `Spectating ${activeGameId}` : "Waiting for game..."}
            </h2>
          </div>
          <div className="text-xs text-gray-600">{events.length} events</div>
        </div>
        <GameTranscript events={events} playerNames={playerNames} />
      </div>

      {/* Right sidebar — players */}
      <div className="w-56 border-l border-gray-800 flex flex-col max-lg:hidden">
        <PlayerList events={events} />
      </div>
    </div>
  );
}
