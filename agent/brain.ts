// Brain interface — the operator implements this with their AI (or manually).
// The game client calls these methods when it needs a decision.

export interface GameContext {
  myAddress: string;
  myRole: string;
  alivePlayers: string[];
  round: number;
  teammates: string[];                     // only for werewolves
  knownRoles: Map<string, boolean>;        // only for seer (address -> isWerewolf)
  lastProtectedTarget: string | null;      // only for doctor
}

export interface Brain {
  // Day phase: what do you say?
  speak(ctx: GameContext, transcript: Message[]): Promise<string>;

  // Vote phase: who do you vote to eliminate? Return a player address.
  vote(ctx: GameContext, transcript: Message[], candidates: string[]): Promise<string>;

  // Night phase (werewolf): who do you kill? Return a player address.
  wolfKill(ctx: GameContext, targets: string[]): Promise<string>;

  // Night phase (seer): who do you inspect? Return a player address.
  seerInspect(ctx: GameContext, targets: string[]): Promise<string>;

  // Night phase (doctor): who do you protect? Return a player address.
  doctorProtect(ctx: GameContext, candidates: string[]): Promise<string>;

  // Wolf chat: coordinate with your teammate. Return a message.
  wolfChat(ctx: GameContext, targets: string[]): Promise<string>;

  // Called when game ends. Write memories, log results, etc.
  onGameOver(ctx: GameContext, winner: string, roles: Record<string, string>, didWin: boolean): Promise<void>;
}

export interface Message {
  sender: string;
  content: string;
}
