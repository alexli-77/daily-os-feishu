/**
 * Pixel avatars, generated from a seed.
 *
 * An identicon rather than a picture: a 5x5 grid of blocks, mirrored down the
 * middle so it reads as a face-ish shape, coloured from a hash of the seed.
 * Deterministic, so the same account always draws the same avatar — the seed is
 * randomised once at registration and then stored, which is what makes it feel
 * assigned rather than derived from a name someone might change.
 *
 * Rendered as an inline SVG string with no external request and no dependency:
 * this goes into a server-rendered topbar, and an avatar that needs a network
 * round trip would be a blank square every time the page loads.
 */

const GRID = 5;
/** Only the left half plus the centre column is drawn; the rest is mirrored. */
const HALF = Math.ceil(GRID / 2);

/** FNV-1a. Small, dependency-free, and good enough to scatter short seeds. */
function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * mulberry32, seeded once per avatar.
 *
 * The first version drew each cell from `hash32(key + coords) % 100`, which
 * looked reasonable and was not: measured over 2000 seeds, 14% of avatars came
 * out completely blank and a third had three blocks or fewer. Hashes of strings
 * that differ in one character are not independent enough to use one per cell.
 * A real generator, advanced once per cell, is.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh seed for a new account. Stored, never recomputed. */
export function randomAvatarSeed(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * The avatar as an inline SVG.
 *
 * `size` is the rendered edge in px. The viewBox stays 5x5 so the blocks land on
 * whole units and cannot blur — the whole point of the pixel look.
 */
export function pixelAvatarSvg(seed: string, size = 28): string {
  const key = String(seed || 'daily-os');
  const hash = hash32(key);
  // Two different mixes so the hue is not correlated with the block layout;
  // seeds that differ in one character should look unrelated.
  const hue = hash32(`${key}#hue`) % 360;
  const fg = `hsl(${hue} 58% 44%)`;
  const bg = `hsl(${hue} 42% 93%)`;

  // Draw the half-grid, then keep drawing until it is neither empty nor solid.
  // A blank square and a filled square are both indistinguishable from a bug,
  // and with 15 cells at even odds they come up often enough to matter.
  const next = rng(hash);
  let on: boolean[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    on = Array.from({ length: GRID * HALF }, () => next() < 0.5);
    const lit = on.filter(Boolean).length;
    if (lit >= 4 && lit <= GRID * HALF - 2) break;
  }

  let cells = '';
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < HALF; x += 1) {
      if (!on[y * HALF + x]) continue;
      cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      const mirrored = GRID - 1 - x;
      if (mirrored !== x) cells += `<rect x="${mirrored}" y="${y}" width="1" height="1"/>`;
    }
  }

  return (
    `<svg class="avatar" width="${size}" height="${size}" viewBox="0 0 ${GRID} ${GRID}" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img" aria-label="头像" shape-rendering="crispEdges">` +
    `<rect width="${GRID}" height="${GRID}" fill="${bg}"/>` +
    `<g fill="${fg}">${cells}</g>` +
    `</svg>`
  );
}
