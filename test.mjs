// Runs before every build: if the rules that turn a fund house's portfolio into the app's
// figures break, the job stops and the site keeps last week's data.
import { shape } from './build.mjs';

let fails = 0;
const ok = (c, m) => {
  if (!c) {
    fails++;
    console.log('  FAIL: ' + m);
  }
};
const near = (a, b, e = 0.002) => Math.abs(a - b) < e;
const bands = new Map([
  ['INE040A01034', 'L'],
  ['INE000M00001', 'M'],
]);
const row = (holding_type, pct_nav, extra = {}) => ({ holding_type, pct_nav, section: '', instrument: 'X', isin: null, industry: null, rating: null, ...extra });

console.log('--- an equity fund, with foreign shares and a REIT ---');
const flexi = shape(
  {
    holdings: [
      row('equity', 40, { isin: 'INE040A01034', instrument: 'HDFC Bank', industry: 'Banks' }),
      row('equity', 20, { isin: 'INE000M00001', instrument: 'Mid Co', industry: 'IT - Software' }),
      row('equity', 10, { isin: 'INE999S00001', instrument: 'Small Co', industry: 'It - software' }),
      row('equity', 12, { isin: 'US02079K3059', instrument: 'Alphabet', industry: 'Computer Software ##' }),
      row('equity', 6, { section: '(b) Reits', instrument: 'Embassy Office Parks REIT' }),
      row('cash', 12),
    ],
  },
  bands,
);
ok(!flexi.error, 'accepted');
ok(near(flexi.mix.equityIndia, 0.7) && near(flexi.mix.equityForeign, 0.12) && near(flexi.mix.reit, 0.06), 'Indian, foreign and REIT apart');
ok(near(flexi.cap.large, 40 / 70) && near(flexi.cap.mid, 20 / 70) && near(flexi.cap.small, 10 / 70), 'company size from the NSE lists, as a share of Indian equity');
ok(flexi.equity.find((e) => e[1] === 'Alphabet')[2] === 'Foreign equity', "a foreign share's sector is not mixed into India's");
ok(flexi.equity.filter((e) => e[2] === 'IT - Software').length === 2, 'one spelling per sector');

console.log('--- hedges, both conventions ---');
const beside = shape({ holdings: [row('equity', 70, { isin: 'INE040A01034' }), row('derivative', -30, { section: 'Futures', instrument: 'HDFC BANK-27-Oct' }), row('debt', 20), row('cash', 10)] }, bands);
ok(near(beside.mix.equityIndia, 0.4) && near(beside.mix.cash, 0.4), 'rows add to 100% on their own: 70 shares less 30 hedged = 40 equity, the 30 counts as cash');
ok(near(beside.equity[0][3], 40), "the company's weight is cut to the unhedged part");
const netted = shape({ holdings: [row('equity', 78, { isin: 'INE040A01034' }), row('derivative', -80, { section: 'Derivatives', instrument: 'X Future' }), row('cash', 102)] }, bands);
ok(!netted.error && near(netted.mix.cash, 1, 0.01), 'cash inflated by the hedge: an arbitrage fund comes out as cash');
const misfiled = shape({ holdings: [row('equity', 70, { isin: 'INE040A01034' }), row('fund_unit', -70, { section: 'Units of an AIF', instrument: 'HDFC Bank $$' }), row('cash', 30)] }, bands);
ok(!misfiled.error && misfiled.mix.cash > 0.95, 'a short future filed as a negative "fund unit" is still a hedge');
const receivable = shape({ holdings: [row('equity', 102, { isin: 'INE040A01034' }), row('other', -2, { instrument: 'Net Receivables / (Payables)' })] }, bands);
ok(!receivable.error && near(receivable.mix.equityIndia, 1), 'negative net receivables are not a hedge');

console.log('--- debt ---');
const debt = shape(
  {
    holdings: [
      row('debt', 40, { instrument: '7.18% Government of India 2033', rating: 'SOVEREIGN' }),
      row('debt', 30, { instrument: 'X Ltd NCD', rating: 'CRISIL AAA' }),
      row('equity', 10, { instrument: 'Y Ltd NCD', industry: 'CRISIL AA+' }),
      row('money_market', 15, { instrument: 'Z Bank CD', rating: 'ICRA A1+' }),
      row('cash', 5),
    ],
  },
  bands,
);
ok(near(debt.mix.debt, 0.8) && near(debt.mix.cash, 0.2) && debt.equity.length === 0, 'a bond filed upstream as a share is put back as debt');
ok(near(debt.ratings.sovereign, 40 / 95) && near(debt.ratings.aaa, 45 / 95) && near(debt.ratings.aa, 10 / 95), 'ratings: sovereign, AAA (incl. A1+), AA');

console.log('--- refused ---');
ok(shape({ holdings: [row('equity', 30)] }, bands).error, 'a portfolio that adds up to 30% is refused, not shown');
ok(shape({ holdings: [row('cash', 10166)] }, bands).error, 'and one that adds up to 10,166%');

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL HOLDINGS-JOB CHECKS PASSED');
process.exit(fails ? 1 : 0);
