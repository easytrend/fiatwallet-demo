import { useEffect, useRef } from 'react';

/**
 * Toast – slide-in popup that auto-dismisses after `duration` ms.
 *
 * Props:
 *   type      – 'success' | 'error' | 'info'
 *   title     – bold heading line
 *   message   – secondary text
 *   link      – { href, label } optional button
 *   onClose   – callback when dismissed
 *   duration  – ms before auto-close (default 5000)
 */
export default function Toast({ type = 'success', title, message, link, onClose, duration = 5000 }) {
  const timerRef = useRef(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => onClose?.(), duration);
    return () => clearTimeout(timerRef.current);
  }, [duration, onClose]);

  const colors = {
    success: { bg: 'rgba(74,222,128,0.1)',  border: 'rgba(74,222,128,0.35)',  icon: '✓', iconColor: '#4ade80' },
    error:   { bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.35)', icon: '✕', iconColor: '#f87171' },
    info:    { bg: 'rgba(34,211,238,0.1)',  border: 'rgba(34,211,238,0.35)',  icon: 'ℹ', iconColor: '#22d3ee' },
  };
  const c = colors[type] || colors.success;

  return (
    <div style={{
      position: 'fixed', bottom: 28, right: 24, zIndex: 9999,
      minWidth: 300, maxWidth: 400,
      background: 'rgba(14,26,50,0.97)',
      border: `1.5px solid ${c.border}`,
      borderRadius: 14,
      boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
      padding: '14px 16px',
      display: 'flex', alignItems: 'flex-start', gap: 12,
      animation: 'toastIn 0.28s cubic-bezier(0.34,1.56,0.64,1)',
    }}>
      {/* Icon */}
      <div style={{
        width: 30, height: 30, borderRadius: '50%',
        background: c.bg, border: `1px solid ${c.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 14, color: c.iconColor, fontWeight: 700, flexShrink: 0,
      }}>
        {c.icon}
      </div>

      {/* Text */}
      <div style={{ flex: 1 }}>
        {title && (
          <div style={{ fontSize: 13, fontWeight: 700, color: '#f0f6ff', marginBottom: 3 }}>
            {title}
          </div>
        )}
        {message && (
          <div style={{ fontSize: 12, color: 'rgba(240,246,255,0.6)', lineHeight: 1.5 }}>
            {message}
          </div>
        )}
        {link && (
          <a
            href={link.href} target="_blank" rel="noopener noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6,
              fontSize: 11, color: '#a3e635', fontFamily: 'var(--mono)',
              textDecoration: 'none', fontWeight: 600 }}
          >
            {link.label} ↗
          </a>
        )}
      </div>

      {/* Close */}
      <button
        onClick={onClose}
        style={{ background: 'none', border: 'none', cursor: 'pointer',
          color: 'rgba(240,246,255,0.3)', fontSize: 16, lineHeight: 1,
          padding: '0 2px', flexShrink: 0, alignSelf: 'flex-start' }}
        aria-label="Dismiss"
      >
        ×
      </button>

      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateX(24px) scale(0.97); }
          to   { opacity: 1; transform: translateX(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
