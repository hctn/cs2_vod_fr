import express from "express";
import cors from "cors";
import { HLTV } from "hltv";

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
const HLTV_TIMEOUT_MS = 20 * 1000; // on ne laisse jamais une requête pendre indéfiniment

app.use(cors()); // ouvert à tous les domaines : c'est une API publique en lecture seule

// Log d'accès minimal : indispensable pour savoir si une requête arrive vraiment
// jusqu'ici (utile pour distinguer "le serveur ne reçoit rien" d'un vrai bug interne).
app.use((req, res, next) => {
  console.log(`[cs2-vod-fr] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// Filet de sécurité : une erreur non interceptée dans got-scraping/cheerio ne doit
// jamais faire planter tout le process (ce qui casserait TOUTES les requêtes en
// cours, pas seulement celle qui a échoué, et se traduit côté navigateur par une
// simple "Failed to fetch" impossible à diagnostiquer).
process.on("unhandledRejection", (reason) => {
  console.error("[cs2-vod-fr] Unhandled rejection :", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[cs2-vod-fr] Uncaught exception :", err);
});

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Délai dépassé (${ms / 1000}s) en interrogeant HLTV.`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
  // raw.format est un objet { type: "bo3", location?: "LAN" | "Online" }, pas une
  // simple chaîne — on en extrait le type et on le remet en majuscules (BO3).
  const format = raw?.format?.type ? String(raw.format.type).toUpperCase() : "";

  return {
    hltvId: String(id),
    teamA,
    teamB,
    tournament,
    stage,
    format,
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
    const raw = await withTimeout(HLTV.getMatch({ id: matchId }), HLTV_TIMEOUT_MS);

    if (!raw || (!raw.team1 && !raw.team2)) {
      return res
        .status(404)
        .json({ error: `Aucune donnée trouvée pour le match HLTV ${matchId}.` });
    }

    const simplified = simplifyMatch(raw, matchId);
    setCached(matchId, simplified);
    res.json(simplified);
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`[cs2-vod-fr] Erreur pour le match ${matchId} :`, message);

    if (message.includes("Délai dépassé")) {
      return res.status(504).json({
        error:
          "HLTV a mis trop de temps à répondre (probablement un blocage anti-robot). Réessaie dans quelques minutes.",
      });
    }

    res.status(502).json({
      error:
        "Impossible de récupérer les données depuis HLTV pour le moment (le site a peut-être bloqué la requête, ou le format de la page a changé).",
      detail: message,
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
