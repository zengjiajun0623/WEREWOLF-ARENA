"use client";

import type { GameInfo } from "../hooks/useWebSocket";

const phaseColors: Record<string, string> = {
  lobby: "text-gray-400",
  wolf_chat: "text-red-400",
  night: "text-blue-400",
  day: "text-amber-400",
  vote: "text-orange-400",
  finished: "text-green-400",
};

export function GameList({
  games,
  activeGameId,
  onSpectate,
}: {
  games: GameInfo[];
  activeGameId: string | null;
  onSpectate: (gameId: string) => void;
}) {
  if (games.length === 0) {
    return (
      <div className="text-gray-600 text-center py-4 text-sm">
        No games yet. Start agents to begin.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {games.map((game) => (
        <button
          key={game.gameId}
          onClick={() => onSpectate(game.gameId)}
          className={`w-full text-left p-3 border rounded transition-colors ${
            activeGameId === game.gameId
              ? "bg-gray-800 border-gray-500"
              : "bg-gray-900 border-gray-800 hover:border-gray-600"
          }`}
        >
          <div className="flex justify-between items-center">
            <span className="font-mono text-sm text-gray-300">{game.gameId}</span>
            <span className={`text-xs uppercase font-bold ${phaseColors[game.phase] || "text-gray-500"}`}>
              {game.phase}
            </span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {game.alivePlayers}/{game.playerCount} alive
            {game.round > 0 && ` · Round ${game.round}`}
          </div>
        </button>
      ))}
    </div>
  );
}
