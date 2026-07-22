import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the DB in a temp dir BEFORE anything opens it. db.ts reads
// DAILY_OS_DB_PATH lazily (at first getDb), and the legacy JSON stores are
// resolved next to the DB file, so seeding here drives the one-time migration.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-sqlite-'));
process.env.DAILY_OS_DB_PATH = path.join(dir, 'daily-os.db');

fs.writeFileSync(
  path.join(dir, 'users.json'),
  JSON.stringify({
    users: [
      { username: 'admin', role: 'admin', salt: 's1', hash: 'h1', created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z' },
    ],
  }),
);
fs.writeFileSync(
  path.join(dir, 'artifacts-index.json'),
  JSON.stringify({
    artifacts: [
      { id: 'art_1', path: '/x/plan.md', rel_path: 'data/outputs/plan.md', name: 'plan.md', type: 'markdown', tags: ['okr', 'daily'], source: 'outputs', size: 10, mtime: '2026-07-01T00:00:00.000Z', registered_at: '2026-07-01T00:00:00.000Z' },
    ],
  }),
);

const db = await import('../../src/storage/db.js');
const auth = await import('../../src/ui/auth.js');
type ArtifactRecord = ReturnType<typeof db.dbReadArtifacts>[number];

function artifact(over: Partial<ArtifactRecord> & Pick<ArtifactRecord, 'id' | 'name'>): ArtifactRecord {
  return {
    id: over.id,
    path: over.path ?? `/x/${over.name}`,
    rel_path: over.rel_path ?? `data/outputs/${over.name}`,
    name: over.name,
    type: over.type ?? 'markdown',
    tags: over.tags ?? [],
    source: over.source ?? 'outputs',
    size: over.size ?? 1,
    mtime: over.mtime ?? '2026-07-02T00:00:00.000Z',
    registered_at: over.registered_at ?? '2026-07-02T00:00:00.000Z',
  };
}

try {
  testMigrationImportsLegacyJsonOnce();
  testUserStoreThroughAuthLayer();
  testFtsSearch();
  testUpsertIsIdempotentAndUpdatesFts();
  console.log('sqlite-store.test.ts: all tests passed');
} finally {
  db.resetDbForTests();
  fs.rmSync(dir, { recursive: true, force: true });
}

function testMigrationImportsLegacyJsonOnce(): void {
  const users = db.dbLoadUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0]!.username, 'admin');
  const arts = db.dbReadArtifacts();
  assert.equal(arts.length, 1);
  assert.deepEqual(arts[0]!.tags, ['okr', 'daily'], 'tags round-trip through the JSON column');
  // Legacy files are archived (renamed) so a restart never re-imports them.
  assert.ok(!fs.existsSync(path.join(dir, 'users.json')), 'users.json consumed');
  assert.ok(fs.existsSync(path.join(dir, 'users.json.migrated')), 'users.json backed up');
  assert.ok(fs.existsSync(path.join(dir, 'artifacts-index.json.migrated')), 'artifacts backed up');
}

function testUserStoreThroughAuthLayer(): void {
  auth.addUser('leon', 'password123', 'member');
  assert.equal(db.dbCountUsers(), 2);
  const found = auth.findUser('LEON'); // case-insensitive
  assert.ok(found && found.role === 'member', 'findUser is case-insensitive');
  assert.throws(() => auth.addUser('leon', 'password123', 'member'), /already exists/);
  const updated = auth.setPassword('leon', 'newpassword1');
  assert.ok(auth.verifyPassword(updated, 'newpassword1'), 'setPassword rehashes and verifies');
  assert.ok(!auth.verifyPassword(updated, 'password123'), 'old password no longer valid');
}

function testFtsSearch(): void {
  db.dbUpsertArtifact(artifact({ id: 'art_2', name: 'weekly-review.md', tags: ['weekly'] }));
  assert.ok(db.dbSearchArtifacts('weekly').some((a) => a.id === 'art_2'), 'matches name token');
  assert.ok(db.dbSearchArtifacts('okr').some((a) => a.id === 'art_1'), 'matches tag');
  assert.ok(db.dbSearchArtifacts('rev').some((a) => a.id === 'art_2'), 'prefix match');
  assert.equal(db.dbSearchArtifacts('').length, 0, 'empty query -> []');
  assert.equal(db.dbSearchArtifacts('   ').length, 0, 'blank query -> []');
  // Arbitrary FTS5 operators in user input must be neutralized, never throw.
  assert.doesNotThrow(() => db.dbSearchArtifacts('a OR b* "unclosed AND ('));
}

function testUpsertIsIdempotentAndUpdatesFts(): void {
  const rec = artifact({ id: 'art_3', name: 'alpha.md', tags: ['t'] });
  db.dbUpsertArtifact(rec);
  db.dbUpsertArtifact({ ...rec, size: 42, mtime: '2026-07-05T00:00:00.000Z' });
  const rows = db.dbReadArtifacts().filter((a) => a.id === 'art_3');
  assert.equal(rows.length, 1, 'upsert never duplicates a row');
  assert.equal(rows[0]!.size, 42, 'upsert updates mutable fields');
  const hits = db.dbSearchArtifacts('alpha').filter((a) => a.id === 'art_3');
  assert.equal(hits.length, 1, 'FTS row stays single after upsert (triggers keep it in sync)');
}
