# CongLive v0.6.3 — 全量静态验收修正

- 修复 MySQL `BOOLEAN`/`TINYINT(1)` 被 mysql2 序列化为 `0/1` 后，Android `JSONObject.optBoolean()` 读不到 true 的兼容问题。
- `/api/streams` 与 `/api/streams/mine` 将状态字段统一输出 JSON 布尔值。
- Android 所有直播状态读取改为兼容 Boolean、数字 0/1 和字符串的解析。
- 客户端不能再通过旧状态接口伪造 `is_live=true`；直播状态只由 SRS 发布/断流回调更新。
- RootEncoder 码率回调文案改为“推流速率”，避免在服务器确认前误显示“直播中”。
- 增加 Node 内置测试：数据库布尔值转换、SRS HTTP hooks 配置、Android 状态读取约定。

此版本仍未进行真实 Docker/SRS/MySQL 或 Android 真机验收；环境限制见 `QA-REPORT-v0.6.3.md`。
