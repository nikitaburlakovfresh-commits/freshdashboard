import React from 'react';

// Small, static interface symbols. No remote assets or runtime dependencies.
const paths = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  chart: 'M4 3v17h17 M7 14l4-4 4 3 6-8 M16 5h5v5',
  target: 'M21 12a9 9 0 1 1-9-9 M17 12a5 5 0 1 1-5-5 M12 12l9-9 M17 3h4v4',
  wallet: 'M3 6h16v4 M3 6l14-3v3 M3 6v14h18V10h-6v6h6 M17 13h1',
  check: 'M9 4H4v17h16V4h-5 M9 2h6v5H9z M8 13l3 3 5-6',
  calendar: 'M4 5h16v16H4z M4 10h16 M8 2v6 M16 2v6 M8 14h2 M14 14h2 M8 18h2',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M9 21h6',
  layers: 'M12 3l10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5',
  network: 'M9 2h6v6H9z M2 16h6v6H2z M16 16h6v6h-6z M12 8v4 M5 16v-4h14v4',
  upload: 'M12 16V3 M7 8l5-5 5 5 M3 15v6h18v-6',
  logout: 'M9 3H3v18h6 M8 12h13 M17 8l4 4-4 4',
  chevron: 'M9 5l7 7-7 7',
  close: 'M5 5l14 14 M19 5L5 19',
  menu: 'M3 5h18 M3 12h18 M3 19h18',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M12 1v2 M12 21v2 M1 12h2 M21 12h2 M4 4l2 2 M18 18l2 2 M4 20l2-2 M18 6l2-2',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11z',
  shield: 'M12 2l8 3v7c0 5-8 10-8 10S4 17 4 12V5z M8 12l3 3 5-6',
  stock: 'M3 8l9-5 9 5v13H3z M7 21V11h10v10 M7 15h10',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 11v6 M12 7v1',
};
export type IconName = keyof typeof paths;
export default function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <svg className={`fresh-icon ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
