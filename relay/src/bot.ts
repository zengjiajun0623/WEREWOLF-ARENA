// Built-in bot brain for backfilling empty game slots.
// Rule-based, no LLM dependency. Plays reasonably but beatable.

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

// ── Bot dialogue lines ──────────────────────────────────────────────────────

const VILLAGER_LINES = [
  (players: string[]) => `I'm watching ${pick(players)} closely. Something about their tone feels rehearsed.`,
  (players: string[]) => `${pick(players)} hasn't contributed anything useful. That's a wolf tell.`,
  (_: string[]) => `Let's focus on who benefits from last night's kill. That narrows it down.`,
  (players: string[]) => `I think ${pick(players)} is deflecting. Every time they're questioned, they redirect.`,
  (_: string[]) => `The voting patterns are the real evidence. Words are cheap.`,
  (players: string[]) => `Has anyone noticed ${pick(players)} is agreeing with everyone? That's suspicious.`,
  (_: string[]) => `I'm a villager. I have nothing to hide. Let's find these wolves.`,
  (players: string[]) => `${pick(players)}, who do YOU think is the wolf? Forcing a read separates wolves from villagers.`,
];

const WOLF_LINES = [
  (players: string[]) => `I'm suspicious of ${pick(players)}. They've been too quiet.`,
  (_: string[]) => `Let's not rush to judgment. We need more information before we vote.`,
  (players: string[]) => `${pick(players)} is trying to lead the conversation. Classic wolf move.`,
  (_: string[]) => `I'm just a villager trying to survive. Let's think logically.`,
  (players: string[]) => `Something about ${pick(players)}'s argument doesn't add up.`,
  (_: string[]) => `We should focus on behavior, not accusations. Who changed their story?`,
  (players: string[]) => `I've been analyzing the voting patterns. ${pick(players)} voted against the grain.`,
  (_: string[]) => `The real wolves are the ones pushing hardest for a specific target.`,
];

const SEER_LINES = [
  (players: string[], findings: Map<string, boolean>) => {
    const wolves = [...findings.entries()].filter(([, w]) => w).map(([a]) => a);
    if (wolves.length > 0) return `I have information. I inspected ${pick(wolves)} and they ARE a werewolf. Vote them out.`;
    const safe = [...findings.entries()].filter(([, w]) => !w).map(([a]) => a);
    if (safe.length > 0) return `I can confirm ${pick(safe)} is safe. I know this for a fact.`;
    return `I'm gathering information. Give me one more night and I'll have something concrete.`;
  },
];

const WOLF_CHAT_LINES = [
  (targets: string[]) => `Let's kill ${pick(targets)} tonight. They seem like the biggest threat.`,
  (targets: string[]) => `Target ${pick(targets)}. Tomorrow I'll vote differently from you to stay hidden.`,
  (targets: string[]) => `${pick(targets)} is asking too many questions. Eliminate them tonight.`,
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Bot decision engine ─────────────────────────────────────────────────────

export class BotBrain {
  private address: string;
  private role: Role = Role.Villager;
  private teammates: string[] = [];
  private knownRoles: Map<string, boolean> = new Map();
  private lastProtected: string | null = null;
  private messagesSent: number = 0;

  constructor(address: string) {
    this.address = address;
  }

  setRole(role: Role, teammates: string[]) {
    this.role = role;
    this.teammates = teammates;
  }

  setSeerResult(target: string, isWerewolf: boolean) {
    this.knownRoles.set(target, isWerewolf);
  }

  // Day: generate a message
  speak(alivePlayers: string[]): string {
    const others = alivePlayers.filter((a) => a !== this.address);

    if (this.role === Role.Seer && this.knownRoles.size > 0) {
      return pick(SEER_LINES)(others, this.knownRoles);
    }

    if (this.role === Role.Werewolf) {
      return pick(WOLF_LINES)(others);
    }

    return pick(VILLAGER_LINES)(others);
  }

  // Vote: pick a target
  vote(candidates: string[]): string {
    // Seer votes for known wolves
    if (this.role === Role.Seer) {
      const knownWolf = candidates.find((c) => this.knownRoles.get(c) === true);
      if (knownWolf) return knownWolf;
    }

    // Wolves avoid voting for each other
    if (this.role === Role.Werewolf) {
      const nonWolves = candidates.filter((c) => !this.teammates.includes(c));
      if (nonWolves.length > 0) return pick(nonWolves);
    }

    return pick(candidates);
  }

  // Night: wolf kill
  wolfKill(targets: string[]): string {
    return pick(targets);
  }

  // Night: seer inspect
  seerInspect(targets: string[]): string {
    // Don't re-inspect known players
    const unknown = targets.filter((t) => !this.knownRoles.has(t));
    return pick(unknown.length > 0 ? unknown : targets);
  }

  // Night: doctor protect
  doctorProtect(candidates: string[]): string {
    // Don't protect same person twice
    const choices = candidates.filter((c) => c !== this.lastProtected);
    const target = pick(choices.length > 0 ? choices : candidates);
    this.lastProtected = target;
    return target;
  }

  // Wolf chat
  wolfChat(targets: string[]): string {
    return pick(WOLF_CHAT_LINES)(targets);
  }

  resetDay() {
    this.messagesSent = 0;
  }
}
