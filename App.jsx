import React, { useState, useEffect, useMemo } from "react";
import {
  Search,
  Trophy,
  Twitch,
  Youtube,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  Download,
  Upload,
  PlayCircle,
  X,
  Check,
  Radio,
  Swords,
  Filter,
  AlertTriangle,
  Link2,
} from "lucide-react";

/* ============================================================================
   CS2 VOD FR — Répertoire de rediffusions CS2 commentées en français
   Un seul fichier, prêt à intégrer dans un projet React + Tailwind + lucide-react.
   Persistance locale via localStorage. Import optionnel des métadonnées de
   match depuis un proxy PandaScore (https://cs2-vod-fr.onrender.com).
   ============================================================================ */

const STORAGE_KEY = "cs2vodfr_matches";
const PROXY_BASE = "https://cs2-vod-fr.onrender.com";
const MATCH_ENDPOINT = `${PROXY_BASE}/match/`;
const SEARCH_ENDPOINT = `${PROXY_BASE}/search`;

const MOCK_MATCHES = [
  {
    id: "m1",
    pandascoreId: "2374829",
    tournament: "IEM Katowice 2026",
    stage: "Quart de finale",
    teamA: "Vitality",
    teamB: "MOUZ",
    format: "BO3",
    caster: "KRL",
    platform: "twitch",
    vodUrl: "https://www.twitch.tv/videos/2109384756",
    h: 0,
    m: 15,
    s: 32,
  },
  {
    id: "m2",
    pandascoreId: "2374855",
    tournament: "Blast Premier Fall 2026",
    stage: "Demi-finale",
    teamA: "Natus Vincere",
    teamB: "Team Spirit",
    format: "BO3",
    caster: "Croissant Strike",
    platform: "youtube",
    vodUrl: "https://youtu.be/dQw4w9WgXcQ",
    h: 1,
    m: 2,
    s: 10,
  },
  {
    id: "m3",
    pandascoreId: "2374701",
    tournament: "ESL Pro League S20",
    stage: "Poules",
    teamA: "G2",
    teamB: "FaZe",
    format: "BO1",
    caster: "MGG",
    platform: "twitch",
    vodUrl: "https://www.twitch.tv/videos/2109384001",
    h: 0,
    m: 5,
    s: 0,
  },
  {
    id: "m4",
    pandascoreId: "2374912",
    tournament: "IEM Katowice 2026",
    stage: "Finale",
    teamA: "Astralis",
    teamB: "Heroic",
    format: "BO5",
    caster: "VaKarM",
    platform: "youtube",
    vodUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    h: 2,
    m: 30,
    s: 45,
  },
];

const EMPTY_FORM = {
  id: null,
  pandascoreId: "",
  tournament: "",
  stage: "",
  teamA: "",
  teamB: "",
  format: "BO3",
  caster: "",
  platform: "twitch",
  vodUrl: "",
  h: 0,
  m: 0,
  s: 0,
};

/* --- Helpers ------------------------------------------------------------- */

function pad2(n) {
  return String(n ?? 0).padStart(2, "0");
}

function formatHMS(h, m, s) {
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function toSeconds(h, m, s) {
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
}

function buildFinalUrl(platform, baseUrl, h, m, s) {
  if (!baseUrl) return "";
  let clean = baseUrl.trim();
  // strip an existing ?t=... or &t=... so re-generating stays idempotent
  clean = clean.replace(/([?&])t=[^&]*/i, (match, sep) => (sep === "?" ? "?" : ""));
  clean = clean.replace(/[?&]$/, "");

  const sep = clean.includes("?") ? "&" : "?";

  if (platform === "twitch") {
    const hh = Number(h) || 0;
    const mm = Number(m) || 0;
    const ss = Number(s) || 0;
    return `${clean}${sep}t=${hh}h${mm}m${ss}s`;
  }
  // youtube
  const total = toSeconds(h, m, s);
  return `${clean}${sep}t=${total}`;
}

const CASTER_STYLES = {
  KRL: "bg-blue-500/15 text-blue-300 border-blue-500/40",
  "Croissant Strike": "bg-orange-500/15 text-orange-300 border-orange-500/40",
  MGG: "bg-violet-500/15 text-violet-300 border-violet-500/40",
  VaKarM: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
};

function casterBadgeClass(caster) {
  return CASTER_STYLES[caster] || "bg-zinc-500/15 text-zinc-300 border-zinc-500/40";
}

function normalizePandaScorePayload(data) {
  // Forme exacte renvoyée par index.js (simplifyMatch) : teamA, teamB,
  // tournament, stage, format sont déjà des chaînes prêtes à l'emploi.
  return {
    teamA: data?.teamA ?? "",
    teamB: data?.teamB ?? "",
    tournament: data?.tournament ?? "",
    stage: data?.stage ?? "",
    format: data?.format || "BO3",
    pandascoreId: data?.pandascoreId != null ? String(data.pandascoreId) : "",
  };
}

/* --- App ------------------------------------------------------------------ */

export default function App() {
  const [mode, setMode] = useState("viewer"); // 'viewer' | 'admin'
  const [matches, setMatches] = useState([]);
  const [hydrated, setHydrated] = useState(false);

  // Viewer state
  const [search, setSearch] = useState("");
  const [filterTournament, setFilterTournament] = useState("");
  const [filterCaster, setFilterCaster] = useState("");

  // Admin state
  const [form, setForm] = useState(EMPTY_FORM);
  const [pandaLoading, setPandaLoading] = useState(false);
  const [pandaError, setPandaError] = useState("");
  const [importFeedback, setImportFeedback] = useState("");

  // Recherche PandaScore (PandaScore n'a pas de site public pour "trouver" un
  // ID de match comme HLTV, donc on cherche par nom d'équipe/tournoi).
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        setMatches(JSON.parse(raw));
      } else {
        setMatches(MOCK_MATCHES);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(MOCK_MATCHES));
      }
    } catch (e) {
      setMatches(MOCK_MATCHES);
    }
    setHydrated(true);
  }, []);

  // Persist on change
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(matches));
  }, [matches, hydrated]);

  const tournaments = useMemo(
    () => Array.from(new Set(matches.map((m) => m.tournament).filter(Boolean))).sort(),
    [matches]
  );
  const casters = useMemo(
    () => Array.from(new Set(matches.map((m) => m.caster).filter(Boolean))).sort(),
    [matches]
  );

  const filteredMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return matches.filter((m) => {
      const matchesQuery =
        !q ||
        m.teamA.toLowerCase().includes(q) ||
        m.teamB.toLowerCase().includes(q) ||
        m.tournament.toLowerCase().includes(q);
      const matchesTournament = !filterTournament || m.tournament === filterTournament;
      const matchesCaster = !filterCaster || m.caster === filterCaster;
      return matchesQuery && matchesTournament && matchesCaster;
    });
  }, [matches, search, filterTournament, filterCaster]);

  /* --- Admin actions ---------------------------------------------------- */

  function updateForm(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setPandaError("");
  }

  function startEdit(match) {
    setForm({ ...match });
    setMode("admin");
    setPandaError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteMatch(id) {
    setMatches((prev) => prev.filter((m) => m.id !== id));
  }

  function saveMatch(e) {
    e.preventDefault();
    if (!form.teamA || !form.teamB || !form.vodUrl || !form.tournament) return;

    if (form.id) {
      setMatches((prev) => prev.map((m) => (m.id === form.id ? { ...form } : m)));
    } else {
      setMatches((prev) => [...prev, { ...form, id: `m${Date.now()}` }]);
    }
    resetForm();
  }

  async function importFromPandaScore(idOrSlug) {
    const target = idOrSlug ?? form.pandascoreId;
    if (!target) {
      setPandaError("Renseigne un ID/slug PandaScore, ou utilise la recherche ci-dessous.");
      return;
    }
    setPandaLoading(true);
    setPandaError("");
    try {
      const res = await fetch(`${MATCH_ENDPOINT}${encodeURIComponent(target)}`);

      // On essaie toujours de lire le corps JSON, même en cas d'erreur HTTP,
      // pour remonter le vrai message envoyé par le proxy (voir index.js).
      let data = null;
      try {
        data = await res.json();
      } catch {
        // corps non-JSON (ex: page d'erreur générique de Render) : on ignore
      }

      if (!res.ok) {
        throw new Error(data?.error || `Le proxy a répondu avec le statut ${res.status}.`);
      }

      const normalized = normalizePandaScorePayload(data);
      const somethingFilled = normalized.teamA || normalized.teamB || normalized.tournament;
      if (!somethingFilled) {
        throw new Error(
          "Le proxy a répondu, mais sans données exploitables pour ce match. Vérifie l'ID/slug PandaScore."
        );
      }

      setForm((f) => ({
        ...f,
        pandascoreId: normalized.pandascoreId || target,
        teamA: normalized.teamA || f.teamA,
        teamB: normalized.teamB || f.teamB,
        tournament: normalized.tournament || f.tournament,
        stage: normalized.stage || f.stage,
        format: normalized.format || f.format,
      }));
      setSearchResults([]);
    } catch (err) {
      // TypeError = la requête n'a même pas abouti (réseau, CORS, serveur en veille qui
      // met du temps à répondre). Dans les autres cas, on affiche le vrai message d'erreur.
      if (err instanceof TypeError) {
        console.error("[import PandaScore] Échec réseau brut :", err);
        setPandaError(
          `Impossible de contacter le proxy (${err.message}). Vérifie la console du navigateur (onglet Réseau). Si le serveur venait de se réveiller (~30s), réessaie.`
        );
      } else {
        setPandaError(err.message || "Import impossible pour une raison inconnue.");
      }
    } finally {
      setPandaLoading(false);
    }
  }

  async function searchPandaScore() {
    const q = searchQuery.trim();
    if (!q) {
      setSearchError("Tape au moins un nom d'équipe ou de tournoi.");
      return;
    }
    setSearchLoading(true);
    setSearchError("");
    setSearchResults([]);
    try {
      const res = await fetch(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(q)}`);
      let data = null;
      try {
        data = await res.json();
      } catch {
        // corps non-JSON : on ignore
      }
      if (!res.ok) {
        throw new Error(data?.error || `Le proxy a répondu avec le statut ${res.status}.`);
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      setSearchResults(results);
      if (results.length === 0) {
        setSearchError("Aucun match trouvé pour cette recherche.");
      }
    } catch (err) {
      if (err instanceof TypeError) {
        setSearchError(
          `Impossible de contacter le proxy (${err.message}). Si le serveur venait de se réveiller (~30s), réessaie.`
        );
      } else {
        setSearchError(err.message || "Recherche impossible pour une raison inconnue.");
      }
    } finally {
      setSearchLoading(false);
    }
  }

  function useSearchResult(result) {
    setForm((f) => ({
      ...f,
      pandascoreId: result.pandascoreId != null ? String(result.pandascoreId) : "",
      teamA: result.teamA || f.teamA,
      teamB: result.teamB || f.teamB,
      tournament: result.tournament || f.tournament,
      stage: result.stage || f.stage,
      format: result.format || f.format,
    }));
    setSearchResults([]);
    setSearchQuery("");
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(matches, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cs2-vod-fr-export.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJson(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed)) throw new Error("format invalide");
        setMatches(parsed);
        setImportFeedback(`${parsed.length} match(s) importé(s) avec succès.`);
      } catch {
        setImportFeedback("Le fichier JSON est invalide.");
      } finally {
        setTimeout(() => setImportFeedback(""), 4000);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  const previewUrl = buildFinalUrl(form.platform, form.vodUrl, form.h, form.m, form.s);

  /* --- Render ------------------------------------------------------------ */

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="pointer-events-none fixed inset-0 opacity-[0.04]" aria-hidden="true">
        <div className="h-full w-full bg-gradient-to-br from-blue-500 via-transparent to-orange-500" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center bg-gradient-to-br from-blue-500 to-orange-500"
              style={{ clipPath: "polygon(0 0, 100% 0, 100% 70%, 70% 100%, 0 100%)" }}
            >
              <Swords className="h-5 w-5 text-slate-950" strokeWidth={2.5} />
            </div>
            <div>
              <h1 className="text-lg font-black uppercase tracking-wide text-slate-50">
                CS2 VOD<span className="text-orange-400">.FR</span>
              </h1>
              <p className="text-[11px] uppercase tracking-widest text-slate-500">
                Rediffusions commentées en français
              </p>
            </div>
          </div>

          <nav className="flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900 p-1">
            <button
              onClick={() => setMode("viewer")}
              className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                mode === "viewer"
                  ? "bg-blue-500 text-slate-950"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <PlayCircle className="h-4 w-4" />
              Viewer
            </button>
            <button
              onClick={() => setMode("admin")}
              className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
                mode === "admin"
                  ? "bg-orange-500 text-slate-950"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Pencil className="h-4 w-4" />
              Admin
            </button>
          </nav>
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl px-4 py-8">
        {mode === "viewer" ? (
          <ViewerView
            matches={filteredMatches}
            totalCount={matches.length}
            search={search}
            setSearch={setSearch}
            tournaments={tournaments}
            casters={casters}
            filterTournament={filterTournament}
            setFilterTournament={setFilterTournament}
            filterCaster={filterCaster}
            setFilterCaster={setFilterCaster}
          />
        ) : (
          <AdminView
            form={form}
            updateForm={updateForm}
            saveMatch={saveMatch}
            resetForm={resetForm}
            pandaLoading={pandaLoading}
            pandaError={pandaError}
            importFromPandaScore={importFromPandaScore}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            searchResults={searchResults}
            searchLoading={searchLoading}
            searchError={searchError}
            searchPandaScore={searchPandaScore}
            useSearchResult={useSearchResult}
            previewUrl={previewUrl}
            matches={matches}
            startEdit={startEdit}
            deleteMatch={deleteMatch}
            exportJson={exportJson}
            importJson={importJson}
            importFeedback={importFeedback}
          />
        )}
      </main>
    </div>
  );
}

/* --- Viewer ---------------------------------------------------------------- */

function ViewerView({
  matches,
  totalCount,
  search,
  setSearch,
  tournaments,
  casters,
  filterTournament,
  setFilterTournament,
  filterCaster,
  setFilterCaster,
}) {
  const hasFilters = search || filterTournament || filterCaster;

  return (
    <div>
      {/* Search + filters */}
      <div className="mb-8 space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher une équipe ou un tournoi… (ex: Vitality, IEM Katowice)"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-3 pl-10 pr-4 text-sm text-slate-100 placeholder-slate-500 outline-none transition-colors focus:border-blue-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <Filter className="h-3.5 w-3.5" />
            Filtres :
          </span>

          <select
            value={filterTournament}
            onChange={(e) => setFilterTournament(e.target.value)}
            className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-slate-300 outline-none focus:border-blue-500"
          >
            <option value="">Tous les tournois</option>
            {tournaments.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <select
            value={filterCaster}
            onChange={(e) => setFilterCaster(e.target.value)}
            className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-slate-300 outline-none focus:border-blue-500"
          >
            <option value="">Tous les casters</option>
            {casters.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          {hasFilters && (
            <button
              onClick={() => {
                setSearch("");
                setFilterTournament("");
                setFilterCaster("");
              }}
              className="flex items-center gap-1 rounded-full border border-zinc-800 px-3 py-1.5 text-xs font-medium text-slate-400 hover:border-red-500/50 hover:text-red-400"
            >
              <X className="h-3 w-3" />
              Réinitialiser
            </button>
          )}

          <span className="ml-auto text-xs text-slate-500">
            {matches.length} / {totalCount} match{totalCount > 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Grid */}
      {matches.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-800 py-20 text-center">
          <Radio className="h-8 w-8 text-slate-600" />
          <p className="text-slate-400">Aucune rediffusion ne correspond à ta recherche.</p>
          <p className="text-sm text-slate-600">
            Essaie un autre terme, ou ajoute un match depuis le mode Admin.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {matches.map((m) => (
            <MatchCard key={m.id} match={m} />
          ))}
        </div>
      )}
    </div>
  );
}

function MatchCard({ match }) {
  const finalUrl = buildFinalUrl(match.platform, match.vodUrl, match.h, match.m, match.s);

  return (
    <div
      className="group relative flex flex-col overflow-hidden border border-zinc-800 bg-zinc-900/60 transition-colors hover:border-zinc-700"
      style={{ clipPath: "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 0 100%)" }}
    >
      <div className="h-1 w-full bg-gradient-to-r from-blue-500 to-orange-500" />

      <div className="flex flex-1 flex-col gap-4 p-5">
        {/* Tournament / stage */}
        <div className="flex items-center gap-2 text-xs">
          <Trophy className="h-3.5 w-3.5 shrink-0 text-orange-400" />
          <span className="truncate font-semibold text-slate-300">{match.tournament}</span>
          {match.stage && (
            <>
              <span className="text-slate-600">·</span>
              <span className="shrink-0 text-slate-500">{match.stage}</span>
            </>
          )}
        </div>

        {/* Teams */}
        <div className="flex items-center justify-between gap-2">
          <TeamBlock name={match.teamA} />
          <span className="shrink-0 font-mono text-sm font-bold text-slate-600">VS</span>
          <TeamBlock name={match.teamB} align="right" />
        </div>

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 font-mono text-[11px] font-bold text-slate-300">
            {match.format}
          </span>
          <span
            className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${casterBadgeClass(
              match.caster
            )}`}
          >
            {match.caster}
          </span>
          <span className="ml-auto flex items-center gap-1 font-mono text-[11px] text-slate-500">
            {match.platform === "twitch" ? (
              <Twitch className="h-3 w-3 text-violet-400" />
            ) : (
              <Youtube className="h-3 w-3 text-red-500" />
            )}
            {formatHMS(match.h, match.m, match.s)}
          </span>
        </div>

        {/* CTA */}
        <a
          href={finalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-auto flex items-center justify-center gap-2 bg-blue-500 py-2.5 text-sm font-bold uppercase tracking-wide text-slate-950 transition-colors hover:bg-blue-400"
        >
          <PlayCircle className="h-4 w-4" />
          Regarder la rediffusion
        </a>
      </div>
    </div>
  );
}

function TeamBlock({ name, align = "left" }) {
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-2 ${align === "right" ? "flex-row-reverse text-right" : ""}`}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 font-mono text-sm font-bold text-slate-300">
        {initial}
      </div>
      <span className="truncate text-sm font-bold text-slate-100">{name}</span>
    </div>
  );
}

/* --- Admin ------------------------------------------------------------------ */

function AdminView({
  form,
  updateForm,
  saveMatch,
  resetForm,
  pandaLoading,
  pandaError,
  importFromPandaScore,
  searchQuery,
  setSearchQuery,
  searchResults,
  searchLoading,
  searchError,
  searchPandaScore,
  useSearchResult,
  previewUrl,
  matches,
  startEdit,
  deleteMatch,
  exportJson,
  importJson,
  importFeedback,
}) {
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
      {/* Form */}
      <div className="lg:col-span-3">
        <div className="border border-zinc-800 bg-zinc-900/60 p-6">
          <h2 className="mb-1 flex items-center gap-2 text-base font-bold uppercase tracking-wide text-slate-100">
            <Pencil className="h-4 w-4 text-orange-400" />
            {form.id ? "Modifier une entrée" : "Ajouter une rediffusion"}
          </h2>
          <p className="mb-5 text-sm text-slate-500">
            Renseigne les infos du match, ou importe-les depuis PandaScore.
          </p>

          {/* Recherche PandaScore par équipe / tournoi */}
          <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Rechercher un match sur PandaScore
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), searchPandaScore())}
                placeholder="ex: Vitality, IEM Katowice…"
                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={searchPandaScore}
                disabled={searchLoading}
                className="flex items-center justify-center gap-2 rounded-md bg-orange-500 px-4 py-2 text-sm font-bold text-slate-950 transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {searchLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                Rechercher
              </button>
            </div>
            {searchLoading && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-orange-300">
                <Loader2 className="h-3 w-3 animate-spin" />
                Recherche en cours (le serveur gratuit Render peut mettre ~30s à sortir de
                veille)…
              </p>
            )}
            {searchError && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-red-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {searchError}
              </p>
            )}
            {searchResults.length > 0 && (
              <ul className="mt-3 divide-y divide-zinc-800 overflow-hidden rounded-md border border-zinc-800">
                {searchResults.map((r) => (
                  <li key={r.pandascoreId}>
                    <button
                      type="button"
                      onClick={() => useSearchResult(r)}
                      className="flex w-full flex-col gap-0.5 bg-zinc-900 px-3 py-2 text-left text-xs transition-colors hover:bg-zinc-800"
                    >
                      <span className="font-semibold text-slate-200">
                        {r.teamA || "?"} <span className="text-slate-600">vs</span>{" "}
                        {r.teamB || "?"}
                      </span>
                      <span className="text-slate-500">
                        {[r.tournament, r.stage].filter(Boolean).join(" · ") || r.name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Import direct par ID/slug PandaScore */}
          <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400">
              ID/slug PandaScore (optionnel, si tu le connais déjà)
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={form.pandascoreId}
                onChange={(e) => updateForm("pandascoreId", e.target.value)}
                placeholder="ex: 1234567"
                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() => importFromPandaScore()}
                disabled={pandaLoading}
                className="flex items-center justify-center gap-2 rounded-md bg-blue-500 px-4 py-2 text-sm font-bold text-slate-950 transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pandaLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                Importer depuis PandaScore
              </button>
            </div>
            {pandaLoading && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-blue-300">
                <Loader2 className="h-3 w-3 animate-spin" />
                Chargement depuis PandaScore (le serveur gratuit Render peut mettre ~30s à
                sortir de veille)…
              </p>
            )}
            {pandaError && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-red-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {pandaError}
              </p>
            )}
          </div>

          <form onSubmit={saveMatch} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Nom du tournoi *">
                <input
                  required
                  value={form.tournament}
                  onChange={(e) => updateForm("tournament", e.target.value)}
                  placeholder="ex: IEM Katowice 2026"
                  className="input"
                />
              </Field>
              <Field label="Stage / Étape">
                <input
                  value={form.stage}
                  onChange={(e) => updateForm("stage", e.target.value)}
                  placeholder="ex: Quart de finale"
                  className="input"
                />
              </Field>
              <Field label="Équipe A *">
                <input
                  required
                  value={form.teamA}
                  onChange={(e) => updateForm("teamA", e.target.value)}
                  placeholder="ex: Vitality"
                  className="input"
                />
              </Field>
              <Field label="Équipe B *">
                <input
                  required
                  value={form.teamB}
                  onChange={(e) => updateForm("teamB", e.target.value)}
                  placeholder="ex: MOUZ"
                  className="input"
                />
              </Field>
              <Field label="Format">
                <select
                  value={form.format}
                  onChange={(e) => updateForm("format", e.target.value)}
                  className="input"
                >
                  <option value="BO1">BO1</option>
                  <option value="BO3">BO3</option>
                  <option value="BO5">BO5</option>
                </select>
              </Field>
              <Field label="Chaîne / Caster">
                <input
                  value={form.caster}
                  onChange={(e) => updateForm("caster", e.target.value)}
                  placeholder="ex: KRL, Croissant Strike, MGG"
                  className="input"
                  list="caster-suggestions"
                />
                <datalist id="caster-suggestions">
                  <option value="KRL" />
                  <option value="Croissant Strike" />
                  <option value="MGG" />
                  <option value="VaKarM" />
                </datalist>
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Plateforme de VOD">
                <div className="flex gap-2">
                  <PlatformButton
                    active={form.platform === "twitch"}
                    onClick={() => updateForm("platform", "twitch")}
                    icon={<Twitch className="h-4 w-4" />}
                    label="Twitch"
                    color="violet"
                  />
                  <PlatformButton
                    active={form.platform === "youtube"}
                    onClick={() => updateForm("platform", "youtube")}
                    icon={<Youtube className="h-4 w-4" />}
                    label="YouTube"
                    color="red"
                  />
                </div>
              </Field>
              <Field label="URL de la VOD *">
                <input
                  required
                  value={form.vodUrl}
                  onChange={(e) => updateForm("vodUrl", e.target.value)}
                  placeholder="https://www.twitch.tv/videos/123456789"
                  className="input font-mono text-xs"
                />
              </Field>
            </div>

            <Field label="Timecode de démarrage">
              <div className="flex items-center gap-2">
                <TimeInput label="H" value={form.h} onChange={(v) => updateForm("h", v)} max={23} />
                <span className="text-slate-600">:</span>
                <TimeInput label="M" value={form.m} onChange={(v) => updateForm("m", v)} max={59} />
                <span className="text-slate-600">:</span>
                <TimeInput label="S" value={form.s} onChange={(v) => updateForm("s", v)} max={59} />
                <span className="ml-2 font-mono text-sm text-slate-500">
                  = {formatHMS(form.h, form.m, form.s)}
                </span>
              </div>
            </Field>

            {/* Live preview */}
            {form.vodUrl && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <Link2 className="h-3 w-3" />
                  Lien généré
                </p>
                <p className="break-all font-mono text-xs text-blue-300">{previewUrl}</p>
              </div>
            )}

            <div className="flex items-center gap-2 pt-2">
              <button
                type="submit"
                className="flex items-center gap-2 bg-orange-500 px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-slate-950 transition-colors hover:bg-orange-400"
              >
                <Check className="h-4 w-4" />
                {form.id ? "Enregistrer les modifications" : "Ajouter la rediffusion"}
              </button>
              {form.id && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="flex items-center gap-2 border border-zinc-700 px-4 py-2.5 text-sm font-semibold text-slate-400 hover:text-slate-200"
                >
                  <X className="h-4 w-4" />
                  Annuler
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Import / export */}
        <div className="mt-6 flex flex-wrap items-center gap-3 border border-zinc-800 bg-zinc-900/60 p-4">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Sauvegarde locale :
          </span>
          <button
            onClick={exportJson}
            className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-blue-500 hover:text-blue-300"
          >
            <Download className="h-3.5 w-3.5" />
            Exporter en JSON
          </button>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-orange-500 hover:text-orange-300">
            <Upload className="h-3.5 w-3.5" />
            Importer un JSON
            <input type="file" accept="application/json" onChange={importJson} className="hidden" />
          </label>
          {importFeedback && <span className="text-xs text-emerald-400">{importFeedback}</span>}
        </div>
      </div>

      {/* Existing matches list */}
      <div className="lg:col-span-2">
        <h3 className="mb-4 text-sm font-bold uppercase tracking-wide text-slate-400">
          Rediffusions enregistrées ({matches.length})
        </h3>
        <div className="space-y-2">
          {matches.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-2 border border-zinc-800 bg-zinc-900/60 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-200">
                  {m.teamA} <span className="text-slate-600">vs</span> {m.teamB}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {m.tournament} · {m.caster}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => startEdit(m)}
                  className="rounded p-1.5 text-slate-400 hover:bg-zinc-800 hover:text-blue-300"
                  aria-label="Modifier"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => deleteMatch(m.id)}
                  className="rounded p-1.5 text-slate-400 hover:bg-zinc-800 hover:text-red-400"
                  aria-label="Supprimer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
          {matches.length === 0 && (
            <p className="rounded border border-dashed border-zinc-800 py-8 text-center text-sm text-slate-600">
              Aucune rediffusion pour le moment.
            </p>
          )}
        </div>
      </div>

      {/* shared input styling via Tailwind @apply-like utility (inline class) */}
      <style>{`
        .input {
          width: 100%;
          border-radius: 0.375rem;
          border: 1px solid rgb(39 39 42);
          background-color: rgb(24 24 27);
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: rgb(241 245 249);
          outline: none;
          transition: border-color 0.15s;
        }
        .input:focus {
          border-color: rgb(59 130 246);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </label>
      {children}
    </div>
  );
}

function PlatformButton({ active, onClick, icon, label, color }) {
  const colors = {
    violet: active
      ? "bg-violet-500 text-slate-950 border-violet-500"
      : "border-zinc-700 text-slate-400 hover:border-violet-500/50",
    red: active
      ? "bg-red-500 text-slate-950 border-red-500"
      : "border-zinc-700 text-slate-400 hover:border-red-500/50",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-sm font-semibold transition-colors ${colors[color]}`}
    >
      {icon}
      {label}
    </button>
  );
}

function TimeInput({ label, value, onChange, max }) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => {
          const v = Math.max(0, Math.min(max, Number(e.target.value) || 0));
          onChange(v);
        }}
        className="w-16 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-center font-mono text-sm text-slate-100 outline-none focus:border-blue-500"
      />
      <span className="text-[10px] font-bold uppercase text-slate-600">{label}</span>
    </div>
  );
}
