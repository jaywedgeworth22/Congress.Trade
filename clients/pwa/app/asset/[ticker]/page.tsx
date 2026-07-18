import AssetProfile from '../../ui/AssetProfile';

export default function Page({ params }: { params: { ticker: string } }) {
  return <AssetProfile ticker={params.ticker} />;
}
