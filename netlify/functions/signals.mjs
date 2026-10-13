// 섹터 신호 엔진 (서버) — sectors.json 구성종목 일봉으로 섹터지수를 만들고 '새 주도' 신호를 계산한다.
//
// 검증(2024.09~2026.10, 30개 섹터, 신호 다음날 종가 진입, 섹터평균 대비 초과수익):
//   새 주도 = 60일 상대강도 순위 TOP5 + 20거래일 전엔 10위 밖        → 20일 초과 +4.2%, 승률 57%
//   S 등급  = 새 주도 + 시장(섹터평균) 60일선 위 + (20일 전 15위 밖 또는 20일선 위 종목 60%↑)
//                                                                     → 20일 초과 +4.8%, 승률 58% (앞반 +3.9 / 뒷반 +6.4)
//   A 등급  = 새 주도 중 S가 아닌 것                                    → +1.2% (뒷반 -2.9, 관찰용)
//   피할 것 = 60일 상대강도 하위 3                                      → 20일 초과 -2.4%, 승률 39%
//   보유: 순위 이탈로 빨리 끊기보다 ~40거래일 보유가 건당 초과수익이 가장 컸음(+4.9%)
//   주의: 섹터 사전이 현재 대표종목 기준이라 생존편향이 있음 → 절대수치보다 신호 간 비교로 해석
//
// GET /.netlify/functions/signals  → JSON (CDN 15분 캐시)

const CONCURRENCY = 24;
const BARS = 170;
const HOLD_DAYS = 40;

async function fetchText(url, ms = 7000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      return new TextDecoder('euc-kr').decode(buf);
    } catch (e) {
      if (attempt === 1) throw e;
    } finally {
      clearTimeout(t);
    }
  }
}

async function fetchBars(symbol) {
  const txt = await fetchText(`https://fchart.stock.naver.com/sise.nhn?symbol=${symbol}&timeframe=day&count=${BARS}&requestType=0`);
  return [...txt.matchAll(/data="([^"]+)"/g)].map(m => {
    const a = m[1].split('|');
    return { d: a[0], c: +a[4], v: +a[5] };
  });
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; }
    }
  }));
  return out;
}

const sma = (a, t, n) => { let s = 0; for (let j = t - n + 1; j <= t; j++) s += a[j]; return s / n; };
const pct = x => Math.round(x * 10000) / 100;

export default async (req) => {
  const t0 = Date.now();
  const origin = new URL(req.url).origin;
  const cors = { 'Access-Control-Allow-Origin': '*' };
  try {
    const dict = (await (await fetch(origin + '/sectors.json')).json()).sectors;
    const sectors = dict.map(s => ({
      id: s.id, name: s.name, etfs: s.etfs || [],
      members: s.stocks.map(x => { const i = x.indexOf(':'); return { code: x.slice(0, i), name: x.slice(i + 1) }; }),
    }));
    const codes = [...new Set(sectors.flatMap(s => s.members.map(m => m.code)))];
    const [kospi, ...bars] = await pool(['KOSPI', ...codes], CONCURRENCY, fetchBars);
    if (!kospi || kospi.length < 140) throw new Error('KOSPI 일봉 부족');

    const dates = kospi.map(b => b.d);
    const T = dates.length;
    const di = Object.fromEntries(dates.map((d, i) => [d, i]));
    const stk = {};
    const missing = [];
    codes.forEach((c, n) => {
      const arr = bars[n];
      if (!arr || !arr.length) { missing.push(c); return; }
      const cl = new Array(T).fill(null), val = new Array(T).fill(0);
      arr.forEach(b => { const i = di[b.d]; if (i != null) { cl[i] = b.c; val[i] = b.c * b.v; } });
      stk[c] = { cl, val };
    });

    const S = sectors.length;
    const R = [], BR = [], VAL = [];
    sectors.forEach(sec => {
      const mem = sec.members.map(m => m.code).filter(c => stk[c]);
      const r = new Array(T).fill(0), br = new Array(T).fill(null), val = new Array(T).fill(0);
      for (let t = 1; t < T; t++) {
        let s = 0, n = 0, above = 0, m = 0, v = 0;
        for (const c of mem) {
          const cl = stk[c].cl;
          if (cl[t] != null && cl[t - 1] != null) {
            const x = cl[t] / cl[t - 1] - 1;
            if (Math.abs(x) < 0.31) { s += x; n++; }
          }
          v += stk[c].val[t];
          if (t >= 20 && cl[t] != null) {
            let sm = 0, k = 0;
            for (let j = t - 19; j <= t; j++) if (cl[j] != null) { sm += cl[j]; k++; }
            if (k >= 15) { m++; if (cl[t] > sm / k) above++; }
          }
        }
        r[t] = n ? s / n : 0; br[t] = m ? above / m : null; val[t] = v;
      }
      R.push(r); BR.push(br); VAL.push(val);
    });

    const U = new Array(T).fill(0);
    for (let t = 1; t < T; t++) { let s = 0; for (let k = 0; k < S; k++) s += R[k][t]; U[t] = s / S; }
    const cum = a => { const o = [1]; for (let t = 1; t < T; t++) o.push(o[t - 1] * (1 + a[t])); return o; };
    const I = R.map(cum), IU = cum(U);
    const RS = I.map(ix => ix.map((v, t) => v / IU[t]));

    // 60일 상대강도 순위 (1 = 최강)
    const rk60 = new Array(T).fill(null);
    const rk20 = new Array(T).fill(null);
    for (let t = 60; t < T; t++) {
      const o60 = [...Array(S).keys()].sort((a, b) => RS[b][t] / RS[b][t - 60] - RS[a][t] / RS[a][t - 60]);
      const o20 = [...Array(S).keys()].sort((a, b) => RS[b][t] / RS[b][t - 20] - RS[a][t] / RS[a][t - 20]);
      rk60[t] = {}; rk20[t] = {};
      o60.forEach((k, i) => { rk60[t][k] = i + 1; });
      o20.forEach((k, i) => { rk20[t][k] = i + 1; });
    }
    const uniUp = t => IU[t] > sma(IU, t, 60);
    const base = (k, t) => t >= 80 && rk60[t][k] <= 5 && rk60[t - 20][k] > 10;
    const grade = (k, t) => {
      if (!base(k, t)) return null;
      const strong = uniUp(t) && (rk60[t - 20][k] > 15 || (BR[k][t] ?? 0) >= 0.6);
      return strong ? 'S' : 'A';
    };

    const L = T - 1;
    const out = sectors.map((sec, k) => {
      // 최근 HOLD_DAYS 안에서 가장 최근 신호
      let last = null;
      for (let t = L; t >= Math.max(80, L - HOLD_DAYS + 1); t--) {
        const g = grade(k, t);
        if (g) { last = { grade: g, date: dates[t], daysAgo: L - t,
          excessSince: pct((I[k][L] / I[k][t] - 1) - (IU[L] / IU[t] - 1)) }; break; }
      }
      const v60 = sma(VAL[k], L, 60);
      const spark = RS[k].slice(L - 59).map(v => Math.round((v / RS[k][L - 59]) * 1000) / 1000);
      return {
        id: sec.id, name: sec.name, etfs: sec.etfs,
        r1: pct(R[k][L]), r5: pct(I[k][L] / I[k][L - 5] - 1), r20: pct(I[k][L] / I[k][L - 20] - 1), r60: pct(I[k][L] / I[k][L - 60] - 1),
        ex20: pct(RS[k][L] / RS[k][L - 20] - 1), ex60: pct(RS[k][L] / RS[k][L - 60] - 1),
        rk60: rk60[L][k], rk60ago: rk60[L - 20][k], rk60wk: rk60[L - 5][k], rk20: rk20[L][k],
        breadth: BR[k][L] == null ? null : Math.round(BR[k][L] * 100),
        flow: v60 > 0 ? Math.round(sma(VAL[k], L, 5) / v60 * 100) / 100 : null,
        value: Math.round(VAL[k][L]),
        ext60: pct(I[k][L] / sma(I[k], L, 60) - 1),
        signal: grade(k, L),
        last,
        approaching: !base(k, L) && rk60[L][k] <= 8 && rk60[L - 20][k] > 10 && rk60[L][k] < rk60[L - 5][k],
        avoid: rk60[L][k] >= S - 2,
        spark,
      };
    });

    const body = JSON.stringify({
      asOf: dates[L], prevDate: dates[L - 1], ms: Date.now() - t0,
      universe: { r1: pct(U[L]), r20: pct(IU[L] / IU[L - 20] - 1), up60: uniUp(L), kospi: kospi[L].c },
      missing, sectors: out,
      method: {
        holdDays: HOLD_DAYS,
        backtest: '2024.09~2026.10 · 30개 섹터 · 신호 다음날 종가 진입 · 섹터평균 대비',
        S: '20일 초과 +4.8% · 승률 58%', A: '20일 초과 +1.2% · 관찰용', avoid: '20일 초과 -2.4% · 승률 39%',
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=900, stale-while-revalidate=3600',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message || e), ms: Date.now() - t0 }), {
      status: 502, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
};
