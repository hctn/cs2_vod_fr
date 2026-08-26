import express from "express";
import cors from "cors";

/* ============================================================================
   CS2 VOD FR — Proxy PandaScore
   Petit serveur Express qui expose :
     GET /match/:idOrSlug   → détails d'un match par ID/slug PandaScore
     GET /search?q=...      → recherche de matchs par nom d'équipe/tournoi
   au format attendu par App.jsx, en s'appuyant sur l'API PandaScore
   (https://developers.pandascore.co).

   ⚠️ PandaScore n'autorise pas les appels directs depuis le navigateur (pas de
   CORS côté leur API) — c'est justement pour ça qu'on passe par ce proxy.

   Variable d'environnement requise sur Render :
     PANDASCORE_TOKEN = ton token PandaScore (Dashboard → Settings → Tokens)
     https://pandascore.co/settings

   Déploiement Render :
     - Build command : npm install
     - Start command : npm start
     - Le plan gratuit se met en veille après inactivité, d'où le ~30s de
       "cold start" au premier appel, déjà géré côté front (App.jsx).
   ============================================================================ */

const app = express();
const PORT = process.env.PORT || 3000;
const PANDASCORE_TOKEN = process.env.PANDASCORE_TOKEN;
const PANDASCORE_BASE = "https://api.pandascore.co";
// CS2 utilise encore le préfixe historique /csgo/ chez PandaScore (pas de /cs2/).
const CS2_MATCHES_PATH = "/csgo/matches";
// Pour une base de rediffusions, on cherche parmi les matchs déjà terminés.
const CS2_PAST_MATCHES_PATH = "/csgo/matches/past";
const REQUEST_TIMEOUT_MS = 15 * 1000;

app.use(cors()); // ouvert à tous les domaines : c'est une API publique en lecture seule

// Log d'accès minimal : utile pour savoir si une requête arrive vraiment jusqu'ici.
app.use((req, res, next) => {
  console.log(`[cs2-vod-fr] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

process.on("unhandledRejection", (reason) => {
  console.error("[cs2-vod-fr] Unhandled rejection :", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[cs2-vod-fr] Uncaught exception :", err);
});

// --- Petit cache mémoire pour éviter de re-consommer du quota à chaque appel --
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// --- Appel générique à PandaScore, avec timeout + gestion d'erreurs commune ---
async function pandaScoreFetch(path) {
  if (!PANDASCORE_TOKEN) {
    const err = new Error("MISSING_TOKEN");
    err.code = "MISSING_TOKEN";
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${PANDASCORE_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${PANDASCORE_TOKEN}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// --- Mise en forme d'un objet "Match" PandaScore vers un format simple -------
// Doc du schéma "Match" PandaScore : id, name, begin_at, opponents[], serie,
// league, tournament, number_of_games (le "Best of"), videogame, etc.
function extractMatchFields(raw) {
  const opponents = Array.isArray(raw?.opponents) ? raw.opponents : [];
  const teamA = opponents[0]?.opponent?.name ?? "";
  const teamB = opponents[1]?.opponent?.name ?? "";

  // "Nom du tournoi" = ligue + édition (ex: "IEM Katowice" + "2026" → "IEM Katowice 2026")
  const leagueName = raw?.league?.name ?? "";
  const serieName = raw?.serie?.full_name ?? "";
  const tournament = [leagueName, serieName].filter(Boolean).join(" ").trim();

  // L'étape (ex: "Quarterfinal", "Group A") est portée par l'objet "tournament" de
  // PandaScore (qui correspond à une phase à l'intérieur d'une série — nommage piégeux).
  const stage = raw?.tournament?.name ?? "";

  const format = raw?.number_of_games ? `BO${raw.number_of_games}` : "";

  return {
    pandascoreId: raw?.id != null ? String(raw.id) : "",
    teamA,
    teamB,
    tournament,
    stage,
    format,
    beginAt: raw?.begin_at ?? null,
    name: raw?.name ?? "",
  };
}

function errorPayloadFor(err) {
  if (err?.code === "MISSING_TOKEN") {
    return {
      status: 500,
      body: {
        error:
          "Le proxy n'est pas configuré : la variable d'environnement PANDASCORE_TOKEN est manquante sur Render (Dashboard → Environment).",
      },
    };
  }
  if (err?.name === "AbortError") {
    return {
      status: 504,
      body: { error: "Délai dépassé en interrogeant PandaScore. Réessaie dans un instant." },
    };
  }
  return {
    status: 502,
    body: {
      error: "Impossible de récupérer les données depuis PandaScore pour le moment.",
      detail: err?.message || String(err),
    },
  };
}

// --- Routes ------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "cs2-vod-fr proxy (PandaScore)",
    usage: [
      "GET /match/:idOrSlug   — détails d'un match PandaScore",
      "GET /search?q=...      — recherche de matchs par équipe/tournoi",
    ],
    tokenConfigured: Boolean(PANDASCORE_TOKEN),
  });
});

app.get("/match/:idOrSlug", async (req, res) => {
  const { idOrSlug } = req.params;

  if (!idOrSlug) {
    return res.status(400).json({ error: "ID ou slug de match PandaScore invalide." });
  }

  const cacheKey = `match:${idOrSlug}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const psRes = await pandaScoreFetch(`${CS2_MATCHES_PATH}/${encodeURIComponent(idOrSlug)}`);

    if (psRes.status === 404) {
      return res
        .status(404)
        .json({ error: `Aucun match PandaScore trouvé pour "${idOrSlug}".` });
    }
    if (psRes.status === 401 || psRes.status === 403) {
      return res.status(502).json({
        error:
          "PandaScore a refusé la requête (token invalide, expiré ou manquant). Vérifie PANDASCORE_TOKEN sur Render.",
      });
    }
    if (psRes.status === 429) {
      return res.status(429).json({
        error: "Quota PandaScore dépassé pour cette heure (plan gratuit : 1000 requêtes/heure).",
      });
    }
    if (!psRes.ok) {
      const bodyText = await psRes.text().catch(() => "");
      throw new Error(`PandaScore a répondu avec le statut ${psRes.status} : ${bodyText.slice(0, 200)}`);
    }

    const raw = await psRes.json();
    const simplified = extractMatchFields(raw);
    setCached(cacheKey, simplified);
    res.json(simplified);
  } catch (err) {
    console.error(`[cs2-vod-fr] Erreur pour le match ${idOrSlug} :`, err?.message || err);
    const { status, body } = errorPayloadFor(err);
    res.status(status).json(body);
  }
});

app.get("/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();

  if (!q) {
    return res.status(400).json({ error: "Paramètre de recherche 'q' manquant." });
  }

  const cacheKey = `search:${q.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    // Recherche plein-texte PandaScore sur le nom du match (souvent formé des noms
    // d'équipes). On demande le tri du plus récent au plus ancien à l'API, mais on
    // le refait nous-mêmes ci-dessous : en pratique, sort=-begin_at n'est pas fiable
    // dès que certains matchs renvoyés ont un begin_at manquant (null), ce qui les
    // mélange n'importe où dans la liste plutôt qu'à la fin.
    const params = new URLSearchParams({
      "search[name]": q,
      sort: "-begin_at",
      "page[size]": "15",
    });
    const psRes = await pandaScoreFetch(`${CS2_MATCHES_PATH}?${params.toString()}`);

    if (psRes.status === 401 || psRes.status === 403) {
      return res.status(502).json({
        error:
          "PandaScore a refusé la requête (token invalide, expiré ou manquant). Vérifie PANDASCORE_TOKEN sur Render.",
      });
    }
    if (psRes.status === 429) {
      return res.status(429).json({
        error: "Quota PandaScore dépassé pour cette heure (plan gratuit : 1000 requêtes/heure).",
      });
    }
    if (!psRes.ok) {
      const bodyText = await psRes.text().catch(() => "");
      throw new Error(`PandaScore a répondu avec le statut ${psRes.status} : ${bodyText.slice(0, 200)}`);
    }

    const rawList = await psRes.json();
    const results = Array.isArray(rawList)
      ? rawList
          .map(extractMatchFields)
          // Tri garanti du plus récent au plus ancien. Les matchs sans date connue
          // (begin_at manquant) sont relégués en fin de liste plutôt que de fausser
          // l'ordre des matchs datés.
          .sort((a, b) => {
            const timeA = a.beginAt ? new Date(a.beginAt).getTime() : -Infinity;
            const timeB = b.beginAt ? new Date(b.beginAt).getTime() : -Infinity;
            return timeB - timeA;
          })
          .slice(0, 8)
      : [];
    const payload = { results };
    setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(`[cs2-vod-fr] Erreur de recherche "${q}" :`, err?.message || err);
    const { status, body } = errorPayloadFor(err);
    res.status(status).json(body);
  }
});

// 404 générique pour toute autre route
app.use((req, res) => {
  res.status(404).json({ error: "Route inconnue. Utilise GET /match/:idOrSlug ou GET /search?q=..." });
});

app.listen(PORT, () => {
  console.log(`cs2-vod-fr proxy (PandaScore) en écoute sur le port ${PORT}`);
});
