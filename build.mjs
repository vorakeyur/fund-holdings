// Fund X-ray holdings — the weekly job behind the app's "Inside your funds" views.
//
// Reads the fund houses' monthly portfolio disclosures as already parsed and published by
// the open-source fund-disclosures project (github.com/kushagra-agarwal-a/fund-holdings-data),
// checks each one, works out what the app needs, and writes small static JSON files for
// GitHub Pages:
//
//   site/v1/index.json        scheme code → portfolio id, and each portfolio's as-of date
//   site/v1/p/{id}.json       one portfolio: mix, company size, sectors, companies, debt
//
// A portfolio that is missing upstream or fails a check is carried forward from what this
// site published last time, so a bad week upstream never empties the app. If the upstream
// catalog itself can't be read, the job fails and Pages keeps serving the last good build.
//
// Node 20+, no dependencies. Env: PREVIOUS_BASE (this site's own URL), LIMIT (testing).

import { mkdir, writeFile } from 'node:fs/promises';

const UPSTREAM = 'https://cdn.jsdelivr.net/gh/kushagra-agarwal-a/fund-holdings-data@main';
const PREVIOUS_BASE = process.env.PREVIOUS_BASE || '';
const LIMIT = Number(process.env.LIMIT || 0);
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const OUT = 'site/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

async function get(url, as = 'json', tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return as === 'json' ? await res.json() : await res.text();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------- size lists
// SEBI: large = top 100 listed companies by market value, mid = the next 150. NSE's Nifty 100
// and Nifty Midcap 150 are drawn from the same ranking and carry ISINs.
async function capBands() {
  const bands = new Map();
  for (const [file, band] of [
    ['ind_nifty100list', 'L'],
    ['ind_niftymidcap150list', 'M'],
  ]) {
    const csv = await get(`https://nsearchives.nseindia.com/content/indices/${file}.csv`, 'text');
    if (!csv) throw new Error(`NSE list ${file} missing`);
    const lines = csv.trim().split(/\r?\n/);
    const isinCol = lines[0].split(',').findIndex((h) => /isin/i.test(h));
    for (const line of lines.slice(1)) {
      const isin = line.split(',')[isinCol]?.trim();
      if (isin) bands.set(isin, band);
    }
  }
  if (bands.size < 240) throw new Error(`NSE lists look wrong: ${bands.size} companies`);
  return bands;
}

// --------------------------------------------------------------------------- one portfolio
const BUCKETS = ['equityIndia', 'equityForeign', 'reit', 'debt', 'gold', 'cash', 'other'];

function ratingBucket(rating, name) {
  const r = `${rating ?? ''}`.toUpperCase();
  const n = `${name ?? ''}`.toUpperCase();
  if (/SOV|GOI\b|G-SEC|GSEC|T-BILL|TREASURY|STATE DEVELOPMENT|\bSDL\b/.test(r) || /GOVERNMENT OF INDIA|\bGOI\b|T-BILL|TREASURY BILL|STATE DEVELOPMENT LOAN|\bSDL\b|\bGS\b|G-SEC/.test(n)) {
    return 'sovereign';
  }
  if (/AAA|A1\+/.test(r)) return 'aaa';
  if (/(^|[^A])AA[+-]?(\b|$)/.test(r)) return 'aa';
  if (/(^|[^A])A[+-]?(\b|$)|A1\b|A2\+?/.test(r)) return 'a';
  if (/BBB|BB|(^|[^A])[BCD][+-]?(\b|$)/.test(r)) return 'below';
  return 'unrated';
}

// Fund houses label Indian shares with AMFI's industry list, and foreign shares with whatever
// their overseas source used ("Computer Software: Programming, Data Processing ##"). Foreign
// shares are shown as one sector rather than mixing two naming schemes.
function sectorName(industry, foreign) {
  if (foreign) return 'Foreign equity';
  const s = `${industry ?? ''}`.replace(/[#*]+/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Unclassified';
  // One spelling per sector: "It - Software" and "IT - Software" are the same thing.
  return s
    .split(' ')
    .map((w) => (/^(it|fmcg|psu|nbfc|reit|invit|ites)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ')
    .replace(/\bAnd\b/g, '&');
}

const isFuture = (h) =>
  !/swap|\birs\b|margin|option|\bcall\b|\bput\b/i.test(`${h.instrument} ${h.section}`) && /futures?|derivative/i.test(`${h.section} ${h.instrument}`);

// A rating where an industry should be: a bond the upstream parser filed as a share.
const RATING_LIKE = /\b(crisil|icra|care|fitch|brickwork|acuite|infomerics|sovereign|sov)\b|\bind\s*a|\baaa|\baa[+-]?\b|a1\+/i;
// Net current assets and the like can be negative without being a hedge.
const BALANCING = /receivable|payable|current assets|current liabilit|net cash|margin|treps|tri-?party|reverse repo/i;

export function shape(p, bands) {
  const rows = Array.isArray(p.holdings) ? p.holdings : [];
  const pct = (h) => (Number.isFinite(Number(h.pct_nav)) ? Number(h.pct_nav) : 0);

  // A short futures position is a hedge, however it was filed: fund houses list them as
  // derivatives, and the upstream parser has been seen to file them as negative "fund units".
  const isHedge = (h) =>
    (h.holding_type === 'derivative' && isFuture(h)) ||
    (pct(h) < 0 && ['equity', 'fund_unit', 'other'].includes(h.holding_type) && !BALANCING.test(`${h.instrument} ${h.section}`));
  const ignored = (h) => h.holding_type === 'derivative' && !isFuture(h); // swaps, options, margin
  const hedges = rows.filter(isHedge);
  const plain = rows.filter((h) => !isHedge(h) && !ignored(h));
  const without = plain.reduce((s, h) => s + pct(h), 0);
  const withHedges = without + hedges.reduce((s, h) => s + pct(h), 0);
  // Two conventions: most fund houses' rows add to 100% on their own and list the hedge
  // beside them; some inflate a cash line by the hedge and only reach 100% with it netted.
  const ok = (t) => t >= 85 && t <= 115;
  const mode = ok(without) ? 'beside' : ok(withHedges) ? 'netted' : null;
  if (!mode) return { error: `holdings add up to ${without.toFixed(1)}% (${withHedges.toFixed(1)}% with hedges)` };
  const total = mode === 'beside' ? without : withHedges;

  const m = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const equity = [];
  const debt = [];
  const ratings = { sovereign: 0, aaa: 0, aa: 0, a: 0, below: 0, unrated: 0 };
  const hedgedInSection = rows.some((h) => h.holding_type === 'equity' && /arbitrage/i.test(h.section ?? ''));

  for (const h of hedges) {
    if (hedgedInSection) break; // the hedged shares are already counted as cash
    const v = pct(h);
    m.equityIndia += v; // a short future takes that much price risk off the shares held
    if (mode === 'beside') m.cash -= v; // …and the shares' value behaves like cash instead
  }

  for (const h of plain) {
    const v = pct(h);
    const isin = `${h.isin ?? ''}`.trim().toUpperCase();
    const name = `${h.instrument ?? ''}`.trim();
    const type = h.holding_type === 'equity' && RATING_LIKE.test(h.industry ?? '') ? 'debt' : h.holding_type;
    const rating = type === 'debt' && h.holding_type === 'equity' ? h.industry : h.rating;
    switch (type) {
      case 'equity': {
        if (/arbitrage/i.test(h.section ?? '')) {
          m.cash += v; // a hedged purchase: the price risk is sold off in the futures leg
          break;
        }
        if (/reit|invit/i.test(`${h.section} ${name}`)) {
          m.reit += v;
          break;
        }
        const foreign = isin && !isin.startsWith('IN');
        if (foreign) m.equityForeign += v;
        else m.equityIndia += v;
        equity.push([isin, name, sectorName(h.industry, foreign), v, foreign ? 'F' : bands.get(isin) ?? 'S']);
        break;
      }
      case 'debt':
        m.debt += v;
        ratings[ratingBucket(rating, name)] += v;
        debt.push([name, ratingBucket(rating, name), v, h.maturity_date ?? null]);
        break;
      case 'money_market':
        m.cash += v;
        ratings[ratingBucket(rating, name)] += v;
        break;
      case 'cash':
        m.cash += v;
        break;
      case 'commodity':
        m.gold += v;
        break;
      case 'fund_unit':
        if (/gold|silver/i.test(name)) m.gold += v;
        else if (/liquid|overnight|money market/i.test(name)) m.cash += v;
        else m.other += v;
        break;
      default:
        m.other += v;
    }
  }

  // Shares held in full, versus equity exposure after futures: company weights are scaled
  // by that ratio so a hedged fund doesn't look fully invested in its companies.
  const gross = equity.filter((e) => e[4] !== 'F').reduce((s, e) => s + e[3], 0);
  const net = Math.max(0, m.equityIndia);
  const scale = gross > 0 ? Math.min(1, net / gross) : 1;
  for (const e of equity) if (e[4] !== 'F') e[3] *= scale;

  for (const b of BUCKETS) m[b] = Math.max(0, m[b]);
  const sum = BUCKETS.reduce((s, b) => s + m[b], 0) || 1;
  const mix = Object.fromEntries(BUCKETS.map((b) => [b, round(m[b] / sum)]));

  const indian = equity.filter((e) => e[4] !== 'F');
  const indianTotal = indian.reduce((s, e) => s + e[3], 0);
  const cap = indianTotal > 0
    ? {
        large: round(indian.filter((e) => e[4] === 'L').reduce((s, e) => s + e[3], 0) / indianTotal),
        mid: round(indian.filter((e) => e[4] === 'M').reduce((s, e) => s + e[3], 0) / indianTotal),
        small: round(indian.filter((e) => e[4] === 'S').reduce((s, e) => s + e[3], 0) / indianTotal),
      }
    : null;
  const debtTotal = Object.values(ratings).reduce((s, v) => s + v, 0);

  return {
    total: round(total, 2),
    mix,
    cap,
    // % of the fund. Every company is kept: overlap needs the full list.
    equity: equity.sort((a, b) => b[3] - a[3]).map(([i, n, s, v, c]) => [i, n, s, round(v, 3), c]),
    ratings: debtTotal > 0 ? Object.fromEntries(Object.entries(ratings).map(([k, v]) => [k, round(v / debtTotal)])) : null,
    debt: debt.sort((a, b) => b[2] - a[2]).slice(0, 25).map(([n, r, v, mat]) => [n, r, round(v, 3), mat]),
  };
}

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------------- main
async function main() {
  const catalog = await get(`${UPSTREAM}/catalog/amfi-lookup.json`);
  if (!catalog || Object.keys(catalog).length < 1000) throw new Error('upstream catalog missing or too small');
  const bands = await capBands();

  const schemes = {};
  const portfolios = new Map(); // id → upstream url
  const meta = new Map(); // id → { amc, scheme }
  for (const r of Object.values(catalog)) {
    if (!r?.amfi_code || !r.portfolio_id || !r.has_holdings) continue;
    if (ONLY.length && !ONLY.includes(String(r.amfi_code))) continue;
    schemes[r.amfi_code] = r.portfolio_id;
    if (r.portfolio_url) portfolios.set(r.portfolio_id, r.portfolio_url);
    if (!meta.has(r.portfolio_id)) meta.set(r.portfolio_id, { amc: r.amc_name, scheme: r.parent_name || r.name });
  }
  let ids = [...portfolios.keys()];
  if (LIMIT) ids = ids.slice(0, LIMIT);

  await mkdir(`${OUT}/p`, { recursive: true });
  const asOf = {};
  const report = { fresh: 0, carried: 0, dropped: 0, problems: [] };

  await pool(ids, 12, async (id) => {
    let out = null;
    try {
      const p = await get(portfolios.get(id));
      const s = p ? shape(p, bands) : { error: 'not found upstream' };
      if (s.error) throw new Error(s.error);
      const date = p.meta?.as_of || p.meta?.period;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error('no as-of date');
      out = { v: 1, id, asOf: date, ...meta.get(id), source: p.meta?.source_file ?? null, ...s };
      report.fresh++;
    } catch (e) {
      report.problems.push(`${id} ${meta.get(id)?.scheme ?? ''}: ${e.message}`);
      const prev = PREVIOUS_BASE ? await get(`${PREVIOUS_BASE}/v1/p/${id}.json`).catch(() => null) : null;
      if (prev) {
        out = prev;
        report.carried++;
      } else {
        report.dropped++;
      }
    }
    if (out) {
      asOf[id] = out.asOf;
      await writeFile(`${OUT}/p/${id}.json`, JSON.stringify(out));
    }
  });

  for (const [code, id] of Object.entries(schemes)) if (!asOf[id]) delete schemes[code];
  await writeFile(
    `${OUT}/index.json`,
    JSON.stringify({
      v: 1,
      generatedAt: new Date().toISOString(),
      sources: {
        portfolios:
          "Fund houses' monthly portfolio disclosures (SEBI-mandated), as parsed by the open-source fund-disclosures project: github.com/kushagra-agarwal-a/fund-holdings-data",
        companySize: 'NSE Nifty 100 (large) and Nifty Midcap 150 (mid) member lists; everything else small',
      },
      schemes,
      asOf,
    }),
  );
  console.log(`portfolios: ${report.fresh} fresh, ${report.carried} carried forward, ${report.dropped} dropped; schemes ${Object.keys(schemes).length}`);
  for (const p of report.problems.slice(0, 40)) console.log('  ' + p);
}

if (process.argv[1] && process.argv[1].endsWith('build.mjs')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
