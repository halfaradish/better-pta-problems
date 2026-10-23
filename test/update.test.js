// 检查更新：版本比较与 GitHub Releases 数据提取
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, normalizeVersion, pickReleaseInfo } from '../src/shared/update.js';

test('normalizeVersion：剥掉 v 前缀与预发布段', () => {
  assert.equal(normalizeVersion('v0.11.3'), '0.11.3');
  assert.equal(normalizeVersion('V1.2'), '1.2');
  assert.equal(normalizeVersion('0.12.0-beta.1'), '0.12.0');
  assert.equal(normalizeVersion(' 1.0+build.5 '), '1.0');
  assert.equal(normalizeVersion(''), '');
  assert.equal(normalizeVersion(null), '');
});

test('compareVersions：逐段数值比较，缺段当 0', () => {
  assert.equal(compareVersions('0.11.3', '0.11.3'), 0);
  assert.equal(compareVersions('0.11.4', '0.11.3'), 1);
  assert.equal(compareVersions('0.11.3', '0.11.4'), -1);
  assert.equal(compareVersions('0.12', '0.11.3'), 1);      // 少一段不小
  assert.equal(compareVersions('1.0', '0.99.9'), 1);
  assert.equal(compareVersions('0.11.10', '0.11.9'), 1);   // 数值比较，不是字典序
  assert.equal(compareVersions('v0.11.3', '0.11.3'), 0);   // 前缀不参与
});

test('pickReleaseInfo：提取版本、发布页与时间，识别不出返回 null', () => {
  const full = pickReleaseInfo({
    tag_name: 'v0.11.4',
    html_url: 'https://github.com/halfaradish/better-pta-problems/releases/tag/v0.11.4',
    published_at: '2026-10-24T08:00:00Z',
  });
  assert.deepEqual(full, {
    version: '0.11.4',
    url: 'https://github.com/halfaradish/better-pta-problems/releases/tag/v0.11.4',
    publishedAt: '2026-10-24T08:00:00Z',
  });

  // tag 缺失时退回 release name；url/time 缺失给空串
  assert.deepEqual(pickReleaseInfo({ name: 'v1.0' }), { version: '1.0', url: '', publishedAt: '' });
  assert.equal(pickReleaseInfo({ tag_name: 'nightly' }), null);
  assert.equal(pickReleaseInfo({}), null);
  assert.equal(pickReleaseInfo(null), null);
});
