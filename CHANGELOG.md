# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-22

First platform-shaped, deployable release. Moves the project from a local
Mac-only alpha to a version that also runs as a container, with release
engineering in place.

### Added

- Embedded SQLite storage: account and artifact stores migrated to an on-disk
  SQLite database via `better-sqlite3` (LEO-212).
- Docker / Linux runtime shape: multi-stage `Dockerfile` and `docker-compose.yml`
  for running the agent as a long-lived container with a loop scheduler.
- Platform MVP: API-key billing, three-tier OKR source, todo scorer, and a web
  console for setup and operation.
- Biweekly OKR progress write-back, sync-drift detection, and a container-native
  scheduler (LEO-109 / LEO-120 / LEO-212).
- Calendar planning: builtin draft engine with fallback, planning dashboard
  validation, and Feishu calendar draft bridge and cards (LEO-110 / LEO-114 /
  LEO-115).
- Daily review reconciliation against the morning todo plan (LEO-232).
- Daily todo inbox capture and structured weekly planning evidence.
- Right-edge peek mode for the Mac companion.
- Release engineering: CI verify gate (typecheck, build, privacy scan, license
  allowlist check, regression tests) that blocks merges on failure, license
  allowlist enforcement, and a tag-triggered Docker image publish to GHCR
  (LEO-234).
- Version reporting: `doctor` prints the current version and the web UI shows it
  in the footer.

### Fixed

- Daily plan / review cards no longer leak raw JSON when parsing fails.
- Corrected GitHub task titles in daily plan summaries.

[Unreleased]: https://github.com/alexli-77/daily-os-feishu/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/alexli-77/daily-os-feishu/compare/v0.1.0-alpha.2...v0.2.0
