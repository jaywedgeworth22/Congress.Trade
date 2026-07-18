import { Suspense } from 'react';
import AssetProfilePage from './AssetProfilePage';

export default function Page() {
  return (
    <Suspense fallback={<div className="app-shell" style={{ padding: '24px', textAlign: 'center' }}>Loading asset...</div>}>
      <AssetProfilePage />
    </Suspense>
  );
}
