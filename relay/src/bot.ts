// Built-in bot brain for backfilling empty game slots.
// Rule-based, no LLM dependency. Tracks game state for smarter play.

import { Role, Phase, type GameMessage, type PlayerState } from "./types.js";

const BOT_NAMES = [
  "Shadow", "Fang", "Luna", "Ember", "Ghost",
  "Raven", "Storm", "Frost", "Blaze", "Thorn",
  "Viper", "Sage", "Echo", "Drift", "Cinder",
  "Hawk", "Nova", "Onyx", "Dusk", "Spark",
];

let botNameIndex = 0;
export function nextBotName(): string {
  return BOT_NAMES[botNameIndex++ % BOT_NAMES.length];
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

// ── Bot dialogue lines ──────────────────────────────────────────────────────

interface SpeakContext {
  others: string[];
  round: number;
  knownRoles: Map<string, boolean>;
  suspicion: Map<string, number>;
  deaths: string[];
  role: Role;
  aliveCount: number;
}

// Villager lines — vary by round and game state
const VILLAGER_LINES: ((ctx: SpeakContext) => string)[] = [
  // Accusation based on suspicion tracking
  (ctx) => {
    const top = getTopSuspect(ctx.suspicion, ctx.others);
    return top
      ? `I keep coming back to ${top}. The way they talk doesn't match how they vote.`
      : `Something's off but I can't pin it yet. Let's see who flinches.`;
  },
  (ctx) => {
    const top = getTopSuspect(ctx.suspicion, ctx.others);
    return top
      ? `${top} has been deflecting every question. That's not how an innocent person acts.`
      : `We need to pressure people harder. Wolves hide behind vague statements.`;
  },
  // Death analysis
  (ctx) => {
    if (ctx.deaths.length > 0) {
      const last = ctx.deaths[ctx.deaths.length - 1];
      return `Think about who benefits from ${last} dying. That's your wolf.`;
    }
    return `No kills yet means the doctor is doing their job. Let's protect that advantage.`;
  },
  // Late-game urgency
  (ctx) => {
    if (ctx.aliveCount <= 4) return `We're running out of time. One wrong vote and the wolves win. Think carefully.`;
    return `Let's not waste this vote. Every round we don't eliminate a wolf, we lose ground.`;
  },
  // General reads
  (ctx) => `${pick(ctx.others)}, who do you think is a wolf and why? I want specifics, not deflection.`,
  (ctx) => `I've been watching ${pick(ctx.others)} all game. Their energy shifted after the last kill.`,
  (ctx) => `The voting record doesn't lie. Look at who's been protecting whom.`,
  (ctx) => `I'm a villager and I'll prove it with my vote. Let's coordinate.`,
  // Pressure
  (ctx) => `${pick(ctx.others)} — you've barely said anything. Silence is a wolf strategy.`,
  (ctx) => {
    const two = pickN(ctx.others, 2);
    return two.length >= 2
      ? `I'm torn between ${two[0]} and ${two[1]}. One of them is a wolf, I can feel it.`
      : `Something doesn't add up. We're missing the real wolf.`;
  },
];

// Wolf lines — deceptive, misdirecting
const WOLF_LINES: ((ctx: SpeakContext) => string)[] = [
  (ctx) => {
    const nonTeam = ctx.others;
    return `I've been thinking about this carefully — ${pick(nonTeam)} is the most suspicious player alive.`;
  },
  (ctx) => `Everyone's so focused on accusations but nobody's analyzing the actual kills. The pattern points away from me.`,
  (_) => `I'm just trying to survive like everyone else. The real wolf is the one pointing fingers the hardest.`,
  (ctx) => `${pick(ctx.others)} keeps changing their read. First one target, then another. That's classic wolf behavior.`,
  (ctx) => {
    if (ctx.deaths.length > 0) return `Why would I kill ${ctx.deaths[ctx.deaths.length - 1]}? They were helping my case. Think about it.`;
    return `Let's look at who's been consistent vs. who keeps shifting. Consistency matters.`;
  },
  (ctx) => {
    if (ctx.aliveCount <= 4) return `This is do or die. I'm voting ${pick(ctx.others)} and I'm confident about it.`;
    return `We need to slow down and think logically instead of going with gut feelings.`;
  },
  (ctx) => `${pick(ctx.others)} voted against the village consensus last round. That's a huge red flag.`,
  (ctx) => `I've got nothing to hide. Ask me anything. Meanwhile, ${pick(ctx.others)} has been dodging questions all game.`,
  (_) => `The wolves want chaos. The best thing we can do is stay calm and vote together.`,
  (ctx) => `I'll stake my life on it — ${pick(ctx.others)} is a wolf. Vote with me or we lose.`,
];

// Seer lines — reveal strategically
const SEER_LINES: ((ctx: SpeakContext) => string)[] = [
  (ctx) => {
    const wolves = [...ctx.knownRoles.entries()].filter(([, w]) => w).map(([a]) => a);
    const alive = wolves.filter((w) => ctx.others.includes(w));
    if (alive.length > 0) return `I investigated ${pick(alive)} and they are a WOLF. I'm the seer. Vote them out now.`;
    const safe = [...ctx.knownRoles.entries()].filter(([, w]) => !w).map(([a]) => a);
    const aliveSafe = safe.filter((s) => ctx.others.includes(s));
    if (aliveSafe.length > 0 && ctx.round >= 2) return `I can clear ${pick(aliveSafe)} — they're not a wolf. Focus elsewhere.`;
    return `I have a lead. Give me one more night and I'll confirm my suspicion.`;
  },
  (ctx) => {
    const wolves = [...ctx.knownRoles.entries()].filter(([, w]) => w).map(([a]) => a);
    const alive = wolves.filter((w) => ctx.others.includes(w));
    if (alive.length > 0) return `Listen to me carefully: ${pick(alive)} is a werewolf. I checked. This is not a guess.`;
    return `I'm building a picture. The wolves are nervous — I can tell from how they're talking.`;
  },
];

// Wolf chat lines
const WOLF_CHAT_LINES: ((targets: string[], ctx: { deaths: string[]; round: number }) => string)[] = [
  (targets, ctx) => {
    if (ctx.round > 1) return `${pick(targets)} is getting too close to the truth. Take them out tonight.`;
    return `Let's hit ${pick(targets)} tonight. They'll be a problem if we let them live.`;
  },
  (targets) => `Target ${pick(targets)}. Tomorrow I'll push someone else hard to split the vote.`,
  (targets) => `${pick(targets)} seems like the village leader. Kill them and the rest will panic.`,
  (targets, ctx) => {
    if (ctx.deaths.length > 0) return `Good kill last night. Now let's go for ${pick(targets)} — they're the biggest threat.`;
    return `${pick(targets)} is asking the right questions. Silence them before they find us.`;
  },
];

function getTopSuspect(suspicion: Map<string, number>, candidates: string[]): string | null {
  let best: string | null = null;
  let max = 0;
  for (const c of candidates) {
    const s = suspicion.get(c) || 0;
    if (s > max) { max = s; best = c; }
  }
  return best;
}

// ── Bot decision engine ─────────────────────────────────────────────────────

export class BotBrain {
  private address: string;
  private role: Role = Role.Villager;
  private teammates: string[] = [];
  private knownRoles: Map<string, boolean> = new Map(); // seer findings
  private lastProtected: string | null = null;
  private messagesSent: number = 0;

  // Game state tracking
  private round: number = 1;
  private deaths: string[] = [];             // players killed during the game
  private suspicion: Map<string, number> = new Map(); // accumulated suspicion per player
  private voteHistory: Map<string, string[]> = new Map(); // who voted for whom each round
  private accusers: Map<string, string[]> = new Map();  // who accused whom during day chat

  constructor(address: string) {
    this.address = address;
  }

  setRole(role: Role, teammates: string[]) {
    this.role = role;
    this.teammates = teammates;
  }

  setSeerResult(target: string, isWerewolf: boolean) {
    this.knownRoles.set(target, isWerewolf);
    if (isWerewolf) this.suspicion.set(target, (this.suspicion.get(target) || 0) + 5);
  }

  setRound(round: number) {
    this.round = round;
  }

  recordDeath(player: string) {
    this.deaths.push(player);
  }

  // Track a day message to build suspicion
  recordDayMessage(sender: string, content: string, alivePlayers: string[]) {
    // If someone accuses another player, track it
    for (const target of alivePlayers) {
      if (target !== sender && content.toLowerCase().includes(target.toLowerCase().slice(0, 8))) {
        // Sender mentioned this player — might be an accusation
        const existing = this.accusers.get(target) || [];
        if (!existing.includes(sender)) {
          existing.push(sender);
          this.accusers.set(target, existing);
          // Being accused raises suspicion slightly
          this.suspicion.set(target, (this.suspicion.get(target) || 0) + 1);
        }
      }
    }
  }

  recordVote(voter: string, target: string) {
    const roundKey = `r${this.round}`;
    const history = this.voteHistory.get(voter) || [];
    history.push(target);
    this.voteHistory.set(voter, history);
    // Voting for someone increases their suspicion from the voter's perspective
    if (voter !== this.address) {
      this.suspicion.set(target, (this.suspicion.get(target) || 0) + 1);
    }
  }

  // Day: generate a message
  speak(alivePlayers: string[]): string {
    const others = alivePlayers.filter((a) => a !== this.address);
    const ctx: SpeakContext = {
      others,
      round: this.round,
      knownRoles: this.knownRoles,
      suspicion: this.suspicion,
      deaths: this.deaths,
      role: this.role,
      aliveCount: alivePlayers.length,
    };

    if (this.role === Role.Seer && this.knownRoles.size > 0) {
      return pick(SEER_LINES)(ctx);
    }
    if (this.role === Role.Werewolf) {
      return pick(WOLF_LINES)(ctx);
    }
    return pick(VILLAGER_LINES)(ctx);
  }

  // Vote: pick a target
  vote(candidates: string[]): string {
    // Seer votes for known wolves
    if (this.role === Role.Seer) {
      const knownWolf = candidates.find((c) => this.knownRoles.get(c) === true);
      if (knownWolf) return knownWolf;
    }

    // Wolves: avoid voting for each other, target most suspicious non-wolf
    if (this.role === Role.Werewolf) {
      const nonWolves = candidates.filter((c) => !this.teammates.includes(c));
      if (nonWolves.length > 0) {
        // Vote for the most suspicious non-wolf (follow village consensus to blend in)
        const top = getTopSuspect(this.suspicion, nonWolves);
        if (top && Math.random() < 0.7) return top;
        return pick(nonWolves);
      }
    }

    // Villagers/Doctor: vote for most suspicious player
    const top = getTopSuspect(this.suspicion, candidates);
    if (top && Math.random() < 0.6) return top;
    return pick(candidates);
  }

  // Night: wolf kill — target dangerous players
  wolfKill(targets: string[]): string {
    // Prioritize players who accused wolves or are vocal
    const dangerous = targets.filter((t) => {
      const accusations = this.accusers.get(this.address)?.length || 0;
      const targetAccusations = (this.accusers.get(t) || []).length;
      // Target players who have been accusing us or are generally vocal
      return accusations > 0 || targetAccusations === 0; // quiet players are possibly seer/doctor
    });

    // Players who accused a wolf teammate are highest priority
    const accusedTeammate = targets.filter((t) => {
      for (const tm of this.teammates) {
        if ((this.accusers.get(tm) || []).includes(t)) return true;
      }
      return false;
    });

    if (accusedTeammate.length > 0 && Math.random() < 0.7) return pick(accusedTeammate);
    return pick(targets);
  }

  // Night: seer inspect
  seerInspect(targets: string[]): string {
    // Prioritize most suspicious unknown players
    const unknown = targets.filter((t) => !this.knownRoles.has(t));
    if (unknown.length > 0) {
      const top = getTopSuspect(this.suspicion, unknown);
      if (top && Math.random() < 0.6) return top;
      return pick(unknown);
    }
    return pick(targets);
  }

  // Night: doctor protect
  doctorProtect(candidates: string[]): string {
    // Protect the most vocal/accused player (likely important role)
    const choices = candidates.filter((c) => c !== this.lastProtected);
    const pool = choices.length > 0 ? choices : candidates;

    // Prefer protecting players who seem like seer (making specific accusations)
    const vocal = pool.filter((c) => (this.accusers.get(c) || []).length === 0 && this.suspicion.get(c) === undefined);
    if (vocal.length > 0 && Math.random() < 0.4) {
      const target = pick(vocal);
      this.lastProtected = target;
      return target;
    }

    const target = pick(pool);
    this.lastProtected = target;
    return target;
  }

  // Wolf chat
  wolfChat(targets: string[]): string {
    return pick(WOLF_CHAT_LINES)(targets, { deaths: this.deaths, round: this.round });
  }

  resetDay() {
    this.messagesSent = 0;
  }
}
