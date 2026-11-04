/**
 * 插件开发模板：复制本目录，修改 plugin.json 的 id/name/version，
 * 再在 server/.env 的 PLUGIN_ENABLED 中添加新 ID。
 */
export async function register({ app, db, auth, hooks, logger, dataDir, plugin }) {
  // 示例：注册一个需要登录才能访问的 API。
  app.get(`/api/plugins/${plugin.id}/hello`, auth, async (req, res) => {
    res.json({
      ok: true,
      plugin: plugin.name,
      username: req.user.username,
      dataDirectory: dataDir,
    });
  });

  // 示例：监听用户创建直播事件。
  hooks.on('stream.created', async ({ stream, user }) => {
    logger.info(`[${plugin.id}] ${user.username} created stream ${stream.id}`);
    // 可在这里调用 db.query(...) 保存插件自己的业务数据。
  });
}
