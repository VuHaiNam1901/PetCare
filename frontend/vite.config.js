import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const isSandbox = mode === 'sandbox';
  return {
    plugins: [react()],
    ...(isSandbox
      ? {
          define: {
            'import.meta.env.VITE_API_ORIGIN': JSON.stringify(
              process.env.VITE_API_ORIGIN || 'http://localhost:3002'
            ),
          },
        }
      : {}),
    server: {
      host: '127.0.0.1',
      port: isSandbox ? 5174 : 5173,
      strictPort: true,
    },
    preview: {
      host: '127.0.0.1',
      port: isSandbox ? 4174 : 4173,
      strictPort: true,
    },
  };
});
