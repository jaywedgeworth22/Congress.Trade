'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import AssetProfile from '../ui/AssetProfile';

function AssetPageContent() {
  const ticker = useSearchParams().get('ticker')?.trim() ?? '';
  if (!ticker) return <div className="app-shell" style={{ padding: '24px', textAlign: 'center' }}>Select an asset to view its profile.</div>;
  return <AssetProfile ticker={ticker} />;
}

export default function Page() {
  return <Suspense fallback={<div className="app-shell" style={{ padding: '24px', textAlign: 'center' }}>Loading asset...</div>}><AssetPageContent /></Suspense>;
}
