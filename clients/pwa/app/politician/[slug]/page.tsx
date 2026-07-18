import PoliticianProfile from '../../ui/PoliticianProfile';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <PoliticianProfile slug={slug} />;
}
