import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newer, createUpdateCheck, VERSION } from '../lib/version.js';

test('version comparison', () => {
  assert.equal(newer('1.2.10', '1.2.9'), true);
  assert.equal(newer('v2.0.0', '1.9.9'), true);
  assert.equal(newer('1.0.0', '1.0.0'), false);
  assert.equal(newer('1.0.0', '1.0.1'), false);
});

test('update check reports a newer GitHub release only', async () => {
  const fake = tag => async () => ({ ok: true, json: async () => ({ tag_name: tag, html_url: 'https://github.com/x/releases/tag/' + tag }) });
  const u = createUpdateCheck({ enabled: false, fetcher: fake('v99.0.0') });
  assert.deepEqual(u.info(), { current: VERSION });
  await u.check();
  assert.equal(u.info().latest, '99.0.0');
  const same = createUpdateCheck({ enabled: false, fetcher: fake(`v${VERSION}`) });
  await same.check();
  assert.equal(same.info().latest, undefined);
  const down = createUpdateCheck({ enabled: false, fetcher: async () => { throw new Error('offline'); }, log: {} });
  await down.check();
  assert.deepEqual(down.info(), { current: VERSION });
});

test('private network addresses (first-time setup and proxy trust)', async () => {
  const { isPrivateIp } = await import('../lib/app.js');
  for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.2.10', '10.1.2.3', '172.20.0.5', '169.254.1.1', 'fd12:3456::1', 'fe80::1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', '::ffff:1.2.3.4', '', undefined]) assert.equal(isPrivateIp(ip), false, String(ip));
});
