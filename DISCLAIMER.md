# 免责声明 / Disclaimer

[English](DISCLAIMER.en.md) | 中文

> **这不是法律意见。** 本文只做工程层面的风险提示；是否合法、需要哪些许可，请咨询有资质的律师或当地主管部门。

## 1. 用途

CongLive（葱直播）的源代码、文档、截图和宣传片，仅供**技术学习、研究、个人测试与自建部署演示**。项目不提供内容审核、实名认证、版权清理、备案代办或任何合规保证。你将项目用于公开直播、商业服务或面向公众的产品时，运营者需自行完成全部合规义务。

## 2. 直播与内容合规（尤其中国大陆）

公开提供直播/点播服务可能涉及（以当地现行规定为准）：

- ICP 备案、公安联网备案，以及域名/服务器的实名与接入要求；
- 直播实名制、未成年人保护、内容审核与应急处置；
- 网络文化经营、信息网络传播视听节目等许可或备案（取决于内容和业务形态）；
- 个人信息保护、隐私政策、用户协议、数据跨境与留存要求；
- 著作权、表演者权、音乐/影视/游戏画面等授权；
- 录制、回放、截图和二次分发的告知与授权。

**运营者应自行咨询专业机构，不要因为本项目能运行就认为可以直接商用或公开运营。**

## 3. 摄像头、屏幕与麦克风

- 拍摄/录制他人、他人屏幕、会议、课堂、办公环境、医疗或金融信息前，必须取得明确同意。
- 禁止用于偷拍、窃听、窥私、骚扰、诈骗、冒充、侵犯商业秘密或其他违法用途。
- 录像默认保存在部署者的服务器；部署者应设置访问控制、留存期限和删除机制，并告知被录制者。
- 观众弹幕、封面、头像和上传内容由上传者负责；运营者应建立举报、屏蔽、删除和侵权投诉渠道。

## 4. Live2D、模型与第三方素材

- 本仓库**不包含** Live2D/Cubism 模型、纹理、动作或 Cubism Core 运行时；只提供加载器。
- 使用 Live2D Cubism SDK/Core、模型、动作和表情，必须遵守 Live2D 官方条款以及模型作者的使用须知。
- 模型作者若禁止再分发，请勿把模型文件放入公开仓库、公开网盘、公开静态目录或可被他人直接下载的 URL。
- 本项目与 Live2D Inc.、DeepSeek 及其他模型/品牌权利人**没有隶属、授权或背书关系**。
- 宣传片中不展示任何 Live2D 模型形象；音效由脚本合成，不使用第三方音乐。

## 5. 第三方依赖

项目使用 SRS、MySQL、Node.js、React、pixi.js、WebRTC SDK 等第三方组件，各自适用其原始许可证。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。MIT 许可证只覆盖本项目自有代码，不覆盖第三方组件、模型、字体或商标。

## 6. 安全与可用性

- 软件按“现状”提供，不保证无缺陷、不中断或适合特定用途。
- 部署者必须修改默认密码、使用随机密钥、配置 HTTPS、限制管理后台访问、定期备份并关注安全公告。
- 因配置不当、弱口令、公开管理端口、未授权录制或第三方服务导致的损失，由部署者自行承担。

## 7. 残余风险（请显式知悉）

即使完成上述检查，仍存在不可完全消除的风险：公网端口暴露、弱口令/凭据泄露、SRS/MySQL/管理后台被扫描、WebRTC 媒体被未授权转发、Live2D/模型/字体/音乐授权链不完整、直播内容和弹幕侵权、录制与隐私纠纷、以及部署环境的系统漏洞。项目不提供 WAF、限流、内容审核、实名认证、风控或合规审计。部署者应将“不能保证零风险”写入自己的用户协议/隐私政策，并保留日志、下架和应急响应机制。

## 8. 责任限制

在适用法律允许的最大范围内，项目贡献者不对因使用或无法使用本项目而产生的任何直接、间接、附带、特殊或后果性损失承担责任，包括但不限于数据丢失、隐私泄露、版权索赔、行政处罚、直播事故或商业损失。

## English summary

This project and its promo materials are provided **for technical study, research, personal testing and self-hosted demos only**, “as is”, without warranty. They are **not legal advice** and provide no compliance guarantee. Operators are solely responsible for live-streaming licenses/filings (e.g. ICP/公安备案 where applicable), real-name verification, minors protection, content moderation, privacy/consent for camera, screen and microphone capture, copyright clearances, and all local laws. No Live2D models or Cubism Core are bundled; users must obtain their own licenses and must not redistribute restricted model files. Third-party components remain under their own licenses (see `THIRD_PARTY_NOTICES.md`). To the maximum extent permitted by law, contributors are not liable for any damages or claims arising from use of this project.

## 联系 / 下架

如认为仓库中的内容侵犯你的权利，请通过仓库 Issue 或 Security Advisory 联系维护者，并提供权利证明与具体链接；核实后会处理。
