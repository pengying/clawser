# Scanner Compatibility Implementation Plan

**Goal:** Preserve Clawser's browser behavior while making all published JavaScript fully inspectable by the pinned SkillSpector release.

**Architecture:** User approved the concrete template-string simplification, explicit operation allowlist, and key-map deduplication design. Change only expressions proven to cause incomplete analysis; preserve evaluation order, string conversion, protocol bytes, authorization and browser-control boundaries. Keep every current packaged file visible to the scanner.

**Tech Stack:** JavaScript ES modules, Node.js tests, Chromium/noVNC fixtures, Docker SkillSpector v2.12.0 at NVIDIA revision 95a52d89fa16f608f0b18ccee76b0918ea4b7eef.

## Approved design and alternatives

The selected approach is a source compatibility refactor. Replace problematic complex template interpolations with readable local values and equivalent string construction, respecting observable conversions. Replace ambiguous adjacent key/action string literals with an explicit allowlist and nonduplicated key codes. Upstream scanner repair remains desirable, but current upstream still reproduces the minimal template bug; waiting or re-uploading identical bytes does not clear the current release.

Existing red evidence: the exact v0.3.4 artifact has 54 components, 36 fully inspected and 18 partial; every partial file has static_parse_limit, and src/cdp.mjs also has obfuscated_instruction_text. Local no-LLM output exactly matches the hosted worker diagnostic. Minimal JavaScript and controls are retained in the private publication QA directory.

## Task 1: compatibility implementation

1. Verify known failing predicates against each affected file before changing it. Use the pinned scanner module without keys or model calls.
2. Refactor the 18 affected source/runtime/test files narrowly. Preserve all existing capabilities, security checks, source files, error and network protocol text. Do not add baselines, scanner exclusions, suppressions, weakened limits or new runtime dependencies.
3. For CDP key/action changes, preserve the existing input domain, key codes, Ctrl+A handling and length/type boundaries. Add or run meaningful behavior checks alongside existing CDP tests.
4. Rerun the deterministic checks for every affected file, then inspect all packaged files for newly introduced reasons.
5. Run focused tests for each touched subsystem. No implementation-mirroring tests are needed for string spelling alone.

## Task 2: review and complete verification

1. Review spec compliance independently: same files/capabilities, full scan coverage and behavior constraints.
2. Review code quality and semantic equivalence independently, focusing on interpolation coercion and evaluation order, client-injected functions and CDP input validation.
3. Pack the candidate and run direct SkillSpector in the pinned Docker runtime, LLM disabled. Require execution success, is_complete true, all packaged components fully inspected, no entirely uninspected files. Heuristic findings remain available for the final contextual judge.
4. Run full Node/browser/runtime tests, package checks and diff checks. Compare the new packed file inventory to v0.3.4.

## Task 3: release

1. Prepare v0.3.5 metadata/docs/changelog after implementation is verified.
2. Merge the reviewed branch, push and require normal CI, then create a new immutable tag and GitHub release through the existing workflow.
3. Verify the released archive checksum and source bytes, and repeat the scanner check on that exact artifact.
4. Submit that artifact to ClawHub with exact commit/ref metadata; save the initial publication receipt before any long wait so pending-attempt diagnostics remain available.
5. Confirm publication before anonymous OpenClaw registry-install QA. Do not create a duplicate of an active attempt or bypass scan/moderation gates.

The current live OpenClaw/browser deployment is outside this refactor and remains available for the user's registration handoff. Do not reload, restart or migrate it while that task is active.
