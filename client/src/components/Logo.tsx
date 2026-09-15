import React from 'react';

// Minimal geometric mark: a "checked task" square, referencing FRESH's
// operational task focus. Monochrome via currentColor, accent optional.
export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-label="FRESH Portal">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#003DFF" />
      <path
        d="M9 16.5L14 21.5L23 11"
        stroke="white"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
