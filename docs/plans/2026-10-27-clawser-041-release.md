# Clawser 0.4.1 Release Preparation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare the verified More dismissal fix and accurate viewer-mode guidance as a new 0.4.1 release.

**Architecture:** Retain the existing desktop/noVNC and explicit existing-tab CDP implementations. Standard setup selects the same desktop viewer across authorized channels; no automatic fallback or browser-state migration is added. The existing 0.4.0 release remains immutable.

**Tech Stack:** Node.js 24, OpenClaw plugin, Chromium browser fixtures, noVNC 1.7.0.

1. Base the isolated release branch on the approved More dismissal fix (`cea1a74`).
2. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and versioned installation examples in `README.md`, `docs/install.md`, and `CONTRIBUTING.md` to 0.4.1.
3. Explain the standard noVNC viewer, explicit CDP compatibility mode, and lack of headless-tab/form-state transfer in README and installation guidance.
4. Run `npm ci --ignore-scripts`, then `npm test` with local Chromium and the pinned noVNC assets; run `npm run test:runtime`, `npm run check:package`, and `git diff --check`. Keep validation logs outside the repository.
5. Commit documentation/version preparation only. Do not push, tag, publish, install, reload, or change live resources during this preparation.
