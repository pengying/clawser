# Owner-Requested Group Handoff Implementation Plan

**Goal:** Allow a verified owner to request browser handoff in an explicitly configured group and return the one-use link to that same group, while other members cannot invoke the tool.

**Architecture:** Use the host's per-turn owner authority, retain all invocation/session/sandbox guards, and add a default-empty group session allowlist. Attach the already-running browser through the existing CDP mode for in-progress tasks. The Google Chat deployment must move family turns from shared-admin compat HTTP to a trusted SDK ingress carrying the authenticated stable sender ID before enabling this option.

**Tech Stack:** OpenClaw plugin SDK V2 contexts, existing CDP backend, Cloudflare transport, Node tests and an isolated Gateway/browser activation fixture.

## Approved behavior

The operator explicitly requested group delivery when the request comes from the owner. A group's other members may claim a link the owner intentionally posts, subject to the existing one-use claim, single viewer, expiry, Done and input-gate rules. They cannot request, inspect or revoke handoffs through the agent tool. Default private-session behavior remains unchanged when no groups are configured.

## Tasks

1. Add one shared authorization helper used by desktop and existing-browser modes. Allow only actual owner turns, current invocation, valid session identity, no sandbox/subagent/cron/hook contexts, plus a configured exact group base or its valid thread. Keep all action ownership tied to the original session incarnation. Test owner/nonowner turns sharing a session and malicious parameter/text identity claims.
2. Repair existing-browser cold discovery by delegating to a healthy full service instance; stale/failed/stopped instances must fail closed. Do not create services from discovery scope.
3. Add optional Cloudflare transport to the existing-browser mode, using a valid harmless asset readiness path. Preserve default desktop readiness and mutually exclude conflicting public transports. Invalidate viewer access if the owned tunnel fails. Never expose raw CDP.
4. Update manifest/skill/operator docs for the explicit group opt-in and existing-tab scope. No hardcoded personal identities or family space IDs belong in public source.
5. Run focused authorization, lifecycle and transport tests; full browser/runtime tests; package inventory; and pinned no-LLM scanner preflight.
6. Integrate only after the family bridge proves per-sender native owner authority. Activate through a supported browser-preserving plugin reload, validated first against an isolated managed browser. Preserve current production Chrome PID and target state.

## Deployment boundary

The personal Gateway and its custom deployed plugin are outside this change. Existing family browser and tab state must be retained. The operator-approved parent identity is pinned using the authenticated Google stable ID; email is only a setup verification alias, never a claim accepted from model text. Outgoing handoff replies stay in the original requesting group/thread.
