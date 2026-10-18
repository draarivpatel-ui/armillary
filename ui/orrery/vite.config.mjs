import react from '@vitejs/plugin-react';

export default {
  plugins: [react()],
  server: {
    port: 5173,
  },
  test: {
    environment: 'node',
    globals: true,
  },
};
