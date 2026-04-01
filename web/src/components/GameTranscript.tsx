"use client";

import { useEffect, useRef } from "react";
import type { GameEvent } from "../hooks/useWebSocket";

function RoleTag({ role }: { role: string }) {
  const colors: Record<string, string> = {
    Werewolf: "text-red-400 bg-red-900/30",
    Seer: "text-purple-400 bg-purple-900/30",
    Doctor: "text-cyan-400 bg-cyan-900/30",
    Villager: "text-green-400 bg-green-900/30",
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${colors[role] || "text-gray-400"}`}>
      {role}
    </span>
  );
}

function EventLine({ event, name }: { event: GameEvent; name: (addr: string) => string }) {
  switch (event.type) {
    case "game_start":
      return (
        <div className="text-yellow-400 font-bold text-center py-2 border-y border-yellow-800">
          GAME STARTED — {(event.data.players as string[]).length} agents enter the arena
        </div>
      );

    case "wolf_chat_start":
      return (
        <div className="text-red-800 text-center py-1 mt-3 text-xs">
          ·· wolves coordinate privately ··
        </div>
      );

    case "night_start":
      return (
        <div className="text-blue-400 text-center py-1 mt-4">
          --- Night {event.data.round as number} ---
        </div>
      );

    case "doctor_saved":
      return (
        <div className="text-cyan-400 py-1">
          The doctor saved someone. No one died tonight.
        </div>
      );

    case "night_result":
      return (
        <div className="text-red-300 py-1">
          <span className="font-bold">{name(event.data.killed as string)}</span> was killed in the night.
        </div>
      );

    case "day_start":
      return (
        <div className="text-amber-400 text-center py-1 mt-4">
          --- Day {event.data.round as number} --- {(event.data.alivePlayers as string[]).length} alive
        </div>
      );

    case "day_message": {
      const msg = event.data.message as { sender: string; content: string };
      return (
        <div className="py-1.5 pl-2 border-l-2 border-gray-700 hover:border-gray-500">
          <span className="text-cyan-400 font-mono text-sm font-bold">{name(msg.sender)}</span>{" "}
          <span className="text-gray-200">{msg.content}</span>
        </div>
      );
    }

    case "vote_result": {
      const eliminated = event.data.eliminated as string | null;
      const votes = event.data.votes as Record<string, string>;
      return (
        <div className="py-2">
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mb-1">
            {Object.entries(votes).map(([voter, target]) => (
              <span key={voter} className="text-xs text-gray-500">
                {name(voter)} → {name(target)}
              </span>
            ))}
          </div>
          {eliminated ? (
            <div className="text-red-400 font-bold">{name(eliminated)} was eliminated by vote.</div>
          ) : (
            <div className="text-gray-400">Tie — no elimination.</div>
          )}
        </div>
      );
    }

    case "player_eliminated":
      return (
        <div className="text-gray-300">
          <span className="font-bold">{name(event.data.eliminated as string)}</span> was eliminated.
        </div>
      );

    case "game_over": {
      const winner = event.data.winner as string;
      const roles = event.data.roles as Record<string, string>;
      return (
        <div className="text-center py-4 mt-4 border-y border-yellow-800">
          <div className="text-2xl font-bold text-yellow-400 mb-2">GAME OVER</div>
          <div className="text-lg mb-3">
            {winner === "villagers"
              ? <span className="text-green-400">Villagers Win!</span>
              : <span className="text-red-400">Werewolves Win!</span>}
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            {Object.entries(roles).map(([addr, role]) => (
              <div key={addr} className="text-sm">
                <span className="text-gray-300 font-mono">{name(addr)}</span>{" "}
                <RoleTag role={role} />
              </div>
            ))}
          </div>
        </div>
      );
    }

    case "spectating":
      return (
        <div className="text-gray-500 text-center py-1 text-xs">
          Spectating {event.data.gameId as string}
        </div>
      );

    default:
      return null;
  }
}

export function GameTranscript({
  events,
  playerNames = {},
}: {
  events: GameEvent[];
  playerNames?: Record<string, string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const name = (addr: string) => playerNames[addr] || addr?.slice(0, 10) || "???";

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-sm">
      {events.length === 0 && (
        <div className="text-gray-600 text-center py-8">
          Waiting for a game to start...
        </div>
      )}
      {events.map((event, i) => (
        <EventLine key={i} event={event} name={name} />
      ))}
    </div>
  );
}
