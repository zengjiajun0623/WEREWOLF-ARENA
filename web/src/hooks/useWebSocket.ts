"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export interface GameEvent {
  type: string;
  gameId?: string;
  data: Record<string, unknown>;
}

export interface GameMessage {
  sender: string;
  content: string;
  timestamp: number;
}

export interface GameInfo {
  gameId: string;
  phase: string;
  playerCount: number;
  alivePlayers: number;
  round: number;
}

export function useWebSocket(url: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [games, setGames] = useState<GameInfo[]>([]);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const autoSpectated = useRef<Set<string>>(new Set());

  const spectate = useCallback((gameId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setEvents([]);
      setActiveGameId(gameId);
      wsRef.current.send(JSON.stringify({ type: "spectate", data: { gameId } }));
    }
  }, []);

  useEffect(() => {
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "list_games" }));
    };

    ws.onmessage = (e) => {
      try {
        const event: GameEvent = JSON.parse(e.data);

        if (event.type === "game_list") {
          const incoming = event.data.games as GameInfo[];
          setGames(incoming);

          // Auto-spectate the most active game if we're not already watching one
          setActiveGameId((current) => {
            if (current) return current;

            // Prefer active games (night/day/vote) over lobby
            const active = incoming.find((g) =>
              ["night", "wolf_chat", "day", "vote"].includes(g.phase)
            );
            const candidate = active ?? incoming[incoming.length - 1];

            if (candidate && !autoSpectated.current.has(candidate.gameId)) {
              autoSpectated.current.add(candidate.gameId);
              setTimeout(() => {
                ws.send(JSON.stringify({ type: "spectate", data: { gameId: candidate.gameId } }));
              }, 100);
              return candidate.gameId;
            }
            return current;
          });
          return;
        }

        setEvents((prev) => [...prev, event]);
      } catch {
        // ignore
      }
    };

    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "list_games" }));
      }
    }, 5000);

    return () => {
      clearInterval(interval);
      ws.close();
    };
  }, [url]);

  return { connected, events, games, activeGameId, spectate };
}
