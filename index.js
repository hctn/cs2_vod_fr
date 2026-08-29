import express from "express";
import cors from "cors";

/* ============================================================================
   CS2 VOD FR — Proxy PandaScore
   Petit serveur Express qui expose :
     GET /match/:idOrSlug         → détails d'un match par ID/slug PandaScore
     GET /search?q=...            → recherche de matchs (équipe ET/OU tournoi)
     GET /search-tournaments?q=…  → recherche de tournois (séries PandaScore)
     GET /tournament/:serieId/matches → tous les matchs d'un tournoi (import en masse)
   au format attendu par App.jsx, en s'appuyant sur l'API PandaScore
   (https://developers.pandascore.co).

   ⚠️ PandaScore n'autorise pas les appels directs depuis le navigateur (pas de
   CORS côté leur API) — c'est justement pour ça qu'on passe par ce proxy.

   Hiérarchie PandaScore : League → Series (= "tournoi" dans notre app) →
   Tournament (= une phase/stage à l'intérieur d'une série) → Match → Game.
   Piège de nommage : le "Tournament" de PandaScore correspond à notre "stage",
   pas à notre "tournament" (qui correspond à leur "Series").

   Piège n°2 (celui qui cassait la recherche par tournoi) : le champ "name"
   d'une Series ne contient souvent QUE l'édition ("2026", "Summer 2026"), pas
   le nom de la League ("Esports World Cup"). Or search[name] de PandaScore
   fait un test "le champ CONTIENT la sous-chaîne cherchée" — donc chercher
   "Esports World Cup 2026" directement sur les séries ne matche presque
   jamais. La fonction findMatchingSeries() ci-dessous corrige ça en
   cherchant aussi sur les Leagues, puis en récupérant leurs séries.

   Logos d'équipe : chaque "opponent" PandaScore expose un champ image_url
   (logo de l'équipe/joueur). On le remonte sous teamALogo / teamBLogo pour
   que le front puisse afficher les logos, notamment lors de l'import en
   masse d'un tournoi entier.

   Logo de tournoi : PandaScore ne porte PAS de logo sur l'objet "Series" —
   c'est la League parente qui a le champ image_url (ex: le logo "IEM" est
   sur la League "IEM", pas sur la série "IEM Katowice 2026"). On l'expose
   quand même côté front sous le nom "tournamentLogo", puisque notre notion
   de "tournoi" correspond à league + serie combinés (voir extractMatchFields
   et extractSerieFields ci-dessous).

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
const CS2_PAST_MATCHES_PATH = "/csgo/matches/past";
const CS2_SERIES_PATH = "/csgo/series";
const CS2_LEAGUES_PATH = "/csgo/leagues";
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

// Lève une erreur "propre" (avec code HTTP + message FR) à partir d'une réponse
// PandaScore non-OK, pour que tous les routes gèrent les erreurs de la même façon.
async function assertOk(psRes) {
  if (psRes.status === 401 || psRes.status === 403) {
    const err = new Error(
      "PandaScore a refusé la requête (token invalide, expiré ou manquant). Vérifie PANDASCORE_TOKEN sur Render."
    );
    err.httpStatus = 502;
    throw err;
  }
  if (psRes.status === 429) {
    const err = new Error(
      "Quota PandaScore dépassé pour cette heure (plan gratuit : 1000 requêtes/heure)."
    );
    err.httpStatus = 429;
    throw err;
  }
  if (!psRes.ok) {
    const bodyText = await psRes.text().catch(() => "");
    const err = new Error(
      `PandaScore a répondu avec le statut ${psRes.status} : ${bodyText.slice(0, 200)}`
    );
    err.httpStatus = 502;
    throw err;
  }
}

// --- Mise en forme d'un objet "Match" PandaScore vers un format simple -------
// Doc du schéma "Match" PandaScore : id, name, begin_at, opponents[], serie,
// league, tournament, number_of_games (le "Best of"), videogame, etc.
function extractMatchFields(raw) {
  const opponents = Array.isArray(raw?.opponents) ? raw.opponents : [];
  const teamA = opponents[0]?.opponent?.name ?? "";
  const teamB = opponents[1]?.opponent?.name ?? "";
  // Logo de chaque équipe (champ image_url de l'opponent PandaScore).
  const teamALogo = opponents[0]?.opponent?.image_url ?? "";
  const teamBLogo = opponents[1]?.opponent?.image_url ?? "";

  // "Nom du tournoi" = ligue + édition (ex: "IEM Katowice" + "2026" → "IEM Katowice 2026")
  const leagueName = raw?.league?.name ?? "";
  const serieName = raw?.serie?.full_name ?? "";
  const tournament = [leagueName, serieName].filter(Boolean).join(" ").trim();

  // Logo du tournoi : porté par la League (pas par la Series elle-même) —
  // voir la note en tête de fichier. On retombe sur serie.league.image_url
  // au cas où l'API imbrique la league sous la série selon l'endpoint.
  const tournamentLogo = raw?.league?.image_url ?? raw?.serie?.league?.image_url ?? "";

  // L'étape (ex: "Quarterfinal", "Group A") est portée par l'objet "tournament" de
  // PandaScore (qui correspond à une phase à l'intérieur d'une série — nommage piégeux).
  const stage = raw?.tournament?.name ?? "";

  const format = raw?.number_of_games ? `BO${raw.number_of_games}` : "";

  return {
    pandascoreId: raw?.id != null ? String(raw.id) : "",
    serieId: raw?.serie_id != null ? String(raw.serie_id) : raw?.serie?.id != null ? String(raw.serie.id) : "",
    teamA,
    teamB,
    teamALogo,
    teamBLogo,
    tournament,
    tournamentLogo,
    stage,
    format,
    beginAt: raw?.begin_at ?? null,
    name: raw?.name ?? "",
  };
}

// --- Mise en forme d'un objet "Series" (= "tournoi" dans notre app) ----------
function extractSerieFields(raw) {
  const leagueName = raw?.league?.name ?? "";
  const label = [leagueName, raw?.full_name ?? raw?.name ?? ""].filter(Boolean).join(" ").trim();
  // Voir la note en tête de fichier : le logo vit sur la League, pas la Series.
  const logo = raw?.league?.image_url ?? "";
  return {
    serieId: raw?.id != null ? String(raw.id) : "",
    label: label || raw?.full_name || raw?.name || "",
    logo,
    beginAt: raw?.begin_at ?? null,
    endAt: raw?.end_at ?? null,
  };
}

function dedupeById(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function sortByDateDesc(items, dateFn) {
  return [...items].sort((a, b) => {
    const ta = dateFn(a) ? new Date(dateFn(a)).getTime() : -Infinity;
    const tb = dateFn(b) ? new Date(dateFn(b)).getTime() : -Infinity;
    return tb - ta;
  });
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
  if (err?.httpStatus) {
    return { status: err.httpStatus, body: { error: err.message } };
  }
  return {
    status: 502,
    body: {
      error: "Impossible de récupérer les données depuis PandaScore pour le moment.",
      detail: err?.message || String(err),
    },
  };
}

// --- Recherche de séries (= "tournois") -------------------------------------
// Combine deux stratégies, car le champ "name" d'une Series PandaScore ne
// contient souvent QUE l'édition (ex: "2026", "Summer 2026"), pas le nom de
// la League (ex: "Esports World Cup"). Une recherche search[name] fait un
// test "le champ CONTIENT la sous-chaîne cherchée" : chercher directement
// "Esports World Cup 2026" sur les séries ne matche donc presque jamais.
//   1) recherche directe sur le nom de la série (couvre le cas où l'édition
//      est nommée explicitement, ex: nom de série = "IEM Katowice 2026")
//   2) recherche sur le nom de la LEAGUE, puis récupération de ses séries via
//      filter[league_id] — c'est ce deuxième chemin qui couvre "Esports World
//      Cup 2026", "IEM Katowice", etc.
// Renvoie une liste dédupliquée d'objets "Serie" bruts PandaScore.
async function findMatchingSeries(q) {
  const serieParams = new URLSearchParams({
    "search[name]": q,
    "page[size]": "10",
  });
  const leagueParams = new URLSearchParams({
    "search[name]": q,
    "page[size]": "5",
  });

  const [directSeriesRes, leaguesRes] = await Promise.all([
    pandaScoreFetch(`${CS2_SERIES_PATH}?${serieParams.toString()}`),
    pandaScoreFetch(`${CS2_LEAGUES_PATH}?${leagueParams.toString()}`),
  ]);

  let directSeries = [];
  if (directSeriesRes.ok) {
    const raw = await directSeriesRes.json();
    directSeries = Array.isArray(raw) ? raw : [];
  } else {
    console.error(
      `[cs2-vod-fr] Recherche directe de séries "${q}" a échoué (${directSeriesRes.status}) :`,
      await directSeriesRes.text().catch(() => "")
    );
  }

  let seriesFromLeagues = [];
  if (leaguesRes.ok) {
    const rawLeagues = await leaguesRes.json();
    const leagues = Array.isArray(rawLeagues) ? rawLeagues : [];
    const perLeague = await Promise.all(
      leagues.slice(0, 5).map(async (league) => {
        try {
          const p = new URLSearchParams({
            "filter[league_id]": String(league.id),
            sort: "-begin_at",
            "page[size]": "10",
          });
          const r = await pandaScoreFetch(`${CS2_SERIES_PATH}?${p.toString()}`);
          if (!r.ok) {
            console.error(
              `[cs2-vod-fr] Séries de la league ${league.id} inaccessibles (${r.status}) :`,
              await r.text().catch(() => "")
            );
            return [];
          }
          const rawList = await r.json();
          return Array.isArray(rawList) ? rawList : [];
        } catch {
          return [];
        }
      })
    );
    seriesFromLeagues = perLeague.flat();
  } else {
    console.error(
      `[cs2-vod-fr] Recherche de leagues "${q}" a échoué (${leaguesRes.status}) :`,
      await leaguesRes.text().catch(() => "")
    );
  }

  // Si les deux appels ont échoué, on remonte une vraie erreur à l'appelant
  // plutôt que de silencieusement renvoyer une liste vide.
  if (!directSeriesRes.ok && !leaguesRes.ok) {
    await assertOk(directSeriesRes);
  }

  return dedupeById([...directSeries, ...seriesFromLeagues], (s) =>
    s?.id != null ? String(s.id) : null
  );
}

// --- Routes ------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "cs2-vod-fr proxy (PandaScore)",
    usage: [
      "GET /match/:idOrSlug              — détails d'un match PandaScore",
      "GET /search?q=...                 — recherche de matchs (équipe et/ou tournoi)",
      "GET /search-tournaments?q=...     — recherche de tournois (séries)",
      "GET /tournament/:serieId/matches  — tous les matchs d'un tournoi",
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
    await assertOk(psRes);

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

// Recherche combinée : matchs dont le NOM correspond (ex: noms d'équipes) +
// matchs appartenant à un TOURNOI (série, trouvée via findMatchingSeries —
// qui cherche aussi sur les leagues) dont le nom correspond.
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
    // 1) Matchs dont le nom correspond (typiquement une recherche par équipe)
    const matchParams = new URLSearchParams({
      "search[name]": q,
      sort: "-begin_at",
      "page[size]": "40",
    });
    const matchesRes = await pandaScoreFetch(`${CS2_MATCHES_PATH}?${matchParams.toString()}`);

    let matchResults = [];
    if (matchesRes.ok) {
      const rawMatches = await matchesRes.json();
      matchResults = Array.isArray(rawMatches) ? rawMatches.map(extractMatchFields) : [];
    } else {
      console.error(
        `[cs2-vod-fr] Recherche de matchs "${q}" a échoué (${matchesRes.status}) :`,
        await matchesRes.text().catch(() => "")
      );
    }

    // 2) Tournois (leagues + séries) dont le nom correspond, puis leurs matchs
    // récents. Le filtre serie_id n'est disponible que sur la sous-ressource
    // /matches/past (pas sur l'index générique /csgo/matches).
    let serieMatchResults = [];
    let seriesLookupFailed = false;
    try {
      const series = await findMatchingSeries(q);
      const perSerie = await Promise.all(
        series.slice(0, 8).map(async (serie) => {
          try {
            const p = new URLSearchParams({
              "filter[serie_id]": String(serie.id),
              sort: "-begin_at",
              "page[size]": "20",
            });
            const r = await pandaScoreFetch(`${CS2_PAST_MATCHES_PATH}?${p.toString()}`);
            if (!r.ok) {
              console.error(
                `[cs2-vod-fr] Matchs de la série ${serie.id} inaccessibles (${r.status}) :`,
                await r.text().catch(() => "")
              );
              return [];
            }
            const rawList = await r.json();
            return Array.isArray(rawList) ? rawList.map(extractMatchFields) : [];
          } catch {
            return [];
          }
        })
      );
      serieMatchResults = perSerie.flat();
    } catch (err) {
      seriesLookupFailed = true;
      console.error(`[cs2-vod-fr] Recherche de séries pour "${q}" a échoué :`, err?.message || err);
    }

    // Si aucune des deux stratégies n'a abouti, on remonte une vraie erreur.
    if (!matchesRes.ok && seriesLookupFailed) {
      await assertOk(matchesRes);
    }

    const merged = dedupeById([...matchResults, ...serieMatchResults], (m) => m.pandascoreId);
    const sorted = sortByDateDesc(merged, (m) => m.beginAt).slice(0, 40);

    const payload = { results: sorted };
    setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(`[cs2-vod-fr] Erreur de recherche "${q}" :`, err?.message || err);
    const { status, body } = errorPayloadFor(err);
    res.status(status).json(body);
  }
});

// Recherche de tournois (leagues + séries PandaScore) par nom — pour l'import
// en masse. Voir findMatchingSeries() pour le détail de la stratégie.
app.get("/search-tournaments", async (req, res) => {
  const q = (req.query.q || "").toString().trim();

  if (!q) {
    return res.status(400).json({ error: "Paramètre de recherche 'q' manquant." });
  }

  const cacheKey = `search-tournaments:${q.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const series = await findMatchingSeries(q);
    const results = series.map(extractSerieFields);
    const sorted = sortByDateDesc(results, (s) => s.beginAt);

    const payload = { results: sorted };
    setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(`[cs2-vod-fr] Erreur de recherche de tournois "${q}" :`, err?.message || err);
    const { status, body } = errorPayloadFor(err);
    res.status(status).json(body);
  }
});

// Tous les matchs d'un tournoi (série) donné — pour l'import en masse.
app.get("/tournament/:serieId/matches", async (req, res) => {
  const { serieId } = req.params;
  const id = Number(serieId);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "ID de tournoi (série) PandaScore invalide." });
  }

  const cacheKey = `tournament-matches:${id}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    // Page max autorisée par PandaScore (100). Suffisant pour l'immense majorité
    // des tournois CS2 ; les séries plus longues seraient à paginer davantage.
    // Le filtre serie_id n'est disponible que sur /matches/past (pas sur l'index
    // générique /csgo/matches) — c'est aussi le sous-ensemble qui nous intéresse
    // ici, puisqu'on importe des matchs déjà joués pour y attacher des VODs.
    const params = new URLSearchParams({
      "filter[serie_id]": String(id),
      sort: "begin_at",
      "page[size]": "100",
    });
    const psRes = await pandaScoreFetch(`${CS2_PAST_MATCHES_PATH}?${params.toString()}`);
    await assertOk(psRes);

    const rawList = await psRes.json();
    const results = Array.isArray(rawList) ? rawList.map(extractMatchFields) : [];

    if (results.length === 0) {
      return res
        .status(404)
        .json({ error: `Aucun match trouvé pour ce tournoi (série ${id}).` });
    }

    const payload = { results };
    setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error(`[cs2-vod-fr] Erreur import tournoi ${id} :`, err?.message || err);
    const { status, body } = errorPayloadFor(err);
    res.status(status).json(body);
  }
});

// 404 générique pour toute autre route
app.use((req, res) => {
  res.status(404).json({
    error:
      "Route inconnue. Utilise GET /match/:idOrSlug, /search?q=…, /search-tournaments?q=… ou /tournament/:serieId/matches.",
  });
});

app.listen(PORT, () => {
  console.log(`cs2-vod-fr proxy (PandaScore) en écoute sur le port ${PORT}`);
});
