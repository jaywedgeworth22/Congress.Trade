import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Congress.Trade',
    short_name: 'Congress.Trade',
    description: 'Congressional trading feed and webhook control surface.',
    start_url: '/',
    display: 'standalone',
    background_color: '#08111f',
    theme_color: '#08111f',
    orientation: 'portrait-primary',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml'
      }
    ]
  };
}
