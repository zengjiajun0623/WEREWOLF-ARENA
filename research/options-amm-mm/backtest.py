#!/usr/bin/env python3
"""
Backtest / Monte-Carlo sniff-test for an ETH/USD P/N option market-making
strategy on Uniswap (the "index-tracking assets on top of options" design,
ethresear.ch/t/.../25036).

The instrument (per 1 ETH locked, strike S, maturity M, index = ETH/USD price x):
    P pays  min(1, S/x) ETH   -> USD value  min(x, S)   = covered call  (the "stable" leg)
    N pays  max(0, 1-S/x) ETH -> USD value  max(0, x-S) = a call on ETH  (the "leverage" leg)
    P + N  == 1 ETH  always   -> no liquidation, only smooth drift.

What we simulate
----------------
We are the bootstrap market maker. Economically our book is a DELTA-HEDGED,
SHORT-GAMMA position (we sell P, i.e. sell a covered call, and delta-hedge the
residual on Uniswap). Its PnL decomposes cleanly into:

  total = vol_spread_pnl            (selling option at implied vol vs paying realized moves)
        + fee_income               (Uniswap LP fees == the premium edge)
        - rebalance_slippage(LVR)  (cost of re-ranging / rolling strikes)
        - gas

We Monte-Carlo ETH price paths (GBM) across vol regimes, plus a deterministic
crash, and compare against a naive DEBT/CDP baseline that gets liquidated.

Pure standard library (no numpy). Deterministic via --seed.
"""

import math
import random
import argparse
from statistics import mean, pstdev

# ----------------------------- Black-Scholes ------------------------------- #

def _norm_cdf(z):
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))

def bs_call(x, S, tau, sigma, r=0.0):
    """European call value on ETH, payoff max(0, x-S). USD value of N leg."""
    if tau <= 0:
        return max(0.0, x - S)
    if sigma <= 0:
        return max(0.0, x - S * math.exp(-r * tau))
    d1 = (math.log(x / S) + (r + 0.5 * sigma * sigma) * tau) / (sigma * math.sqrt(tau))
    d2 = d1 - sigma * math.sqrt(tau)
    return x * _norm_cdf(d1) - S * math.exp(-r * tau) * _norm_cdf(d2)

def bs_call_delta(x, S, tau, sigma, r=0.0):
    if tau <= 0:
        return 1.0 if x > S else 0.0
    if sigma <= 0:
        return 1.0 if x > S * math.exp(-r * tau) else 0.0
    d1 = (math.log(x / S) + (r + 0.5 * sigma * sigma) * tau) / (sigma * math.sqrt(tau))
    return _norm_cdf(d1)

def p_value(x, S, tau, sigma):       # USD value of the stable leg P = x - call
    return x - bs_call(x, S, tau, sigma)

# ----------------------------- Price paths -------------------------------- #

def gbm_path(x0, sigma, days, dt, drift=0.0, rng=random):
    """Daily GBM path of length days+1 (includes x0)."""
    path = [x0]
    x = x0
    for _ in range(days):
        z = rng.gauss(0.0, 1.0)
        x *= math.exp((drift - 0.5 * sigma * sigma) * dt + sigma * math.sqrt(dt) * z)
        path.append(x)
    return path

def crash_path(x0, days, total_drop=0.45, crash_day_frac=0.5):
    """Deterministic: calm, then a sharp ~total_drop crash, then flat."""
    path = [x0]
    crash_day = int(days * crash_day_frac)
    for d in range(1, days + 1):
        if d < crash_day:
            path.append(x0 * (1 - 0.0005 * d))          # slow bleed
        elif d <= crash_day + 3:                         # 3-day crash
            frac = (d - crash_day + 1) / 3.0
            path.append(x0 * (1 - 0.0005 * crash_day) * (1 - total_drop * frac))
        else:
            path.append(path[-1] * (1 + 0.0002))         # limp along
    return path

# ----------------------- One market-making path --------------------------- #

def run_mm_path(path, S, M_days, sigma_imp, notional_eth,
                fee_apr, gas_per_rebal, rebal_band, roll_trigger_buf,
                roll_slippage_bps):
    """
    Simulate the delta-hedged short-gamma MM book over one price path.
    Returns a dict of PnL components in USD (scaled to notional_eth of pairs).
    """
    days = len(path) - 1
    dt = 1.0 / 365.0
    x0 = path[0]

    # --- option / vol-spread leg: short the call N, delta-hedge daily -------
    # We are short `notional_eth` calls. Receive premium at sigma_imp, hold
    # +delta ETH as hedge, rebalanced only when price moves beyond rebal_band.
    premium0 = bs_call(x0, S, (M_days / 365.0), sigma_imp) * notional_eth
    hedge_units = bs_call_delta(x0, S, (M_days / 365.0), sigma_imp) * notional_eth  # ETH long
    hedging_pnl = 0.0
    n_rebal = 0
    last_rebal_px = x0
    days_in_band = 0          # days price within fee-earning band around the strike region
    roll_cost = 0.0
    roll_cooldown = 0         # avoid re-rolling every single day

    for d in range(1, days + 1):
        x_prev = path[d - 1]
        x = path[d]
        tau = max(1e-9, (M_days - d) / 365.0)

        # mark hedge PnL over the step (long hedge_units ETH hedges the short call)
        hedging_pnl += hedge_units * (x - x_prev)

        # fee capture: earn LP fees while price stays in a tradeable band around S
        if 0.6 * S < x < 2.2 * S:
            days_in_band += 1

        if roll_cooldown > 0:
            roll_cooldown -= 1

        # peg defense: when ETH nears the strike, re-range the LP / roll the book.
        # Settlement strike stays S (rolling = closing+reopening, modeled as a
        # one-off slippage cost + a re-hedge), so it does NOT distort vol PnL.
        near_strike = (x - S) / x < roll_trigger_buf
        if near_strike and roll_cooldown == 0:
            roll_cost += roll_slippage_bps / 1e4 * notional_eth * x
            n_rebal += 1
            roll_cooldown = 15
            hedge_units = bs_call_delta(x, S, tau, sigma_imp) * notional_eth
            last_rebal_px = x
            continue

        # delta re-hedge when price moved beyond the band since last hedge
        if abs(x - last_rebal_px) / last_rebal_px > rebal_band:
            hedge_units = bs_call_delta(x, S, tau, sigma_imp) * notional_eth
            last_rebal_px = x
            n_rebal += 1

    # terminal payoff owed on the short call (fixed strike S)
    xT = path[-1]
    payoff = max(0.0, xT - S) * notional_eth
    vol_spread_pnl = premium0 + hedging_pnl - payoff

    # fee income: APR on deployed USD notional, accrued only while in-band
    notional_usd = notional_eth * x0
    fee_income = fee_apr * notional_usd * (days_in_band / 365.0)

    gas = gas_per_rebal * n_rebal
    total = vol_spread_pnl + fee_income - roll_cost - gas

    # peg quality: how far P drifted from its target $S over the path
    p_path = [p_value(px, S, max(1e-9, (M_days - i) / 365.0), sigma_imp)
              for i, px in enumerate(path)]
    peg_min = min(p_path)
    peg_dev = (S - peg_min) / S      # worst downward drift of the stable leg

    return dict(total=total, vol_spread=vol_spread_pnl, fees=fee_income,
                roll_cost=roll_cost, gas=gas, n_rebal=n_rebal,
                premium0=premium0, xT=xT, peg_min=peg_min, peg_dev=peg_dev)

# ------------------- Debt/CDP baseline (for contrast) --------------------- #

def run_cdp_baseline(path, x0, notional_eth, ltv=0.66, liq_threshold=0.80,
                     liq_penalty=0.10):
    """
    Naive CDP: deposit ETH, borrow `ltv` of value as a stablecoin to get the
    same 'stable' exposure. Liquidated (with penalty) if debt/collateral
    crosses liq_threshold. Returns USD PnL relative to just-holding the stable
    target, to show the liquidation cliff the option design avoids.
    """
    debt = ltv * notional_eth * x0           # USD borrowed (the 'stable' exposure)
    for x in path:
        coll = notional_eth * x
        if debt / coll > liq_threshold:
            # liquidated: lose penalty * collateral, position closed
            return dict(liquidated=True, loss=liq_penalty * coll,
                        final=coll - debt - liq_penalty * coll)
    coll = notional_eth * path[-1]
    return dict(liquidated=False, loss=0.0, final=coll - debt)

# ------------------------------- Runner ----------------------------------- #

def pct(parts, p):
    s = sorted(parts)
    i = max(0, min(len(s) - 1, int(round(p / 100.0 * (len(s) - 1)))))
    return s[i]

def mc(scenario_name, sigma_real, n_paths, cfg, rng):
    results = []
    cdp_liq = 0
    for _ in range(n_paths):
        path = gbm_path(cfg['x0'], sigma_real, cfg['M_days'], 1/365.0,
                        drift=cfg['drift'], rng=rng)
        r = run_mm_path(path, cfg['S'], cfg['M_days'], cfg['sigma_imp'],
                        cfg['notional_eth'], cfg['fee_apr'], cfg['gas'],
                        cfg['rebal_band'], cfg['roll_buf'], cfg['roll_bps'])
        results.append(r)
        cdp = run_cdp_baseline(path, cfg['x0'], cfg['notional_eth'])
        if cdp['liquidated']:
            cdp_liq += 1
    totals = [r['total'] for r in results]
    cap = cfg['notional_eth'] * cfg['x0']
    print(f"\n=== {scenario_name}  (realized vol {sigma_real:.0%}, implied {cfg['sigma_imp']:.0%}) ===")
    print(f"  capital deployed         : ${cap:,.0f}  ({cfg['notional_eth']} ETH @ ${cfg['x0']:,.0f})")
    print(f"  mean total PnL           : ${mean(totals):,.0f}   "
          f"({mean(totals)/cap*100:+.2f}% over {cfg['M_days']}d, "
          f"{mean(totals)/cap*365/cfg['M_days']*100:+.1f}% APR)")
    print(f"  PnL  P5 / P50 / P95      : ${pct(totals,5):,.0f} / ${pct(totals,50):,.0f} / ${pct(totals,95):,.0f}")
    print(f"  win rate (PnL>0)         : {sum(1 for t in totals if t>0)/len(totals):.0%}")
    print(f"  avg component breakdown  : vol_spread ${mean(r['vol_spread'] for r in results):,.0f} | "
          f"fees ${mean(r['fees'] for r in results):,.0f} | "
          f"roll -${mean(r['roll_cost'] for r in results):,.0f} | "
          f"gas -${mean(r['gas'] for r in results):,.0f}")
    print(f"  avg #rebalances          : {mean(r['n_rebal'] for r in results):.1f}")
    print(f"  P leg worst drift from $S: {mean(r['peg_dev'] for r in results)*100:.2f}%  "
          f"(target ${cfg['S']:,.0f})  -- NO liquidation event ever")
    print(f"  >> DEBT/CDP baseline liquidated on {cdp_liq/n_paths:.0%} of the SAME paths")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--paths', type=int, default=4000)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--gas', type=float, default=5.0, help='USD per rebalance (L2). Try 50 for mainnet.')
    ap.add_argument('--fee-apr', type=float, default=0.15, help='Uniswap fee APR on deployed notional')
    ap.add_argument('--sigma-imp', type=float, default=0.70, help='vol we PRICE/sell at')
    args = ap.parse_args()
    random.seed(args.seed)
    rng = random

    cfg = dict(
        x0=3000.0, S=2000.0, M_days=90, drift=0.0,
        notional_eth=30.0,
        sigma_imp=args.sigma_imp,
        fee_apr=args.fee_apr,
        gas=args.gas,
        rebal_band=0.03,     # re-hedge when price moves >3% since last hedge
        roll_buf=0.10,       # roll strike down when buffer (x-S)/x < 10%
        roll_bps=30.0,       # 0.30% slippage to re-range/roll
    )

    print("#" * 74)
    print("  ETH/USD  P/N  option market-making backtest")
    print(f"  strike S=${cfg['S']:,.0f}  maturity={cfg['M_days']}d  spot=${cfg['x0']:,.0f}  "
          f"buffer={(cfg['x0']-cfg['S'])/cfg['x0']:.0%}")
    print(f"  pricing/implied vol={cfg['sigma_imp']:.0%}  fee_apr={cfg['fee_apr']:.0%}  "
          f"gas=${cfg['gas']:.0f}/rebal  paths={args.paths}")
    print("#" * 74)

    # Vol regimes: MM is profitable when realized vol < implied (sold rich) and/or fees cover LVR.
    mc("CALM market",     0.45, args.paths, cfg, rng)
    mc("BASE (fair vol)", 0.70, args.paths, cfg, rng)
    mc("VOLATILE market", 0.95, args.paths, cfg, rng)

    # Deterministic crash: show no-liquidation vs CDP cliff
    path = crash_path(cfg['x0'], cfg['M_days'], total_drop=0.45)
    r = run_mm_path(path, cfg['S'], cfg['M_days'], cfg['sigma_imp'],
                    cfg['notional_eth'], cfg['fee_apr'], cfg['gas'],
                    cfg['rebal_band'], cfg['roll_buf'], cfg['roll_bps'])
    cdp = run_cdp_baseline(path, cfg['x0'], cfg['notional_eth'])
    cap = cfg['notional_eth'] * cfg['x0']
    print(f"\n=== CRASH scenario (-45% over 3 days, ETH ${cfg['x0']:,.0f} -> ${path[-1]:,.0f}) ===")
    print(f"  P/N MM total PnL         : ${r['total']:,.0f}  ({r['total']/cap*100:+.2f}% of capital)")
    print(f"     breakdown             : vol_spread ${r['vol_spread']:,.0f} | fees ${r['fees']:,.0f} | "
          f"roll -${r['roll_cost']:,.0f} | gas -${r['gas']:,.0f}  (rolled strike, {r['n_rebal']} rebals)")
    print(f"  P leg value floor        : ${r['peg_min']:,.0f} (drifted {r['peg_dev']*100:.1f}% from $S, "
          f"GRADUAL -- holder never wiped out)")
    cdp_msg = f"LIQUIDATED, loss ${cdp['loss']:,.0f}" if cdp['liquidated'] else "survived"
    print(f"  >> DEBT/CDP on same path : {cdp_msg}")
    print()
    print("Notes: vol_spread ~ 0 when implied==realized (efficient); the durable")
    print("edge is fee_income minus LVR(roll/rebalance) minus gas. Mainnet gas")
    print("($50+) and over-frequent rolling are what kill small books.")

if __name__ == '__main__':
    main()
