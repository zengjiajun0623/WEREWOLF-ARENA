import {
  Role,
  Phase,
  Side,
  type GameMessage,
  type NightAction,
  type VoteAction,
  type GameEvent,
  type PlayerState,
  type GameConfig,
  DEFAULT_CONFIG,
} from "./types.js";

export class WerewolfEngine {
  public gameId: string;
  public players: PlayerState[] = [];
  public phase: Phase = Phase.Lobby;
  public round: number = 0;
  public transcript: GameMessage[] = [];
  public config: GameConfig;

  private nightActions: Map<string, NightAction> = new Map();
  private votes: Map<string, VoteAction> = new Map();
  private wolfChatMessages: Map<string, string> = new Map(); // sender -> message
  private eventListeners: ((event: GameEvent) => void)[] = [];
  private currentSpeakerIndex: number = 0;
  private discussionRound: number = 0;
  private speakingOrder: PlayerState[] = [];

  constructor(gameId: string, config: Partial<GameConfig> = {}) {
    this.gameId = gameId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  onEvent(listener: (event: GameEvent) => void) {
    this.eventListeners.push(listener);
  }

  private emit(event: GameEvent) {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  addPlayer(address: string): boolean {
    if (this.phase !== Phase.Lobby) return false;
    if (this.players.length >= this.config.maxPlayers) return false;
    if (this.players.some((p) => p.address === address)) return false;

    this.players.push({ address, role: Role.Villager, alive: true });

    this.emit({
      type: "waiting_for_players",
      gameId: this.gameId,
      data: {
        playerCount: this.players.length,
        maxPlayers: this.config.maxPlayers,
        players: this.players.map((p) => p.address),
      },
    });

    if (this.players.length === this.config.maxPlayers) {
      this.startGame();
    }

    return true;
  }

  private startGame() {
    this.assignRoles();
    this.round = 1;

    for (const player of this.players) {
      this.emit({
        type: "role_assigned",
        gameId: this.gameId,
        data: {
          player: player.address,
          role: Role[player.role],
          teammates:
            player.role === Role.Werewolf
              ? this.getWerewolves().map((p) => p.address)
              : [],
        },
      });
    }

    this.emit({
      type: "game_start",
      gameId: this.gameId,
      data: {
        players: this.players.map((p) => p.address),
        round: this.round,
      },
    });

    this.startWolfChat();
  }

  private assignRoles() {
    const indices = this.players.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    // 7 players: 2 werewolves, 1 seer, 1 doctor, 3 villagers
    this.players[indices[0]].role = Role.Werewolf;
    this.players[indices[1]].role = Role.Werewolf;
    this.players[indices[2]].role = Role.Seer;
    this.players[indices[3]].role = Role.Doctor;
    // indices 4-6 stay Villager
  }

  // ── Wolf Chat ───────────────────────────────────────────────────────────────

  private startWolfChat() {
    this.phase = Phase.WolfChat;
    this.wolfChatMessages.clear();

    const wolves = this.getWerewolves().filter((p) => p.alive);
    const alive = this.getAlivePlayers();

    this.emit({
      type: "wolf_chat_start",
      gameId: this.gameId,
      data: {
        round: this.round,
        wolves: wolves.map((w) => w.address),
        alivePlayers: alive.map((p) => p.address),
      },
    });
  }

  submitWolfChat(sender: string, content: string): boolean {
    if (this.phase !== Phase.WolfChat) return false;
    const player = this.getPlayer(sender);
    if (!player || player.role !== Role.Werewolf || !player.alive) return false;

    this.wolfChatMessages.set(sender, content.slice(0, this.config.messageMaxLength));

    const wolves = this.getWerewolves().filter((p) => p.alive);

    // Broadcast to all wolves
    this.emit({
      type: "wolf_chat_message",
      gameId: this.gameId,
      data: {
        sender,
        content: content.slice(0, this.config.messageMaxLength),
        wolves: wolves.map((w) => w.address),
      },
    });

    // If all alive wolves have spoken, end wolf chat
    if (wolves.every((w) => this.wolfChatMessages.has(w.address))) {
      this.endWolfChat();
    }

    return true;
  }

  endWolfChat() {
    this.emit({
      type: "wolf_chat_end",
      gameId: this.gameId,
      data: { round: this.round },
    });
    this.startNight();
  }

  // ── Night Phase ─────────────────────────────────────────────────────────────

  private startNight() {
    this.phase = Phase.Night;
    this.nightActions.clear();

    this.emit({
      type: "night_start",
      gameId: this.gameId,
      data: {
        round: this.round,
        alivePlayers: this.getAlivePlayers().map((p) => p.address),
      },
    });
  }

  submitNightAction(actor: string, target: string): boolean {
    if (this.phase !== Phase.Night) return false;

    const player = this.getPlayer(actor);
    if (!player || !player.alive) return false;

    const targetPlayer = this.getPlayer(target);
    if (!targetPlayer || !targetPlayer.alive) return false;

    const validRoles = [Role.Werewolf, Role.Seer, Role.Doctor];
    if (!validRoles.includes(player.role)) return false;

    this.nightActions.set(actor, { actor, target });

    // Check if all night actors have submitted
    if (this.allNightActionsIn()) {
      this.resolveNight();
    }

    return true;
  }

  private allNightActionsIn(): boolean {
    const wolves = this.getWerewolves().filter((p) => p.alive);
    const seer = this.getSeer();
    const doctor = this.getDoctor();

    const wolvesReady = wolves.every((w) => this.nightActions.has(w.address));
    const seerReady = !seer?.alive || this.nightActions.has(seer.address);
    const doctorReady = !doctor?.alive || this.nightActions.has(doctor.address);

    return wolvesReady && seerReady && doctorReady;
  }

  private resolveNight() {
    // Resolve kill target (majority wolf vote)
    const killVotes = new Map<string, number>();
    for (const wolf of this.getWerewolves().filter((p) => p.alive)) {
      const action = this.nightActions.get(wolf.address);
      if (action) {
        killVotes.set(action.target, (killVotes.get(action.target) || 0) + 1);
      }
    }

    let killTarget: string | null = null;
    let maxVotes = 0;
    for (const [target, votes] of killVotes) {
      if (votes > maxVotes) {
        maxVotes = votes;
        killTarget = target;
      }
    }

    // Doctor protection
    const doctor = this.getDoctor();
    const doctorAction = doctor?.alive ? this.nightActions.get(doctor.address) : null;
    const savedTarget = doctorAction?.target ?? null;

    const wasProtected = killTarget !== null && killTarget === savedTarget;

    if (wasProtected) {
      this.emit({
        type: "doctor_saved",
        gameId: this.gameId,
        data: {
          saved: killTarget,
          round: this.round,
        },
      });
    } else if (killTarget) {
      const victim = this.getPlayer(killTarget)!;
      victim.alive = false;

      this.emit({
        type: "night_result",
        gameId: this.gameId,
        data: {
          killed: killTarget,
          killedRole: Role[victim.role],
          round: this.round,
        },
      });
    }

    // Seer result (private)
    const seer = this.getSeer();
    if (seer?.alive) {
      const seerAction = this.nightActions.get(seer.address);
      if (seerAction) {
        const inspected = this.getPlayer(seerAction.target)!;
        this.emit({
          type: "seer_result",
          gameId: this.gameId,
          data: {
            seer: seer.address,
            target: seerAction.target,
            isWerewolf: inspected.role === Role.Werewolf,
          },
        });
      }
    }

    if (this.checkWinCondition()) return;
    this.startDay();
  }

  // ── Day Phase ────────────────────────────────────────────────────────────────

  private startDay() {
    this.phase = Phase.Day;
    this.discussionRound = 0;
    this.currentSpeakerIndex = 0;

    // Shuffle speaking order once per day
    this.speakingOrder = [...this.getAlivePlayers()];
    for (let i = this.speakingOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.speakingOrder[i], this.speakingOrder[j]] = [
        this.speakingOrder[j],
        this.speakingOrder[i],
      ];
    }

    this.emit({
      type: "day_start",
      gameId: this.gameId,
      data: {
        round: this.round,
        alivePlayers: this.speakingOrder.map((p) => p.address),
        discussionRounds: this.config.discussionRounds,
      },
    });

    this.requestNextSpeaker();
  }

  private requestNextSpeaker() {
    if (this.currentSpeakerIndex >= this.speakingOrder.length) {
      this.discussionRound++;
      if (this.discussionRound >= this.config.discussionRounds) {
        this.startVote();
        return;
      }
      this.currentSpeakerIndex = 0;
    }

    // Skip dead players (could die mid-discussion via future mechanics)
    while (
      this.currentSpeakerIndex < this.speakingOrder.length &&
      !this.speakingOrder[this.currentSpeakerIndex].alive
    ) {
      this.currentSpeakerIndex++;
    }

    if (this.currentSpeakerIndex >= this.speakingOrder.length) {
      this.discussionRound++;
      if (this.discussionRound >= this.config.discussionRounds) {
        this.startVote();
        return;
      }
      this.currentSpeakerIndex = 0;
    }

    const speaker = this.speakingOrder[this.currentSpeakerIndex];
    const dayTranscript = this.transcript.filter(
      (m) => m.round === this.round && m.phase === Phase.Day
    );

    this.emit({
      type: "speak_turn",
      gameId: this.gameId,
      data: {
        speaker: speaker.address,
        discussionRound: this.discussionRound,
        transcript: dayTranscript,
        alivePlayers: this.getAlivePlayers().map((p) => p.address),
      },
    });
  }

  submitDayMessage(sender: string, content: string): boolean {
    if (this.phase !== Phase.Day) return false;

    const player = this.getPlayer(sender);
    if (!player || !player.alive) return false;

    if (this.speakingOrder[this.currentSpeakerIndex]?.address !== sender) return false;

    const message: GameMessage = {
      gameId: this.gameId,
      round: this.round,
      phase: Phase.Day,
      sender,
      content: content.slice(0, this.config.messageMaxLength),
      timestamp: Date.now(),
    };

    this.transcript.push(message);

    this.emit({
      type: "day_message",
      gameId: this.gameId,
      data: { message },
    });

    this.currentSpeakerIndex++;
    this.requestNextSpeaker();

    return true;
  }

  // ── Vote Phase ───────────────────────────────────────────────────────────────

  private startVote() {
    this.phase = Phase.Vote;
    this.votes.clear();

    this.emit({
      type: "vote_start",
      gameId: this.gameId,
      data: {
        round: this.round,
        alivePlayers: this.getAlivePlayers().map((p) => p.address),
        transcript: this.transcript.filter((m) => m.round === this.round),
      },
    });
  }

  submitVote(voter: string, target: string): boolean {
    if (this.phase !== Phase.Vote) return false;

    const player = this.getPlayer(voter);
    if (!player || !player.alive) return false;

    const targetPlayer = this.getPlayer(target);
    if (!targetPlayer || !targetPlayer.alive) return false;
    if (voter === target) return false;

    this.votes.set(voter, { voter, target });

    if (this.votes.size === this.getAlivePlayers().length) {
      this.resolveVote();
    }

    return true;
  }

  private resolveVote() {
    const voteCounts = new Map<string, number>();
    const voteDetails: Record<string, string> = {};

    for (const [voter, vote] of this.votes) {
      voteCounts.set(vote.target, (voteCounts.get(vote.target) || 0) + 1);
      voteDetails[voter] = vote.target;
    }

    let eliminated: string | null = null;
    let maxVotes = 0;
    for (const [target, count] of voteCounts) {
      if (count > maxVotes) {
        maxVotes = count;
        eliminated = target;
      }
    }

    // Tie = no elimination
    const tiedPlayers = [...voteCounts.entries()].filter(([, c]) => c === maxVotes);
    if (tiedPlayers.length > 1) eliminated = null;

    this.emit({
      type: "vote_result",
      gameId: this.gameId,
      data: {
        votes: voteDetails,
        voteCounts: Object.fromEntries(voteCounts),
        eliminated,
        round: this.round,
      },
    });

    if (eliminated) {
      const victim = this.getPlayer(eliminated)!;
      victim.alive = false;
      this.emit({
        type: "player_eliminated",
        gameId: this.gameId,
        data: { eliminated, role: Role[victim.role], round: this.round },
      });
    }

    if (this.checkWinCondition()) return;

    this.round++;
    this.startWolfChat();
  }

  // ── Win Condition ────────────────────────────────────────────────────────────

  private checkWinCondition(): boolean {
    const aliveWolves = this.getWerewolves().filter((p) => p.alive).length;
    const aliveVillagers = this.getAlivePlayers().length - aliveWolves;

    let winner: Side | null = null;
    if (aliveWolves === 0) winner = Side.Villagers;
    else if (aliveWolves >= aliveVillagers) winner = Side.Werewolves;

    if (!winner) return false;

    this.phase = Phase.Finished;

    const winners = this.players
      .filter((p) => winner === Side.Villagers ? p.role !== Role.Werewolf : p.role === Role.Werewolf)
      .map((p) => p.address);
    const losers = this.players
      .filter((p) => winner === Side.Villagers ? p.role === Role.Werewolf : p.role !== Role.Werewolf)
      .map((p) => p.address);

    this.emit({
      type: "game_over",
      gameId: this.gameId,
      data: {
        winner,
        winners,
        losers,
        roles: Object.fromEntries(this.players.map((p) => [p.address, Role[p.role]])),
        transcript: this.transcript,
        rounds: this.round,
      },
    });

    return true;
  }

  // ── Timeout Handlers ─────────────────────────────────────────────────────────

  forceWolfChatEnd() {
    if (this.phase !== Phase.WolfChat) return;
    this.endWolfChat();
  }

  forceNightResolve() {
    if (this.phase !== Phase.Night) return;
    const alive = this.getAlivePlayers();

    for (const wolf of this.getWerewolves().filter((p) => p.alive)) {
      if (!this.nightActions.has(wolf.address)) {
        const targets = alive.filter((p) => p.role !== Role.Werewolf);
        const t = targets[Math.floor(Math.random() * targets.length)];
        if (t) this.nightActions.set(wolf.address, { actor: wolf.address, target: t.address });
      }
    }

    const seer = this.getSeer();
    if (seer?.alive && !this.nightActions.has(seer.address)) {
      const targets = alive.filter((p) => p.address !== seer.address);
      const t = targets[Math.floor(Math.random() * targets.length)];
      if (t) this.nightActions.set(seer.address, { actor: seer.address, target: t.address });
    }

    const doctor = this.getDoctor();
    if (doctor?.alive && !this.nightActions.has(doctor.address)) {
      const t = alive[Math.floor(Math.random() * alive.length)];
      if (t) this.nightActions.set(doctor.address, { actor: doctor.address, target: t.address });
    }

    this.resolveNight();
  }

  forceDayEnd() {
    if (this.phase !== Phase.Day) return;
    this.startVote();
  }

  forceVoteResolve() {
    if (this.phase !== Phase.Vote) return;
    if (this.votes.size > 0) {
      this.resolveVote();
    } else {
      this.round++;
      this.startWolfChat();
    }
  }

  // ── Getters ──────────────────────────────────────────────────────────────────

  getPlayer(address: string): PlayerState | undefined {
    return this.players.find((p) => p.address === address);
  }

  getAlivePlayers(): PlayerState[] {
    return this.players.filter((p) => p.alive);
  }

  getWerewolves(): PlayerState[] {
    return this.players.filter((p) => p.role === Role.Werewolf);
  }

  getSeer(): PlayerState | undefined {
    return this.players.find((p) => p.role === Role.Seer);
  }

  getDoctor(): PlayerState | undefined {
    return this.players.find((p) => p.role === Role.Doctor);
  }

  getGameState() {
    return {
      gameId: this.gameId,
      phase: this.phase,
      round: this.round,
      players: this.players.map((p) => ({ address: p.address, alive: p.alive })),
      transcript: this.transcript,
    };
  }
}
