/* 检查更新：GitHub Releases 的版本比较与数据提取（纯函数，弹窗与单测共用） */

// "v0.11.3" / "0.12.0-beta" → "0.11.3" / "0.12.0"（预发布段剥掉，releases/latest 本就不返回预发布）
export function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
}

// 逐段数值比较，缺段当 0：0.12 > 0.11.3、1.0 > 0.99；返回 -1/0/1
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(x => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map(x => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// 从 /releases/latest 的返回体里提取更新检查需要的字段；识别不出返回 null
export function pickReleaseInfo(data) {
  const version = normalizeVersion(data && (data.tag_name || data.name));
  if (!/^\d+(\.\d+)*$/.test(version)) return null;
  return {
    version,
    url: typeof data.html_url === 'string' && data.html_url ? data.html_url : '',
    publishedAt: typeof data.published_at === 'string' ? data.published_at : '',
  };
}
