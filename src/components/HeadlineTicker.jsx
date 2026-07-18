import React, { useEffect, useState, useRef } from 'react';
import { fetchHotFixtures } from '../services/tickerService';

export default function HeadlineTicker({ onClickTicker }) {
  const [fixtures, setFixtures] = useState([]);
  const containerRef = useRef(null);
  const textRef = useRef(null);
  const requestRef = useRef();
  const xPos = useRef(0);

  useEffect(() => {
    let isMounted = true;
    async function loadFixtures() {
      const data = await fetchHotFixtures();
      if (isMounted) {
        setFixtures(data);
      }
    }
    loadFixtures();
    return () => { isMounted = false; };
  }, []);

  useEffect(() => {
    if (fixtures.length === 0 || !containerRef.current || !textRef.current) return;
    
    // Start position: just off screen to the right
    xPos.current = window.innerWidth;
    
    const animate = () => {
      if (!textRef.current) return;
      xPos.current -= 1.5; // Scroll speed
      
      const textWidth = textRef.current.getBoundingClientRect().width;
      
      // If fully scrolled off the left edge, reset to the right edge
      if (xPos.current < -textWidth) {
        xPos.current = window.innerWidth;
      }
      
      textRef.current.style.transform = `translate3d(${xPos.current}px, 0, 0)`;
      requestRef.current = requestAnimationFrame(animate);
    };

    requestRef.current = requestAnimationFrame(animate);
    
    return () => {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
      }
    };
  }, [fixtures]);

  if (fixtures.length === 0) return null;

  const tickerText = fixtures.map(f => {
    const isLiveStr = f.isLive ? '🔥 LIVE: ' : '🔜 UPCOMING: ';
    return `${isLiveStr} ${f.participant1} ${f.score} ${f.participant2} [${f.time}] (1: ${f.odds?.home || '-'} | X: ${f.odds?.draw || '-'} | 2: ${f.odds?.away || '-'})`;
  }).join('   |   ');

  return (
    <div className="headline-ticker-container" onClick={onClickTicker}>
      <div className="headline-ticker-bg"></div>
      <div className="headline-ticker-content" ref={containerRef}>
        <div className="headline-ticker-text" ref={textRef}>
          {tickerText}
        </div>
      </div>
    </div>
  );
}
