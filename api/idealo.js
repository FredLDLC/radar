// RADAR — source idealo.fr : recherche produit + extraction des offres marchands
// Ne consomme pas de crédit Serper (lecture directe des pages idealo).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST uniquement' });

  const q = req.body && req.body.q ? String(req.body.q).trim() : '';
  if (!q) return res.status(400).json({ error: 'Paramètre q manquant' });

  try {
    // 1) Trouver les pages produit idealo correspondantes
    let productUrls = [];
    let searchNote = '';
    try {
      const sr = await fetch('https://www.idealo.fr/resultats.html?q=' + encodeURIComponent(q), { headers: HEADERS });
      if (sr.ok) {
        const html = await sr.text();
        productUrls = extractProductUrls(html);
      } else {
        searchNote = 'Recherche idealo refusée (HTTP ' + sr.status + ')';
      }
    } catch (e) { searchNote = 'Recherche idealo inaccessible : ' + e.message; }

    // Fallback : recherche Google (Serper) limitée à idealo.fr — 1 crédit
    if (!productUrls.length && process.env.SERPER_API_KEY) {
      try {
        const gr = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: 'site:idealo.fr/prix ' + q, gl: 'fr', hl: 'fr', num: 10 })
        });
        const gd = await gr.json();
        productUrls = (gd.organic || [])
          .map(o => o.link)
          .filter(l => /idealo\.fr\/prix\/\d+/.test(l))
          .slice(0, 3);
        if (productUrls.length) searchNote += (searchNote ? ' — ' : '') + 'URL trouvée via Google (1 crédit Serper)';
      } catch (e) { /* ignore */ }
    }

    if (!productUrls.length) {
      return res.status(200).json({ products: [], note: searchNote || 'Produit introuvable sur idealo pour cette requête.' });
    }

    // 2) Lire chaque page produit (max 3, en parallèle) et extraire les offres
    const pages = await Promise.all(productUrls.slice(0, 3).map(async (url) => {
      try {
        const pr = await fetch(url, { headers: HEADERS });
        if (!pr.ok) return { url, error: 'HTTP ' + pr.status };
        const html = await pr.text();
        return { url, title: extractTitle(html), offers: extractOffers(html) };
      } catch (e) { return { url, error: e.message }; }
    }));

    return res.status(200).json({ products: pages, note: searchNote });
  } catch (e) {
    return res.status(502).json({ error: 'Erreur idealo : ' + e.message });
  }
};

function extractProductUrls(html) {
  const re = /\/prix\/(\d+)\/[a-z0-9%-]+\.html/gi;
  const seen = new Set();
  const urls = [];
  let m;
  while ((m = re.exec(html)) !== null && urls.length < 3) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    urls.push('https://www.idealo.fr' + m[0]);
  }
  return urls;
}

function extractTitle(html) {
  const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
  if (og) return decodeEntities(og[1]);
  const t = html.match(/<title>([^<]+)<\/title>/i);
  return t ? decodeEntities(t[1].replace(/\s*(au meilleur prix|:).*$/i, '').trim()) : '';
}

// Extraction des offres : plusieurs stratégies, on fusionne.
function extractOffers(html) {
  const offers = [];
  const push = (merchant, price, link) => {
    merchant = decodeEntities(String(merchant)).replace(/\s+/g, ' ').trim();
    const p = parseFloat(String(price).replace(',', '.'));
    if (!merchant || !p || p <= 0) return;
    if (link && link.startsWith('/')) link = 'https://www.idealo.fr' + link;
    offers.push({ merchant, price: p, link: link || '' });
  };

  // Stratégie A : blocs JSON embarqués ("shopName" ... "price" ou l'inverse)
  let m;
  const reA1 = /"shopName"\s*:\s*"([^"]{2,60})"[^{}]{0,400}?"price"\s*:\s*"?(\d+(?:[.,]\d+)?)/g;
  while ((m = reA1.exec(html)) !== null) push(m[1], m[2], '');
  const reA2 = /"price"\s*:\s*"?(\d+(?:[.,]\d+)?)"?[^{}]{0,400}?"shopName"\s*:\s*"([^"]{2,60})"/g;
  while ((m = reA2.exec(html)) !== null) push(m[2], m[1], '');

  // Stratégie B : liens relocator (redirection marchand) avec prix en paramètre,
  // nom du marchand cherché dans les ~500 caractères autour (alt= ou texte de lien)
  const reB = /href="([^"]*relocator\/relocate\?[^"]*price=(\d+(?:\.\d+)?)[^"]*)"/g;
  while ((m = reB.exec(html)) !== null) {
    const link = m[1].replace(/&amp;/g, '&');
    const price = m[2];
    const ctx = html.slice(Math.max(0, m.index - 500), m.index + m[0].length + 500);
    let merchant = '';
    const alt = ctx.match(/alt="([^"]{2,60})"/);
    const shopSpan = ctx.match(/(?:shop|merchant|marchand)[^>]*>([^<]{2,60})</i);
    const textLink = ctx.match(/>\s*([A-Za-z0-9][^<>]{1,50}?(?:\.com|\.fr)(?:\s*\(Marketplace\))?)\s*</);
    if (shopSpan) merchant = shopSpan[1];
    else if (textLink) merchant = textLink[1];
    else if (alt && !/produktbild|logo idealo|^HyperX|^\d/.test(alt[1])) merchant = alt[1];
    if (merchant) push(merchant, price, link);
  }

  // Déduplication : on garde le prix le plus bas par marchand
  const bestByMerchant = {};
  for (const o of offers) {
    const k = o.merchant.toLowerCase();
    if (!bestByMerchant[k] || o.price < bestByMerchant[k].price ||
        (o.price === bestByMerchant[k].price && o.link && !bestByMerchant[k].link)) {
      bestByMerchant[k] = o;
    }
  }
  return Object.values(bestByMerchant).sort((a, b) => a.price - b.price);
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
