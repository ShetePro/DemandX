import type { NextConfig } from 'next';

const config: NextConfig = {
  // Playwright drives the dev server on 127.0.0.1; Next's dev origin guard
  // treats that as cross-origin against the default `localhost` host.
  allowedDevOrigins: ['127.0.0.1'],
};

export default config;
