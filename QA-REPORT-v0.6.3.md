# CongLive v0.6.3 QA 验收报告

验收对象：CongLive v0.6.2 Full 项目源码；本次检查发现兼容问题后，生成 v0.6.3 修正源码。

## 已实际执行并通过

| 检查 | 结果 | 说明 |
|---|---|---|
| 后端 npm test | 通过，3/3 | `node --check` + Node 内置测试 |
| 后端 JavaScript | 通过 | `backend/src` 与全部插件逐文件 `node --check` |
| 插件 JavaScript | 通过 | welcome、stream-audit、plugin-template |
| Shell 脚本 | 通过 | install.sh、manage.sh、fix-live-status.sh 执行 `bash -n` |
| Web TSX 语法 | 通过 | TypeScript transpileModule 语法转译；未做完整类型解析 |
| 管理后台脚本 | 通过 | 从 admin.html 提取内嵌脚本后 `node --check` |
| JSON | 通过 | package.json 与插件 manifest |
| Android XML | 通过 | AndroidManifest.xml、styles.xml |
| Compose YAML | 通过 | Python YAML parser 结构解析；不是 Docker Compose 自身验证 |
| SRS 回调配置约定 | 通过 | 自动化测试检查 default vhost 内 hooks enabled 与两个回调 URL |
| ZIP 完整性 | 通过 | 输出包完成 `unzip -t` 检查 |

## 本轮发现并修正

1. mysql2 默认可能把 MySQL BOOLEAN/TINYINT(1) 读成数字 0/1。v0.6.2 API 直接返回该值，而 Android `JSONObject.optBoolean()` 不会把数值 1 当作 true，可能导致服务器已标记开播，客户端仍显示未开播。
2. v0.6.3 将 `/api/streams` 和 `/api/streams/mine` 中的状态字段规范为 JSON Boolean；Android 增加兼容解析函数，兼容 Boolean、0/1 和字符串。
3. 旧 `/api/streams/:id/status` 接口允许客户端直接把 `is_live` 设置为 true，会破坏“以 SRS 回调为准”的状态规则；现已改为 405，直播状态只由 SRS `on_publish` / `on_unpublish` 维护。
4. RootEncoder 码率回调文案原为“直播中”，可能在服务器确认前让界面提前显示开播；已改为“推流速率”。

## 当前自动化测试

`cd backend && npm test`

结果：3 tests、3 pass、0 fail。

测试覆盖：
- mysqlBoolean 对数字/字符串/布尔值的转换；
- SRS 默认 vhost 的 HTTP hooks 配置；
- Android 是否使用布尔兼容字段解析 `is_live`。

## 未能执行的动态验收及原因

| 项目 | 状态 | 原因 |
|---|---|---|
| npm 依赖安装 | 未完成 | 虚拟环境 DNS 无法解析 registry.npmjs.org；依赖目录不存在 |
| Vite production build | 未执行 | React、Vite、hls.js 等依赖无法安装 |
| Express + MySQL API 集成 | 未执行 | 无已安装 Node 依赖，也没有 MySQL 服务容器 |
| Docker Compose config/build/up | 未执行 | 虚拟环境没有 docker 或 podman 命令 |
| SRS RTMP/HLS 实播 | 未执行 | 没有 SRS 容器/进程，也没有公网测试推流端 |
| Android Gradle assembleDebug | 未执行 | 没有 Gradle、Android SDK、android.jar；因此不能产出 APK |
| Android 真机录屏/内录/麦克风 | 未执行 | 需要实体设备、用户授权与设备厂商环境 |
| WebSocket 多用户弹幕联调 | 未执行 | 需要启动 Express、MySQL 和 WebSocket 服务 |
| 录像写入、回放 Range、删除 | 未执行 | 需要真实 SRS DVR 产物和服务端文件系统 |

## 运行前仍需在 VPS 验证

- `docker compose config -q` 能否通过真实 Compose 版本解析；
- mysql、backend、srs、web、caddy 容器健康状态；
- 新直播触发 SRS `on_publish`，backend 日志出现 `publish accepted`；
- 推流停止时触发 `on_unpublish`，数据库恢复 `is_live=false`；
- 浏览器/Android 能播放 HLS；
- 至少两台客户端互发 WebSocket 弹幕；
- DVR 录像实际落盘、所有者 API 只看到自己的录像、签名 URL 支持 Range；
- 后台封禁、删除、插件启停和操作审计。

## 重要结论

源码级验收已完成，且修正了一个足以导致“系统显示屏幕共享中、应用却显示未开播”的 JSON 布尔值兼容缺陷。**本报告不是生产环境验收证明**：动态服务端集成、Docker 构建、Android APK 编译和真机测试尚未完成。
