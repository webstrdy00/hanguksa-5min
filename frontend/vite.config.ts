import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import aitDevtools from '@apps-in-toss/devtools/unplugin';

export default defineConfig({
  plugins: [aitDevtools.vite(), react()],
});
