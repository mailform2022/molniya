import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'VTX Services',
        short_name: 'VTX',
        description: 'Прошивка и настройка полётных контроллеров и пультов: VTX AUTO, diff, автопрошивка',
        theme_color: '#0b0f19',
        background_color: '#0b0f19',
        display: 'standalone',
        start_url: '/',
        lang: 'ru',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        navigateFallback: '/index.html',
        runtimeCaching: [
          { urlPattern: /\/api\/(models|firmware|frequency-ranges|vtx-models|diff\/templates|news|config)/, handler: 'StaleWhileRevalidate', options: { cacheName: 'api-catalog', expiration: { maxAgeSeconds: 3600 } } }
        ]
      }
    })
  ],
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8080', ws: true } } },
  build: { sourcemap: false, target: 'es2022' }
});
