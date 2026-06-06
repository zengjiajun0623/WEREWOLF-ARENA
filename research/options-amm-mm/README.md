# ETH/USD P/N option market-making — backtest

A Monte-Carlo sniff-test of the Uniswap market-making strategy for the
"index-tracking assets on top of options instead of debt" design
([ethresear.ch](https://ethresear.ch/t/building-index-tracking-assets-on-top-of-options-instead-of-debt/25036)).

## The instrument
Per 1 ETH locked, strike `S`, maturity `M`, index `x` = ETH/USD:

| token | ETH payoff | USD value | TradFi equivalent |
|---|---|---|---|
| `P` | `min(1, S/x)` | `min(x, S)` | covered call — the "stable / index" leg |
| `N` | `max(0, 1-S/x)` | `max(0, x-S)` | a call on ETH — the "leverage" leg |

`P + N == 1 ETH` always ⇒ **no liquidation**, only smooth drift.

## What the model does
We are the bootstrap MM. Economically the book is a **delta-hedged, short-gamma
covered-call** position (we sell `P`, hedge the residual on Uniswap). PnL is
decomposed into four honest components:

```
total = vol_spread  +  fee_income  -  roll/LVR  -  gas
```

- **vol_spread** — selling the option at *implied* vol vs paying *realized* moves.
  By construction ≈ 0 when implied == realized (validated in the BASE scenario),
  positive when we sold vol rich, negative when realized exceeds implied.
- **fee_income** — Uniswap LP fees on deployed notional; this is the durable edge.
- **roll/LVR** — slippage from re-ranging the LP / rolling the strike down as ETH
  nears `S` (peg defense).
- **gas** — per-rebalance cost (default $5 L2; try `--gas 50` for mainnet).

A naive debt/CDP baseline runs on the *same* paths to show the liquidation cliff
the option design avoids.

## Run
```bash
python3 backtest.py --paths 5000 --seed 42          # base (L2 gas, 15% fee APR)
python3 backtest.py --gas 50                         # mainnet gas
python3 backtest.py --fee-apr 0.05                   # thin-fee environment
python3 backtest.py --sigma-imp 0.85                 # quote vol richer
```
Pure standard library, deterministic via `--seed`.

## Headline findings (5000 paths, S=$2,000, spot=$3,000, 90d, implied vol 70%)

| scenario | realized vol | mean PnL | APR | win rate | CDP liquidated |
|---|---|---|---|---|---|
| Calm     | 45% | +$4,380 | +19.7% | 100% | 40% |
| Base     | 70% | +$2,775 | +12.5% | 100% | 60% |
| Volatile | 95% | +$248   | +1.1%  | 61%  | 72% |
| Crash −45% | — | −$2,862 (−3.2%) | — | — | liquidated, −$6,158 |

**Takeaways**
1. The edge is **fees minus LVR**, not the option PnL. With implied == realized,
   `vol_spread ≈ 0` and the strategy lives or dies on fee income net of
   rebalancing/gas.
2. **You must sell vol rich.** When realized vol (95%) blows past your quoted
   70%, `vol_spread` goes deeply negative and fees barely save you. Price the
   put-side skew and keep implied ≥ expected realized.
3. **Gas / over-rolling kills small books.** Mainnet gas ($50/rebal) turns the
   volatile case from +$248 to −$2,028. Run on an L2, widen rebalance bands,
   and roll on price triggers (not on a timer).
4. **The product works as advertised:** even in a −45% crash the `P` leg only
   *drifts* (~41%, gradually) and is never wiped out, while the equivalent CDP
   gets liquidated on 40–72% of paths.

## Caveats (this is a sniff-test, not production)
- GBM paths (no fat tails / jumps beyond the scripted crash); fee income is a
  parametric APR proxy, not derived from order-flow simulation.
- Fees and LVR are modeled separately to avoid double-counting; a real LP earns
  fees *and* pays LVR on the same liquidity.
- No vol-surface dynamics, no funding-rate carry, single strike/maturity.
