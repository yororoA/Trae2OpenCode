# Changelog

This project follows [Semantic Versioning](https://semver.org/). Product versions are
independent of IR, manifest, mapping, and verification-report format versions.

Released entries are generated from Conventional Commits by release-please. Feature
pull requests do not add an `Unreleased` section or edit the product version manually.

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
