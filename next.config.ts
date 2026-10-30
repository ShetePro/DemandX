import type { NextConfig } from 'next';

const config: NextConfig = {
  // Playwright drives the dev server on 127.0.0.1; Next's dev origin guard
  // treats that as cross-origin against the default `localhost` host.
  allowedDevOrigins: ['127.0.0.1'],
  // pg-boss is an ESM package that opens its own Postgres pool; bundling it
  // into the server action chunk breaks its dynamic requires. Keep it external.
  serverExternalPackages: ['pg-boss'],
};

export default config;
