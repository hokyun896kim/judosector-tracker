// Netlify serverless proxy for Naver Finance.
// 브라우저에서 직접 못 가져오는(CORS) finance.naver.com 데이터를
// 서버 쪽에서 대신 받아와 그대로(원본 바이트) 돌려준다.
// 클라이언트는 이걸 1순위 프록시로 쓰고, 함수가 없으면(드래그&드롭 배포)
// 404로 빠르게 실패하므로 공개 프록시로 자연스럽게 폴백된다.

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  const target = event.queryStringParameters && event.queryStringParameters.url;
  if (!target) {
    return { statusCode: 400, headers: cors, body: 'missing url param' };
  }

  // 보안: 네이버 도메인만 허용 (오픈 프록시 악용 방지)
  let host;
  try {
    host = new URL(target).hostname;
  } catch (e) {
    return { statusCode: 400, headers: cors, body: 'bad url' };
  }
  if (!/(^|\.)naver\.com$/.test(host)) {
    return { statusCode: 403, headers: cors, body: 'host not allowed' };
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(target, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://finance.naver.com/',
        'Accept': 'text/html,application/json,*/*',
      },
    });
    clearTimeout(t);

    // 원본 바이트를 그대로 base64로 전달 → 클라이언트가 EUC-KR/UTF-8 자동 복원
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      statusCode: r.status,
      headers: {
        ...cors,
        'Content-Type': r.headers.get('content-type') || 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'upstream timeout' : ('proxy error: ' + e.message);
    return { statusCode: 502, headers: cors, body: msg };
  }
};
