import { Suspense } from 'react';
import PoliticianProfilePage from './PoliticianProfilePage';

export default function Page() {
  return (
    <Suspense fallback={<div className="app-shell" style={{ padding: '24px', textAlign: 'center' }}>Loading politician...</div>}>
      <PoliticianProfilePage />
    </Suspense>
  );
}
