const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Route de test pour vérifier que le serveur tourne
app.get('/', (req, res) => {
  res.send('Proxy HLTV CS2 en ligne !');
});

app.get('/match/:id', async (req, res) => {
  try {
    const matchId = req.params.id;

    // Appel à l'API relais HLTV via axios
    const response = await axios.get(`https://hltv-api.vercel.app/api/match.json?id=${matchId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 8000
    });

    const data = response.data;

    if (!data || data.error) {
      return res.status(404).json({ error: 'Match non trouvé sur HLTV.' });
    }

    // Normalisation des données pour ton app React
    res.json({
      id: matchId,
      team1: { name: data.team1?.name || data.teams?.[0]?.name || '' },
      team2: { name: data.team2?.name || data.teams?.[1]?.name || '' },
      event: { name: data.event?.name || data.eventName || '' },
      format: data.format || 'BO3'
    });
  } catch (error) {
    console.error('Erreur Proxy HLTV:', error.message);
    res.status(500).json({ error: 'Impossible de récupérer les infos HLTV.' });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur prêt sur le port ${PORT}`);
});const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/match/:id', async (req, res) => {
  try {
    const matchId = req.params.id;

    // Utilisation d'un scraper / proxy tiers plus robuste aux règles Cloudflare
    const response = await fetch(`https://hltv-api.vercel.app/api/match.json?id=${matchId}`);
    
    if (!response.ok) {
      throw new Error(`Statut HTTP: ${response.status}`);
    }

    const data = await response.json();

    // Normalisation des données envoyées à React
    res.json({
      id: matchId,
      team1: { name: data.team1?.name || data.teams?.[0]?.name || 'Équipe 1' },
      team2: { name: data.team2?.name || data.teams?.[1]?.name || 'Équipe 2' },
      event: { name: data.event?.name || data.eventName || 'Tournoi CS2' },
      format: data.format || 'BO3'
    });
  } catch (error) {
    console.error('Erreur Proxy HLTV:', error.message);
    res.status(500).json({ error: 'Impossible de récupérer les infos HLTV.' });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur prêt sur le port ${PORT}`);
});const express = require('express');
const cors = require('cors');
const { HLTV } = require('hltv');

const app = express();
const PORT = process.env.PORT || 3000;

// Autorise ton Artifact / Frontend à appeler ce serveur
app.use(cors());

// Route 1 : Récupérer les résultats récents ou matchs en cours
app.get('/matches', async (req, res) => {
  try {
    const matches = await HLTV.getMatches();
    res.json(matches);
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la récupération des matchs HLTV' });
  }
});

// Route 2 : Récupérer les détails d'un match spécifique via son ID HLTV
app.get('/match/:id', async (req, res) => {
  try {
    const matchId = parseInt(req.params.id);
    const matchData = await HLTV.getMatch({ id: matchId });
    
    // On extrait uniquement ce dont on a besoin pour l'Artifact
    const result = {
      id: matchData.id,
      team1: matchData.team1.name,
      team2: matchData.team2.name,
      event: matchData.event.name,
      format: matchData.format,
      date: matchData.date
    };

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Match non trouvé ou erreur HLTV' });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur Proxy HLTV lancé sur le port ${PORT}`);
});
