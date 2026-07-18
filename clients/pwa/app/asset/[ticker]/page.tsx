import AssetProfile from '../../ui/AssetProfile';

export default async function Page({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  return <AssetProfile ticker={ticker} />;
}
