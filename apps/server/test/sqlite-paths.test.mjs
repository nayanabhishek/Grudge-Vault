import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { validateProductionSqlitePath } from '../dist/sqlite-game-store.js';

function withEnvironment(values, run) {
  const original = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { run(); } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('production persistent-disk mode still accepts paths beneath /var/data by default', () => {
  withEnvironment({ NODE_ENV: 'production', ALLOW_EPHEMERAL_SQLITE: undefined }, () => {
    assert.doesNotThrow(() => validateProductionSqlitePath(resolve('/var/data/grudge-vault.sqlite')));
    assert.throws(() => validateProductionSqlitePath(resolve('/tmp/grudge-vault.sqlite')), /persistent disk mount \/var\/data/u);
  });
  withEnvironment({ NODE_ENV: 'production', ALLOW_EPHEMERAL_SQLITE: 'TRUE' }, () => {
    assert.throws(() => validateProductionSqlitePath(resolve('/tmp/grudge-vault.sqlite')), /persistent disk mount \/var\/data/u);
  });
});

test('explicit production ephemeral mode accepts a database path beneath /tmp', () => {
  withEnvironment({ NODE_ENV: 'production', ALLOW_EPHEMERAL_SQLITE: 'true' }, () => {
    assert.doesNotThrow(() => validateProductionSqlitePath(resolve('/tmp/grudge-vault-test.sqlite')));
  });
});

test('explicit production ephemeral mode rejects paths outside /tmp', () => {
  withEnvironment({ NODE_ENV: 'production', ALLOW_EPHEMERAL_SQLITE: 'true' }, () => {
    assert.throws(() => validateProductionSqlitePath(resolve('/var/data/grudge-vault.sqlite')), /must be beneath \/tmp/u);
    assert.throws(() => validateProductionSqlitePath(resolve('./data/grudge-vault.sqlite')), /must be beneath \/tmp/u);
  });
});
