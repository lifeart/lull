import { defineConfig, devices } from '@playwright/test';

// Real-browser e2e: boots the actual hub and drives the real Player + Controller PWAs.
// This is the full-stack path the Node tests can't cover (they use ws stubs). The hub's
// Origin allowlist includes http://localhost:<PORT>, so the pages' WebSocket is accepted.
const PORT = 8090;

export default defineConfig({
  testDir: './test',
  testMatch: /.*\.pw\.spec\.js/,
  globalSetup: './test/pw.global-setup.js', // wipe e2e state/uploads so each run is deterministic
  timeout: 30000,
  fullyParallel: false, // one hub, shared device registry
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Let <audio>.play() resolve headlessly; a real click still provides the gesture.
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
    },
  ],
  webServer: {
    command: 'node hub/server.js',
    port: PORT,
    reuseExistingServer: false,
    // Bind loopback: Playwright connects via localhost, and loopback is the token-less dev path
    // (the hub fails closed on a real interface without MP_TOKEN — see server.js finding #14).
    env: { PORT: String(PORT), HOST: '127.0.0.1', STATE_FILE: './data/e2e-state.json', UPLOADS_DIR: './data/e2e-uploads' },
    stdout: 'pipe',
  },
});
