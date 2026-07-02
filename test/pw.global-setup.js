// Wipe e2e hub state + uploaded sounds before each Playwright run so the suite is deterministic
// across repeated local runs (default White-first sound order, empty device registry).
import { rmSync } from 'node:fs';

export default function globalSetup() {
  rmSync('./data/e2e-state.json', { force: true });
  rmSync('./data/e2e-uploads', { recursive: true, force: true });
}
