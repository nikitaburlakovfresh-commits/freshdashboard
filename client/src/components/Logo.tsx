import React from 'react';

// Approved legacy brand asset: six static paths only, inspected independently
// of all legacy application data/code. Original proportions are 2560:304.
// Keep the historical `size` prop compatible; wordmark is never below 120px.
export default function Logo({ size = 164 }: { size?: number }) {
  return <img className="fresh-logo" src={new URL('../assets/fresh-logo.svg', import.meta.url).href} alt="FRESH"
    width={Math.max(120, size)} height={Math.max(120, size) * 304 / 2560} />;
}
