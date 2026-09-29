# Changelog

This project follows [Semantic Versioning](https://semver.org/). Product versions are
independent of IR, manifest, mapping, and verification-report format versions.

Released entries are generated from Conventional Commits by release-please. Feature
pull requests do not add an `Unreleased` section or edit the product version manually.

## [1.3.0](https://github.com/yororoA/Trae2OpenCode/compare/v1.2.0...v1.3.0) (2026-09-29)


### Added

* **opencode:** 支持旧版协议profile迁移 ([be5d537](https://github.com/yororoA/Trae2OpenCode/commit/be5d537db29f6acc135f2e60fc860449657e0cd2))
* **opencode:** 支持旧版协议向后兼容 ([#29](https://github.com/yororoA/Trae2OpenCode/issues/29)) ([4da31d0](https://github.com/yororoA/Trae2OpenCode/commit/4da31d084165f89e62b6142d4d5467c5cfc9779c))


### Fixed

* **opencode:** 使用目标平台规则解析POSIX启动器 ([357582a](https://github.com/yororoA/Trae2OpenCode/commit/357582ad22e4c596d1fa0fffd5b70f4fc31dc46d))


### Documentation

* **opencode:** 说明旧协议支持与拒绝边界 ([ff8c8ca](https://github.com/yororoA/Trae2OpenCode/commit/ff8c8ca116ada4ca6dff6ad84009b202aada27ae))

## [1.2.0](https://github.com/yororoA/Trae2OpenCode/compare/v1.1.0...v1.2.0) (2026-09-28)


### Added

* **opencode:** 增加声明式协议规则与schema兼容分析 ([f107473](https://github.com/yororoA/Trae2OpenCode/commit/f1074737442c94a5450cb235a89fa49ad0f4c6de))
* **opencode:** 自动适配兼容的 schema 演进 ([#26](https://github.com/yororoA/Trae2OpenCode/issues/26)) ([b169787](https://github.com/yororoA/Trae2OpenCode/commit/b16978761ac2e3b525a8f65310b9b96f345f0647))


### Fixed

* **release:** 修复 Release PR 质量检查触发失败 ([#28](https://github.com/yororoA/Trae2OpenCode/issues/28)) ([05c8396](https://github.com/yororoA/Trae2OpenCode/commit/05c83962f89e8028289f5f0600f940a8f122b85b))
* **release:** 固定首次自动发布基线 ([ab14361](https://github.com/yororoA/Trae2OpenCode/commit/ab14361dff1102bbb11d444caef82e51b12347d1))
* **release:** 显式指定质量工作流仓库 ([1e73141](https://github.com/yororoA/Trae2OpenCode/commit/1e73141d0c56faa15fde77bddb6e9392b8acb3c5))


### Documentation

* **opencode:** 说明schema兼容准入边界 ([1a9ae53](https://github.com/yororoA/Trae2OpenCode/commit/1a9ae53ee11194a74e4a09f7c90b6fb372fdb80e))
* **release:** 说明自动版本与 changelog 流程 ([c8b85cb](https://github.com/yororoA/Trae2OpenCode/commit/c8b85cb21ede65824cfb33d12f8b9f1f1000bbed))

## [1.1.0](https://github.com/yororoA/Trae2OpenCode/tree/v1.1.0) (2026-09-26)

### Added in 1.1.0

- OpenCode v1 and v2 target support with protocol-specific mapping and readback.
- Runtime compatibility checks for stable OpenCode 1.x/2.x releases outside the
  verified baselines, including isolated import, export, conflict, and deletion checks.
- Interactive multi-session migration with overwrite protection, resume, credential
  redaction, and post-write reconciliation.
- Public `verify:opencode` compatibility verification for both target dialects.

### Changed in 1.1.0

- Start explicit product-version tracking at 1.1.0.
- Rename the v1 development regression command to `verify:integration:v1`.

## [1.0.0] - Development baseline

- Initial package metadata used throughout early development.
- This version was not tagged, published to npm, or distributed as a GitHub Release.
