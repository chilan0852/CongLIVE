import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('WebUI source files are included at documented paths', async () => {
  await access(new URL('web/index.html', root));
  await access(new URL('web/src/main.tsx', root));
  await access(new URL('webui/admin.html', root));
  const guide = await read('WEBUI-部署说明.md');
  assert.match(guide, /webui\/admin\.html/);
  assert.match(guide, /https:\/\/你的域名\/admin/);
  assert.match(guide, /http:\/\/服务器IP:8081\/admin/);
});

test('admin page contains login and all documented management sections', async () => {
  const html = await read('webui/admin.html');
  for (const id of ['login', 'dashboard', 'overview', 'streams', 'users', 'recordings', 'plugins', 'logs', 'settings']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `admin page contains ${id}`);
  }
  assert.match(html, /\/api\/admin\/login/);
});

test('backend serves the admin page from the packaged public path', async () => {
  const source = await read('backend/src/index.js');
  assert.match(source, /app\.get\(\['\/admin', '\/admin\/'\]/);
  const dockerfile = await read('backend/Dockerfile');
  assert.match(dockerfile, /COPY --chown=node:node webui\/admin\.html \.\/public\/admin\.html/);
});

test('Compose builds backend from project root and includes web service', async () => {
  const compose = await read('server/docker-compose.yml');
  assert.match(compose, /backend:\s*\n\s+build:\s*\n\s+context: \.\./);
  assert.match(compose, /web:\s*\n\s+build: \.\.\/web/);
  // SRS 官方镜像的 ./objs 属于 root，UID 1000 无法写 srs.pid。
  assert.doesNotMatch(compose, /user: "1000:1000"/);
});

test('Nginx proxies the admin page and normalizes trailing slash', async () => {
  const nginx = await read('web/nginx.conf');
  assert.match(nginx, /absolute_redirect off;/);
  assert.match(nginx, /location = \/admin\//);
  assert.match(nginx, /location = \/admin\s*\{[\s\S]*proxy_pass http:\/\/backend:3000\/admin;/);
  const caddy = await read('server/Caddyfile');
  assert.match(caddy, /@backend path[\s\S]*\/admin\*/);
  assert.match(caddy, /redir \/admin\/ \/admin 308/);
});

test('plugin list URL printed by install/manage scripts is implemented publicly', async () => {
  const source = await read('backend/src/index.js');
  assert.match(source, /app\.get\('\/api\/plugins'[\s\S]*?plugins\.list\(\)/);
  const install = await read('server/install.sh');
  assert.match(install, /\/api\/plugins/);
  const manage = await read('server/manage.sh');
  assert.match(manage, /127\.0\.0\.1:3000\/api\/plugins/);
});
