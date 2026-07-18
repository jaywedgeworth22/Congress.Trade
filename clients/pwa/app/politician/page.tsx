'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import PoliticianProfile from '../ui/PoliticianProfile';

function PoliticianPageContent() {
  const slug = useSearchParams().get('slug')?.trim() ?? '';
  if (!slug) {
    return <div className="app-shell" style={{ padding: '24px', textAlign: 'center' }}>Select a politician to view their profile.</div>;
  }
  return <PoliticianProfile slug={slug} />;
}

export default function Page() {
  return (
    <Suspense fallback={<div className="app-shell" style={{ padding: '24px', textAlign: 'center' }}>Loading politician...</div>}>
      <PoliticianPageContent />
    </Suspense>
  );
}
