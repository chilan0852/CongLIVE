# CongLive v0.6 — Android 原生用户端升级

## Android 客户端
- 保留原 Kotlin `ScreenStreamService` 和 RootEncoder 录屏/RTMP 推流实现。
- 增加深色原生界面与四个主入口：直播大厅、开播、录像、我的。
- 增加登录/注册状态持久化、API 地址配置和退出登录。
- 增加直播列表、HLS 播放和直播房间切换。
- 增加 OkHttp WebSocket 实时弹幕客户端：JWT 首消息认证、历史消息、发送评论、断开状态提示。
- 增加个人直播清单、个人录像列表和 Media3 在线回放。
- 增加账号封禁/登录失效时清理本地会话并提示。
- 增加 Media3 HLS 模块和 OkHttp 依赖，版本号更新为 0.6.0。

## 服务端兼容接口
- `GET /api/streams` 返回 HLS `playUrl`，但不向访客暴露 RTMP `stream_key`。
- 新增 `GET /api/recordings/mine`，通过当前登录用户拥有的 stream_key 过滤录像，返回短时签名回放地址。

## 限制与验证
- 管理员的直播封禁、用户封禁、全局录像删除、插件开关和操作日志仍由 Web 管理后台操作；Android 客户端面向普通用户。
- 当前没有生成 APK：交付环境未配置 Android SDK/Gradle 构建链。需用 Android Studio/JDK 17 同步并构建。
- 尚未完成真机录屏、多品牌 Android 音频采集、弱网推流、多人弹幕和录像回放端到端测试。


## v0.6.1 登录/注册修复

- Android 登录/注册页面增加 API 根地址设置和 `/api/health` 一键连通性检查。
- 明确提示 `10.0.2.2` 仅用于 Android 模拟器；真机需填写 VPS 公网 API 地址。
- 服务端用户名验证支持中文及 Unicode 字母/数字，长度 3–40。
- 注册错误区分用户名重复、输入不合法和数据库服务异常，并将数据库异常写入后端日志。
- 明确普通用户账号与管理员后台账号不同。
