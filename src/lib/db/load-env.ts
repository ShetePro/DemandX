/**
 * Load `.env` for standalone tsx entrypoints (migrations, workers, scripts).
 * `next dev` does this itself; plain Node does not.
 */
try {
  process.loadEnvFile();
} catch {
  // No .env file: fall back to whatever the shell provides.
}
