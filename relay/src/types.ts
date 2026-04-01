export enum Role {
  Villager = 0,
  Werewolf = 1,
  Seer = 2,
  Doctor = 3,
}

export enum Phase {
  Lobby = "lobby",
  WolfChat = "wolf_chat",
  Night = "night",
  Day = "day",
  Vote = "vote",
  Finished = "finished",
}

export enum Side {
  Villagers = "villagers",
  Werewolves = "werewolves",
}

export interface GameMessage {
  gameId: string;
  round: number;
  phase: Phase;
  sender: string;
  content: string;
  timestamp: number;
}

export interface NightAction {
  actor: string;
  target: string;
}

export interface VoteAction {
  voter: string;
  target: string;
}

export interface GameEvent {
  type:
    | "game_start"
    | "role_assigned"
    | "night_start"
    | "night_result"
    | "day_start"
    | "day_message"
    | "vote_start"
    | "vote_result"
    | "player_eliminated"
    | "game_over"
    | "seer_result"
    | "wolf_chat_start"
    | "wolf_chat_message"
    | "wolf_chat_end"
    | "doctor_saved"
    | "player_disconnected"
    | "reconnected"
    | "error"
    | "waiting_for_players";
  gameId: string;
  data: Record<string, unknown>;
}

export interface PlayerState {
  address: string;
  role: Role;
  alive: boolean;
}

export interface GameConfig {
  maxPlayers: number;
  dayDurationMs: number;        // total time for free-form discussion
  maxMessagesPerPlayer: number;  // max messages per player per day
  nightTimeoutMs: number;
  voteTimeoutMs: number;
  wolfChatTimeoutMs: number;
  messageMaxLength: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  maxPlayers: 7,
  dayDurationMs: 90_000,        // 90 seconds of free-form discussion
  maxMessagesPerPlayer: 3,       // each player can send up to 3 messages per day
  nightTimeoutMs: 60_000,
  voteTimeoutMs: 30_000,
  wolfChatTimeoutMs: 30_000,
  messageMaxLength: 800,
};
