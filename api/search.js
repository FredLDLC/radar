// RADAR — proxy Serper (Google Shopping FR)
// La clé API est lue depuis la variable d'environnement SERPER_API_KEY (config Vercel).
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST uniquement' });

  const key = process.env.SERPER_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: "SERPER_API_KEY absente. Ajoute-la dans Vercel : Settings > Environment Variables, puis redeploie."
    });
  }

  const q = req.body && req.body.q ? String(req.body.q).trim() : '';
  if (!q) return res.status(400).json({ error: 'Paramètre q manquant' });

  try {
    const r = await fetch('https://google.serper.dev/shopping', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, gl: 'fr', hl: 'fr', num: 40 })
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Erreur d\'appel Serper : ' + e.message });
  }
};
