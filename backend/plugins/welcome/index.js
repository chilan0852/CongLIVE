export async function register({ app, plugin }) {
  app.get('/api/plugins/welcome', (_req, res) => {
    res.json({ ok: true, plugin: plugin.name, version: plugin.version, message: 'CongLive 插件系统运行正常。' });
  });
}
