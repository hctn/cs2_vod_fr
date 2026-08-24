import express from "express";
import cors from "cors";
import HLTV from "hltv";

/* ============================================================================
   CS2 VOD FR — Proxy HLTV
   Petit serveur Express qui expose GET /match/:id et renvoie les infos d'un
   match HLTV (équipes, tournoi, étape, format) au format attendu par App.jsx.

   Déploiement Render :
     - Build command : npm install
     - Start command : npm start
     - Le plan gratuit se met en veille après inactivité, d'où le ~30s de
       "cold start" au premier appel, déjà géré côté front (App.jsx).
   ============================================================================ */

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // ouvert à tous les domaines : c'est une API publique en lecture seule

// --- Petit cache mémoire pour éviter de re-scraper HLTV à chaque appel -----
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map();

function getCached(id) {
  const entry = cache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(id);
    return null;
  }
  return entry.data;
}

function setCached(id, data) {
  cache.set(id, { data, timestamp: Date.now() });
}

// --- Mise en forme de la réponse HLTV vers un format simple et stable ------
function simplifyMatch(raw, id) {
  const teamA = raw?.team1?.name ?? "";
  const teamB = raw?.team2?.name ?? "";
  const tournament = raw?.event?.name ?? "";
  // "significance" porte généralement l'étape du tournoi (ex: "Quarter-final")
  const stage = raw?.significance ?? "";
  const formatRaw = raw?.format ?? "";

  return {
    hltvId: String(id),
    teamA,
    teamB,
    tournament,
    stage,
    format: formatRaw,
  };
}

// --- Routes ------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "cs2-vod-fr proxy",
    usage: "GET /match/:id  (ex: /match/2374829)",
  });
});

app.get("/match/:id", async (req, res) => {
  const { id } = req.params;
  const matchId = Number(id);

  if (!Number.isInteger(matchId) || matchId <= 0) {
    return res.status(400).json({ error: "ID de match HLTV invalide." });
  }

  const cached = getCached(matchId);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const raw = await HLTV.getMatch({ id: matchId });

    if (!raw || (!raw.team1 && !raw.team2)) {
      return res
        .status(404)
        .json({ error: `Aucune donnée trouvée pour le match HLTV ${matchId}.` });
    }

    const simplified = simplifyMatch(raw, matchId);
    setCached(matchId, simplified);
    res.json(simplified);
  } catch (err) {
    console.error(`[cs2-vod-fr] Erreur pour le match ${matchId} :`, err?.message || err);
    res.status(502).json({
      error:
        "Impossible de récupérer les données depuis HLTV pour le moment (le site a peut-être bloqué la requête, ou le format de la page a changé).",
    });
  }
});

// 404 générique pour toute autre route
app.use((req, res) => {
  res.status(404).json({ error: "Route inconnue. Utilise GET /match/:id." });
});

app.listen(PORT, () => {
  console.log(`cs2-vod-fr proxy en écoute sur le port ${PORT}`);
});
