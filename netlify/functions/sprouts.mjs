// 헤게모니 싹 레이더 (서버) — 국내 업종/테마 ETF 일봉으로 '쉬었다가 다시 뚫는' 순간을 잡는다.
//
// 검증(2024.10~2026.10, 국내 업종·테마 ETF 279개, 신호 다음날 종가 진입, ETF 동일가중 평균 대비 초과수익):
//   예전 싹 스코어(회전율·|3M|·당일·소형·테마) TOP10      → 20일 -0.4%, 40일 -0.9%  (효과 없음)
//   싹 = 120일 신고가 재돌파(직전 20거래일엔 신고가 없음) + 3개월 상대강도 상위 20% + ETF평균 60일선 위
//        같은 날 동시 신호 ≥3개(테마 확산) → 날짜평균 20일 +4.3%(승률 69%) / 40일 +9.9%   ← S
//        2개                                → 20일 +4.1% / 40일 +7.8%                      ← A
//        단독 1개                           → 20일 +0.5% / 40일 +1.6%                      ← B(관찰)
//   돌파 대기(고점 -5% 이내·나머지 동일)    → 20일 +3.4% / 40일 +7.0%
//   청산: 40거래일 보유가 이동평균 이탈 청산보다 나았고, -10% 손절은 성과를 해치지 않았음
//   주의: 같은 테마 ETF가 겹쳐 실제 독립 표본은 적고(신호일 86일, S일 29일), 상장폐지 ETF가 빠져 있음.
//
// GET /.netlify/functions/sprouts → JSON (CDN 15분 캐시)

const CONCURRENCY = 30;
const BARS = 230;
const HOLD = 40;
const STOP = 0.10;
const EXCLUDE = /커버드콜|위클리|채권|혼합|레버리지|인버스|2X|프리미엄|인컴|타겟/;

async function fetchText(url, enc = 'euc-kr', ms = 7000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return new TextDecoder(enc).decode(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      if (attempt === 1) throw e;
    } finally { clearTimeout(t); }
  }
}
async function fetchBars(code) {
  const txt = await fetchText(`https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=${BARS}&requestType=0`);
  return [...txt.matchAll(/data="([^"]+)"/g)].map(m => { const a = m[1].split('|'); return { d: a[0], h: +a[2], c: +a[4], v: +a[5] }; });
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } } }));
  return out;
}
const pct = x => Math.round(x * 10000) / 100;

export default async () => {
  const t0 = Date.now();
  const cors = { 'Access-Control-Allow-Origin': '*' };
  try {
    const list = JSON.parse(await fetchText('https://finance.naver.com/api/sise/etfItemList.nhn?etfType=0&targetColumn=market_sum&sortOrder=desc')).result.etfItemList;
    const uni = list.filter(e => e.etfTabCode == 2 && !EXCLUDE.test(e.itemname));
    const [bench, ...bars] = await pool(['069500', ...uni.map(e => e.itemcode)], CONCURRENCY, fetchBars);
    if (!bench || bench.length < 200) throw new Error('기준 일봉 부족');
    const dates = bench.map(b => b.d), T = dates.length, di = Object.fromEntries(dates.map((d, i) => [d, i]));

    const E = [];
    uni.forEach((e, n) => {
      const arr = bars[n]; if (!arr || arr.length < 140) return;
      const C = new Array(T).fill(null), H = new Array(T).fill(null), V = new Array(T).fill(0);
      arr.forEach(b => { const i = di[b.d]; if (i != null) { C[i] = b.c; H[i] = b.h; V[i] = b.v; } });
      const first = C.findIndex(x => x != null);
      for (let t = first + 1; t < T; t++) if (C[t] == null) { C[t] = C[t - 1]; H[t] = C[t - 1]; }
      E.push({ code: e.itemcode, name: e.itemname, mc: e.marketSum, amt: e.amonut, C, H, V, first });
    });

    // ETF 동일가중 평균 지수
    const U = new Array(T).fill(0);
    for (let t = 1; t < T; t++) { let s = 0, n = 0; for (const e of E) if (t - e.first >= 5) { const x = e.C[t] / e.C[t - 1] - 1; if (Math.abs(x) < 0.3) { s += x; n++; } } U[t] = n ? s / n : 0; }
    const IU = [1]; for (let t = 1; t < T; t++) IU.push(IU[t - 1] * (1 + U[t]));
    const sma = (a, t, n) => { let s = 0; for (let j = t - n + 1; j <= t; j++) s += a[j]; return s / n; };
    const uniUp = t => IU[t] > sma(IU, t, 60);

    const START = 130;
    const hi120 = (e, t) => { let m = 0; for (let j = t - 120; j < t; j++) if (j >= e.first) m = Math.max(m, e.H[j]); return m; };
    for (const e of E) { e.nh = new Array(T).fill(false); e.hi = new Array(T).fill(null); for (let t = START; t < T; t++) if (t - e.first >= 130) { e.hi[t] = hi120(e, t); e.nh[t] = e.C[t] > e.hi[t]; } }
    // 3개월 상대강도 백분위(0=최강)
    const rsPct = new Array(T).fill(null).map(() => ({}));
    for (let t = START; t < T; t++) {
      const act = E.filter(e => t - e.first >= 130);
      act.sort((a, b) => (b.C[t] / b.C[t - 63]) - (a.C[t] / a.C[t - 63]));
      act.forEach((e, i) => { rsPct[t][e.code] = (i + 1) / act.length; });
    }
    const fresh = (e, t) => { for (let j = t - 20; j < t; j++) if (e.nh[j]) return false; return true; };
    const sig = (e, t) => e.nh[t] && fresh(e, t) && rsPct[t][e.code] != null && rsPct[t][e.code] <= 0.2 && uniUp(t);
    const cluster = new Array(T).fill(0);
    for (let t = START + 20; t < T; t++) for (const e of E) if (sig(e, t)) cluster[t]++;
    const gradeOf = t => cluster[t] >= 3 ? 'S' : cluster[t] === 2 ? 'A' : 'B';

    const L = T - 1;
    const card = (e, extra) => {
      const c = e.C, ma60 = [];
      for (let t = L - 119; t <= L; t++) ma60.push(t >= e.first + 59 ? Math.round(sma(c, t, 60)) : null);
      return Object.assign({
        code: e.code, name: e.name, mc: e.mc, amt: e.amt, price: c[L],
        r1: pct(c[L] / c[L - 1] - 1), r20: pct(c[L] / c[L - 20] - 1), r63: pct(c[L] / c[L - 63] - 1),
        rsTop: rsPct[L][e.code] != null ? Math.round(rsPct[L][e.code] * 100) : null,
        hi120: e.hi[L], gapHi: e.hi[L] ? pct(c[L] / e.hi[L] - 1) : null,
        chart: { c: c.slice(L - 119, L + 1), ma60, hi: e.hi[L] },
      }, extra);
    };

    const today = [], waiting = [], holding = [];
    for (const e of E) {
      if (L - e.first < 150) continue;
      if (sig(e, L)) { today.push(card(e, { grade: gradeOf(L), together: cluster[L] })); continue; }
      let last = null;
      for (let t = L - 1; t >= Math.max(START + 20, L - HOLD + 1); t--) if (sig(e, t)) { last = t; break; }
      if (last != null) {
        const a = last + 1, entry = e.C[a];
        holding.push(card(e, { grade: gradeOf(last), together: cluster[last], sigDate: dates[last], daysAgo: L - last, entry,
          stop: Math.round(entry * (1 - STOP)), excessSince: pct((e.C[L] / entry - 1) - (IU[L] / IU[a] - 1)), retSince: pct(e.C[L] / entry - 1),
          left: Math.max(0, HOLD - (L - a)), stopHit: e.C[L] < entry * (1 - STOP) }));
        continue;
      }
      if (!e.nh[L] && e.hi[L] && e.C[L] >= e.hi[L] * 0.95 && fresh(e, L) && rsPct[L][e.code] <= 0.2) waiting.push(card(e, {}));
    }
    today.sort((a, b) => a.rsTop - b.rsTop);
    holding.sort((a, b) => (a.grade > b.grade ? 1 : a.grade < b.grade ? -1 : a.daysAgo - b.daysAgo));
    waiting.sort((a, b) => b.gapHi - a.gapHi);

    const recent = [];
    for (let t = L; t >= L - 59; t--) if (cluster[t]) recent.push({ d: dates[t], n: cluster[t] });

    return new Response(JSON.stringify({
      asOf: dates[L], ms: Date.now() - t0, universe: E.length,
      market: { up60: uniUp(L), vs60: pct(IU[L] / sma(IU, L, 60) - 1) },
      today, holding, waiting: waiting.slice(0, 12), recent,
      rules: { hold: HOLD, stop: STOP },
    }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=900, stale-while-revalidate=3600' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message || e), ms: Date.now() - t0 }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
};
