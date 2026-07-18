const API_BASE = 'https://txline.txodds.com/api';
const AUTH_URL = 'https://txline.txodds.com/auth/guest/start';

const DEMO_FIXTURES = [
  {
    id: 101,
    sport: 'SOCCER',
    competition: 'Premier League',
    participant1: 'Arsenal',
    participant2: 'Chelsea',
    startTime: Date.now() - 3600000,
    isLive: true,
    score: '2 - 1',
    time: '67\'',
    odds: { home: 1.45, draw: 3.20, away: 5.10 }
  },
  {
    id: 102,
    sport: 'BASKETBALL',
    competition: 'NBA',
    participant1: 'LAL',
    participant2: 'GSW',
    startTime: Date.now() - 7200000,
    isLive: true,
    score: '110 - 105',
    time: 'Q4 2:15',
    odds: { home: 1.85, draw: null, away: 2.10 }
  },
  {
    id: 103,
    sport: 'TENNIS',
    competition: 'Wimbledon',
    participant1: 'Djokovic N.',
    participant2: 'Alcaraz C.',
    startTime: Date.now() - 1800000,
    isLive: true,
    score: '6-4, 3-2',
    time: 'Set 2',
    odds: { home: 1.65, draw: null, away: 2.30 }
  },
  {
    id: 104,
    sport: 'SOCCER',
    competition: 'La Liga',
    participant1: 'Real Madrid',
    participant2: 'Barcelona',
    startTime: Date.now() + 86400000,
    isLive: false,
    score: '-',
    time: 'Tomorrow',
    odds: { home: 2.10, draw: 3.40, away: 2.80 }
  },
  {
    id: 105,
    sport: 'FOOTBALL',
    competition: 'NFL',
    participant1: 'Chiefs',
    participant2: 'Eagles',
    startTime: Date.now() + 172800000,
    isLive: false,
    score: '-',
    time: 'Sun 8:00 PM',
    odds: { home: 1.91, draw: null, away: 1.91 }
  },
  {
    id: 106,
    sport: 'SOCCER',
    competition: 'Serie A',
    participant1: 'Juventus',
    participant2: 'AC Milan',
    startTime: Date.now() - 5400000,
    isLive: true,
    score: '0 - 0',
    time: 'HT',
    odds: { home: 2.50, draw: 2.10, away: 3.10 }
  }
];

export async function fetchHotFixtures() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const authRes = await fetch(AUTH_URL, {
      method: 'POST',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!authRes.ok) throw new Error(`Auth failed: ${authRes.status}`);
    const authData = await authRes.json();
    const jwt = authData.token;

    const fixturesRes = await fetch(`${API_BASE}/fixtures/snapshot`, {
      headers: {
        'Authorization': `Bearer ${jwt}`,
      }
    });

    if (!fixturesRes.ok) {
      console.warn(`TxODDs Data API returned ${fixturesRes.status}, using robust fallback data...`);
      return DEMO_FIXTURES;
    }

    const data = await fixturesRes.json();
    
    return data.slice(0, 10).map(fixture => ({
      id: fixture.FixtureId,
      sport: fixture.Competition || 'SPORT',
      competition: fixture.Competition,
      participant1: fixture.Participant1,
      participant2: fixture.Participant2,
      startTime: fixture.StartTime,
      isLive: fixture.StartTime < Date.now(),
      score: '-', 
      time: '-',
      odds: { home: 1.9, draw: 3.0, away: 2.1 } 
    }));

  } catch (error) {
    console.warn('TxODDs fetch failed, using robust fallback data:', error.message);
    return DEMO_FIXTURES;
  }
}

// Backwards-compat alias used by the existing TickerWidget component
export const fetchLiveEvents = fetchHotFixtures;

