# btc-race-24h-20261123-0511

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/0xfari/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/0xfari/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

Tidehunter: a two-leg cbBTC/USDC bot on 1-minute bars. It buys pullbacks to the fast EMA only while the slow EMA is rising (the regime filter), and buys washout dips only once the bounce is confirmed by the fast EMA — every leg under the same discipline of 1.2% take-profit, 0.6% trailing stop, 0.7% hard stop and 300-bar max hold, standing down after two losing round trips. A small blind late-day trade is guardrail insurance if nothing has fired by bar 1200. Dev-window grade: +$11.29 net PnL, 4 round trips, 0.71% max drawdown.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun/btc-race-24h-20261123-0511/entry --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=9z46ypvf&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
