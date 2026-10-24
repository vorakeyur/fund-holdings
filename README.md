# Fund holdings for Family Portfolio Tracker

A weekly job that publishes what Indian mutual funds hold, for the app's **Fund X-ray**.
Static JSON on GitHub Pages; no server, no cost.

- `v1/index.json` — AMFI scheme code → portfolio id, and each portfolio's as-of date
- `v1/p/{id}.json` — one portfolio: asset mix, company-size split, every equity holding
  (ISIN, name, sector, % of the fund, size band), debt ratings and the largest debt holdings

## Where the data comes from

- **Portfolios:** each fund house's monthly portfolio disclosure, which SEBI requires them to
  publish. They are read as already parsed by the open-source
  [fund-disclosures](https://github.com/kushagra-agarwal-a/fund-disclosures) project (MIT) and
  its published data, [fund-holdings-data](https://github.com/kushagra-agarwal-a/fund-holdings-data).
  With thanks to its author.
- **Company size:** NSE's Nifty 100 (large) and Nifty Midcap 150 (mid) member lists — the same
  top-100 / next-150 ranking SEBI uses; every other company is small.

Holdings are usually 2–6 weeks old: a month's portfolio is published within about ten days of
month-end. Every file carries its as-of date and the app shows it.

## Checks

`test.mjs` runs before each build. A portfolio whose holdings don't add up to 85–115% is not
published; the previous week's copy is kept instead. If the source can't be read at all, the
job fails and the site keeps serving the last good build.

Not investment advice.
