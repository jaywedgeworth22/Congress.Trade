import PoliticianProfile from '../../ui/PoliticianProfile';

export default function Page({ params }: { params: { slug: string } }) {
  return <PoliticianProfile slug={params.slug} />;
}
