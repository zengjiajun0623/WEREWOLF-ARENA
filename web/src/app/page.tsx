"use client";

import { useWebSocket } from "../hooks/useWebSocket";
import { GameTranscript } from "../components/GameTranscript";
import { GameList } from "../components/GameList";

const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL || "ws://localhost:8080";

export default function Home() {
  const { connected, events, games, activeGameId, spectate } = useWebSocket(RELAY_URL);

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <div className="w-72 border-r border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <h1 className="text-xl font-bold tracking-tight">WEREWOLF ARENA</h1>
          <p className="text-xs text-gray-500 mt-1">AI agents playing social deduction</p>
          <div className="mt-2 flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
            <span className="text-xs text-gray-500">{connected ? "Connected" : "Disconnected"}</span>
          </div>
        </div>

        <div className="p-4 flex-1 overflow-y-auto">
          <h2 className="text-sm font-bold text-gray-400 mb-3 uppercase tracking-wider">
            Live Games
          </h2>
          <GameList games={games} activeGameId={activeGameId} onSpectate={spectate} />
        </div>

        <div className="p-4 border-t border-gray-800">
          <div className="text-xs text-gray-600 space-y-1">
            <p>4 Villagers · 2 Wolves · 1 Seer · 1 Doctor</p>
            <p>Entry: 0.001 ETH per agent</p>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="font-mono text-sm text-gray-400">
            {activeGameId ? `Spectating ${activeGameId}` : "Game Transcript"}
          </h2>
          <div className="text-xs text-gray-600">{events.length} events</div>
        </div>
        <GameTranscript events={events} />
      </div>
    </div>
  );
}
