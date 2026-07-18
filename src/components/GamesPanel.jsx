import React, { useEffect, useState } from 'react';
import { fetchHotFixtures } from '../services/tickerService';

export default function GamesPanel({ onClose }) {
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    async function loadFixtures() {
      const data = await fetchHotFixtures();
      if (isMounted) {
        setFixtures(data);
        setLoading(false);
      }
    }
    loadFixtures();
    return () => { isMounted = false; };
  }, []);

  return (
    <div className="games-panel-overlay">
      <div className="games-panel-content slide-up">
        
        {/* Header */}
        <div className="games-panel-header">
          <div className="games-panel-title">
            <span className="games-panel-icon">🔥</span>
            TxODDs Live Markets
          </div>
          <button className="games-panel-close" onClick={onClose}>×</button>
        </div>

        {/* Accent line matching the bridge */}
        <div className="bridge-card-accent" style={{position: 'absolute', top: '56px', left: 0, right: 0, height: '2px', background: 'linear-gradient(90deg, transparent, #a3e635, transparent)'}}></div>

        {/* Body */}
        <div className="games-panel-body">
          {loading ? (
            <div className="games-panel-loading">Loading live odds...</div>
          ) : (
            <div className="games-list">
              {fixtures.map((game) => (
                <div key={game.id} className="game-card">
                  <div className="game-card-header">
                    <span className="game-sport">{game.sport} &bull; {game.competition}</span>
                    {game.isLive ? (
                      <span className="game-status live">
                        <div className="ticker-live-dot"></div> LIVE • {game.time}
                      </span>
                    ) : (
                      <span className="game-status upcoming">{game.time}</span>
                    )}
                  </div>
                  
                  <div className="game-card-teams">
                    <div className="team-row">
                      <span className="team-name">{game.participant1}</span>
                      <span className="team-score">{game.score.split('-')[0]?.trim()}</span>
                    </div>
                    <div className="team-row">
                      <span className="team-name">{game.participant2}</span>
                      <span className="team-score">{game.score.split('-')[1]?.trim()}</span>
                    </div>
                  </div>

                  <div className="game-card-odds">
                    <div className="odd-btn">
                      <span className="odd-label">1</span>
                      <span className="odd-value">{game.odds?.home || '-'}</span>
                    </div>
                    <div className="odd-btn">
                      <span className="odd-label">X</span>
                      <span className="odd-value">{game.odds?.draw || '-'}</span>
                    </div>
                    <div className="odd-btn">
                      <span className="odd-label">2</span>
                      <span className="odd-value">{game.odds?.away || '-'}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
