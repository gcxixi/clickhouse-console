import React from 'react';

interface BrandLogoProps {
  size?: number;
  showTitle?: boolean;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({ size = 26, showTitle = true }) => {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div
        style={{
          width: size + 8,
          height: size + 8,
          borderRadius: 8,
          background: 'linear-gradient(135deg, #1e293b, #0f172a)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          boxShadow: '0 2px 6px rgba(245, 158, 11, 0.2)'
        }}
      >
        <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
          <rect x="2" y="10" width="3.2" height="12" rx="1.6" fill="#f59e0b" />
          <rect x="7.2" y="5" width="3.2" height="22" rx="1.6" fill="#fbbf24" />
          <rect x="12.4" y="2" width="3.2" height="28" rx="1.6" fill="#fcd34d" />
          <rect x="17.6" y="7" width="3.2" height="18" rx="1.6" fill="#f59e0b" />
          <rect x="22.8" y="12" width="3.2" height="8" rx="1.6" fill="#fbbf24" />
          <rect x="28" y="4" width="3.2" height="24" rx="1.6" fill="#fcd34d" />
        </svg>
      </div>
      {showTitle && (
        <div style={{ lineHeight: 1.2 }}>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.02em', color: 'inherit' }}>
            ClickHouse
          </div>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Console
          </div>
        </div>
      )}
    </div>
  );
};
