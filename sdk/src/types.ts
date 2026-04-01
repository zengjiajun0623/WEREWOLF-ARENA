export interface GameEvent {
  type: string;
  gameId?: string;
  data: Record<string, unknown>;
}

export interface GameState {
  gameId: string;
  phase: string;
  round: number;
  players: { address: string; alive: boolean }[];
  transcript: GameMessage[];
}

export interface GameMessage {
  gameId: string;
  round: number;
  phase: string;
  sender: string;
  content: string;
  timestamp: number;
}

export type DayHandler = (
  transcript: GameMessage[],
  alivePlayers: string[],
  myRole: string,
  myAddress: string
) => Promise<string>;

export type VoteHandler = (
  transcript: GameMessage[],
  alivePlayers: string[],
  myRole: string,
  myAddress: string
) => Promise<string>;

export type NightWerewolfHandler = (
  alivePlayers: string[],
  teammates: string[],
  myAddress: string
) => Promise<string>;

export type NightSeerHandler = (
  alivePlayers: string[],
  knownRoles: Map<string, boolean>,
  myAddress: string
) => Promise<string>;

export interface WerewolfAgentConfig {
  relayUrl: string;
  address: string;
  onDay: DayHandler;
  onVote: VoteHandler;
  onNightWerewolf?: NightWerewolfHandler;
  onNightSeer?: NightSeerHandler;
}
