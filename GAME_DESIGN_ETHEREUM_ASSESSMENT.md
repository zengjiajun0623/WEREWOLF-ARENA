# Werewolf Arena: Game Design & Ethereum Assessment

## Executive Summary

Werewolf Arena is an AI-agent-driven social deduction game with on-chain settlement and spectator betting. The architecture is sound: a WebSocket relay orchestrates games off-chain for speed, while Solidity contracts handle economics (entry fees, prize distribution, parimutuel betting). The "operator loop" — where humans author strategies and agents learn via memory files — is the project's most distinctive innovation.

This assessment identifies **critical issues**, **game design improvements**, and **Ethereum/tokenomics enhancements** across the full stack.

---

## Part 1: Game Design Assessment

### 1.1 What Works Well

- **Hidden roles until game end** — prevents metagaming on eliminations. Strong design choice.
- **Wolf Chat phase** — gives werewolves a coordination step that mirrors real Werewolf's "eyes open" phase. Creates richer strategic depth for AI agents.
- **3-message day limit** — forces economy of language. Prevents LLM verbosity from drowning the game.
- **Operator loop (strategy.md + memory)** — this is the killer feature. It turns the game into a coaching simulator where human ingenuity meets AI execution.
- **Brain interface abstraction** — clean separation of protocol (client.ts) from decision-making (Brain). Enables heterogeneous agent populations.

### 1.2 Critical Game Design Issues

#### Issue 1: Tie votes result in no elimination (skipped turn)

**File:** `relay/src/engine.ts:393-394`

```typescript
const tiedPlayers = [...voteCounts.entries()].filter(([, c]) => c === maxVotes);
if (tiedPlayers.length > 1) eliminated = null;
```

**Problem:** With 7 players, ties are frequent (e.g., 3-3-1 or 2-2-2-1 splits). A skipped elimination is a **massive werewolf advantage** — wolves need parity, not majority, so every round without a village elimination brings wolves closer to winning for free. Sophisticated wolf agents will quickly learn to split village votes intentionally.

**Recommendation:** Implement a **runoff vote** between tied candidates. If the runoff also ties, *then* skip. This gives the village a fair second chance while still allowing the "no consensus" outcome. Alternatively, use classic Mafia rules: tied = random elimination among tied players, keeping pressure on both sides.

#### Issue 2: Wolf kill target selection with disagreement

**File:** `relay/src/engine.ts:218-228`

Wolves vote on kill targets, and the plurality wins. But with only 2 wolves, a split is always a 1-1 tie. The current code picks whichever target was iterated first (non-deterministic Map iteration order), which is effectively random.

**Recommendation:** Add explicit tie-breaking for wolf kills. Options: (a) random among tied targets (explicit, fair), (b) first wolf to submit wins (creates urgency), or (c) no kill on disagreement (adds strategic depth — wolves *must* coordinate in Wolf Chat or waste a night).

#### Issue 3: Doctor self-protection is unrestricted

**File:** `relay/src/engine.ts:189-203`

The Doctor can protect themselves every single night. In traditional Werewolf, the Doctor cannot protect the same target twice in a row. Without this constraint, a savvy Doctor agent becomes nearly invincible — wolves can never kill them, and they can safely claim Doctor knowing they can't be punished for it at night.

**Recommendation:** Track `lastProtectedTarget` on the engine side (not just the agent side) and reject repeat protections. The agent SDK already has `lastProtectedTarget` in GameContext — just enforce it server-side too.

#### Issue 4: No "dead player reveal" mechanic creates information vacuum

Currently, eliminated players' roles are never revealed until game end. While this prevents some metagaming, it also removes a core Werewolf mechanic: the information gained from flipping a dead player's card. The village has almost no way to confirm Seer claims or evaluate voting patterns without any confirmed role information.

**Recommendation:** Consider a **partial reveal** system: night kills reveal the victim's role (wolves chose them, so wolves already know), but vote eliminations keep roles hidden (the village must live with their choice). This creates asymmetric information flow that rewards careful play.

#### Issue 5: Fixed 7-player, fixed role composition

The game is locked to exactly 7 players with a fixed 2W/1S/1D/3V composition. This limits replayability and prevents scaling.

**Recommendation:** Design a role-scaling table:

| Players | Werewolves | Seer | Doctor | Villagers |
|---------|-----------|------|--------|-----------|
| 5       | 1         | 1    | 1      | 2         |
| 7       | 2         | 1    | 1      | 3         |
| 9       | 2         | 1    | 1      | 5         |
| 11      | 3         | 1    | 1      | 6         |

This also opens the door for variable entry fees and prize pools based on game size.

### 1.3 Game Balance Observations

**Werewolf win rate should be monitored.** With 2 wolves in 7 players, the theoretical balance favors the village slightly (~60/40), but the AI meta may differ significantly. The Wolf Chat phase is a major wolf advantage that traditional Werewolf doesn't always have. Consider logging win rates and auto-adjusting if one side consistently dominates (e.g., adding a Hunter role if wolves win >55% of games).

**Bot backfill quality matters.** The rule-based BotBrain (`relay/src/bot.ts`) has distinct dialogue lines per role, but its vote logic is simplistic (tracks suspicion from accusations). If bot-heavy games are common, the bot quality directly impacts game quality. A mediocre bot Seer that doesn't use its intel effectively wastes a critical village role.

---

## Part 2: Ethereum & Smart Contract Assessment

### 2.1 What Works Well

- **Clean separation of concerns** — GameFactory creates games, WerewolfGame handles individual game economics, BettingPool handles spectator betting. Good contract decomposition.
- **Protocol fee extraction** is straightforward and correctly implemented (5% BPS-based).
- **Parimutuel betting** is the right model for a binary outcome (Villagers vs. Werewolves). Simple, fair, understood by users.
- **Transcript hash on-chain** — storing the IPFS hash of the full transcript in the settlement event enables verifiability without bloating chain storage.

### 2.2 Critical Smart Contract Issues

#### Issue 1: Centralized relay is a single point of trust (and failure)

**Files:** `WerewolfGame.sol:45-48`, `BettingPool.sol:44-47`

The `relay` address has god-mode power: it settles games (choosing winners/losers), resolves betting pools, and records leaderboard results. There is **no on-chain verification** of game outcomes. A compromised or malicious relay can:
- Declare the wrong winner and steal the prize pool
- Resolve bets in favor of one side regardless of actual outcome
- Inflate leaderboard stats for any address

**Recommendation (short-term):** Use a **multi-sig** for the relay role (e.g., Gnosis Safe with 2-of-3 threshold). Even if one key is compromised, settlement requires consensus.

**Recommendation (long-term):** Implement **optimistic settlement with a challenge period**:
1. Relay posts the settlement + transcript hash
2. 24-hour challenge window opens
3. Anyone can challenge by posting the transcript (from IPFS) and proving the declared winner is incorrect
4. If no challenge, settlement finalizes
5. Challenger gets a bounty from the relay's stake

This removes blind trust in the relay while keeping the system practical.

#### Issue 2: Reentrancy risk in prize distribution

**File:** `WerewolfGame.sol:116-131`

```solidity
(bool feeSuccess,) = protocolFeeRecipient.call{value: protocolFee}("");
require(feeSuccess, "fee transfer failed");

for (uint256 i = 0; i < winners.length; i++) {
    (bool success,) = winners[i].call{value: perWinner}("");
    require(success, "winner transfer failed");
}
```

Using low-level `.call{value}` to send ETH to arbitrary addresses is reentrancy-prone. While the `state` is set to `Finished` before distribution (acting as a partial guard), the `onlyRelay` modifier means only the relay can call `settle()`, so the practical risk is low. However, this is a pattern that should be hardened.

**Recommendation:** Add OpenZeppelin's `ReentrancyGuard` to `settle()`. It's cheap insurance. Also consider a **pull-over-push** pattern: store winner balances and let winners `claim()` their prizes, similar to BettingPool's claim pattern. This also prevents a single reverting winner from bricking the entire settlement.

#### Issue 3: BettingPool fee is taken from total pool but payout math can leave dust

**File:** `BettingPool.sol:100-112`

The fee is deducted during `resolve()`, but the distributable pool calculation happens again during each `claim()`. If rounding causes the sum of individual payouts to exceed the contract's balance, the last claimer's transaction will revert.

**Recommendation:** Track the actual fee deducted during `resolve()` and store the `distributablePool` value on-chain, rather than recalculating it in `claim()`. This ensures consistency. Alternatively, add a dust sweep after all claims.

#### Issue 4: No bet deadline — bets can be placed after game outcome is known

**File:** `BettingPool.sol:54-68`

The only check is `!pools[gameId].resolved`. There is no timestamp cutoff or game-state check. An attacker watching the relay's WebSocket can see the game outcome in real-time and place a bet before the relay calls `resolve()`. This is a **frontrunning attack** that guarantees profit.

**Recommendation:** Add a `bettingDeadline` per game, set when the game transitions to `Active` state. Reject all bets after the deadline. The relay should call a `lockBetting(gameId)` function when the game starts (or even earlier, at Night phase of the final round).

#### Issue 5: WerewolfGame.sol Role enum is missing Doctor

**File:** `WerewolfGame.sol:5`

```solidity
enum Role { Villager, Werewolf, Seer }
```

The game engine has 4 roles (Villager, Werewolf, Seer, Doctor), but the contract only defines 3. When the relay settles and passes Doctor roles, they'll be mapped incorrectly. This is a **data integrity bug**.

**Recommendation:** Add `Doctor` to the enum:
```solidity
enum Role { Villager, Werewolf, Seer, Doctor }
```

### 2.3 Tokenomics Improvements

#### Proposal 1: ELO-Based Entry Fees (Skill-Weighted Staking)

Current flat 0.001 ETH entry fee doesn't account for skill disparity. A 90% win-rate agent and a brand-new agent pay the same.

**Design:**
- Introduce on-chain ELO ratings (stored in GameFactory)
- Higher-ELO games have higher entry fees (tiered: Bronze 0.001 ETH, Silver 0.005 ETH, Gold 0.01 ETH)
- Matchmaking prefers similar ELO ranges
- Creates natural skill brackets and higher-stakes games for experienced operators

#### Proposal 2: Agent NFTs & Reputation

Mint an NFT for each registered agent that accumulates on-chain reputation:
- Win streak records
- Total games played
- Favorite role performance (e.g., "best Seer: 80% village win rate when assigned Seer")
- Strategy lineage (hash of strategy.md linked to performance)

This creates a **tradeable reputation market** — operators who develop strong strategies can sell their agents. It also enables:
- Tournament entry gating (only agents with >50 games can enter high-stakes tournaments)
- Rental/delegation (lend your agent NFT to another operator)

#### Proposal 3: Season-Based Reward Pool

Implement seasons (e.g., 4-week cycles) with an accumulating reward pool:
- 1% of every game's entry fee goes to the season pool
- End-of-season prizes for top leaderboard positions
- Season NFT trophies for winners
- Resets create urgency and recurring engagement

#### Proposal 4: Spectator Prediction Markets Beyond Binary

Current betting is only Villagers vs. Werewolves. Expand to:
- **First eliminated** (who dies Night 1?)
- **Game length** (over/under N rounds)
- **MVP** (which player was most pivotal — voted by spectators post-game)
- **Role guess** (which player is the Seer? — bet placed before game end)

These micro-markets increase spectator engagement and betting volume.

#### Proposal 5: Strategy Marketplace (On-Chain)

Since strategies are the core operator asset:
- Allow operators to publish strategy hashes on-chain
- After N games, publish the strategy's win rate
- Other operators can purchase proven strategies (encrypted, delivered off-chain, hash verified)
- Revenue split: 90% to strategy author, 10% protocol fee
- Creates a self-sustaining strategy ecosystem

---

## Part 3: Architecture & Infrastructure Improvements

### 3.1 Relay-to-Chain Integration Gap

The smart contracts exist but are **not integrated with the relay server**. The relay (`relay/src/server.ts`) manages games entirely off-chain and persists to local JSON files. There is no code that calls `GameFactory.createGame()`, `WerewolfGame.settle()`, or `BettingPool.resolve()`.

**Recommendation:** Build a `ChainSettler` service that:
1. Listens to game_over events from the engine
2. Calls `settle()` on the corresponding WerewolfGame contract
3. Calls `resolve()` on the BettingPool
4. Calls `recordResult()` on the GameFactory
5. Stores the transaction hash alongside the transcript

This is the most important missing piece for making the Ethereum layer functional.

### 3.2 No TypeScript Tests

The relay and agent have zero automated tests. The game engine is complex state machine with many edge cases (ties, timeouts, role interactions). The only tests are Solidity tests for the contracts.

**Recommendation:** Add tests for:
- Engine state transitions (every phase transition)
- Edge cases: Doctor self-protect, Seer inspects wolf, tied votes, all wolves killed Night 1
- Timeout handling: random action selection, phase advancement
- Agent client: reconnection logic, message parsing

### 3.3 Transcript Integrity

Game transcripts are stored as local JSON files. There's no guarantee they haven't been tampered with. The contract stores a `transcriptHash` but nobody verifies it.

**Recommendation:** Hash the transcript on the relay side before settlement, pin it to IPFS, and pass the content hash to `settle()`. The frontend should verify that the displayed transcript matches the on-chain hash. This creates an auditable, tamper-proof game record.

---

## Part 4: Priority Ranking

| Priority | Issue | Impact | Effort |
|----------|-------|--------|--------|
| P0 | Add Doctor to contract Role enum | Data integrity bug | 5 min |
| P0 | Add betting deadline to prevent frontrunning | Economic exploit | 2 hrs |
| P1 | Implement relay-to-chain integration | Core feature gap | 1-2 weeks |
| P1 | Reentrancy guard + pull payment pattern | Security hardening | 4 hrs |
| P1 | Tied vote runoff mechanic | Game balance | 4 hrs |
| P1 | Doctor self-protection restriction | Game balance | 1 hr |
| P2 | Optimistic settlement with challenges | Decentralization | 1-2 weeks |
| P2 | Engine unit tests | Quality assurance | 1 week |
| P2 | Wolf kill tie-breaking logic | Game correctness | 1 hr |
| P2 | Variable player counts | Feature expansion | 3 days |
| P3 | ELO-based matchmaking & tiered fees | Engagement & fairness | 1-2 weeks |
| P3 | Agent NFTs & reputation system | Ecosystem depth | 2-3 weeks |
| P3 | Season-based reward pools | Retention | 1-2 weeks |
| P3 | Expanded prediction markets | Revenue & spectator engagement | 2 weeks |
| P3 | Strategy marketplace | Ecosystem moat | 3-4 weeks |

---

## Conclusion

Werewolf Arena has a strong foundation: the game engine is well-structured, the AI agent framework is elegantly designed, and the smart contracts cover the essential economics. The three highest-impact improvements are:

1. **Fix the contract Role enum and betting frontrun vulnerability** (P0 — these are bugs)
2. **Wire the relay to the smart contracts** (P1 — the Ethereum layer is currently decorative)
3. **Improve game balance** (P1 — tied votes and Doctor self-protection skew the meta)

The longer-term tokenomics proposals (ELO tiers, Agent NFTs, seasons, strategy marketplace) would transform this from a game into a platform — but only after the foundation is solid.
