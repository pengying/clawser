---
name: browser-handoff
description: Use the configured browser profile for web tasks and automatically offer the private owner a temporary full-browser handoff when CAPTCHA, login, consent, or forms need human input; wait for safe handback and continue the original task.
---

# Browser Handoff

Use ordinary OpenClaw browser tools for web tasks. In production desktop mode,
call `browser_handoff` with `action=tabs` to discover the configured handoff profile
and current tabs, then explicitly use that profile in normal browser calls. The
plugin ensures that persistent browser is running. Its CDP mapping must match the
controller; the configured profile requires `attachOnly=true`, the ordinary
`openclaw` CDP driver (or its `clawd` alias), and Chromium as its browser engine. Do not switch to another browser/profile to work around a gate.

## Automatic human intervention

When a legitimate task reaches a CAPTCHA, password, 2FA, payment or consent step,
a sensitive form, or a choice requiring human judgment, create a private handoff
link promptly. A CAPTCHA is for the human to solve manually; do not implement
solvers, bypasses, evasion, or repeated automated challenge attempts. Do not
invent sensitive values or make a human's consent decision.

1. Use `action=tabs` and the returned profile/tab information to identify the
   task. Supply the exact `targetId` when available; OpenClaw labels such as `t1`
   are not raw CDP target IDs. Production `targetId` selects initial task context,
   while access includes the **entire dedicated browser profile**, all tabs,
   browser chrome, dialogs, and clipboard during control. Tell the owner this
   scope and the brief reason for intervention.
2. Call `action=create`, `permission=control`, the configured `profile`, optional
   `targetId`, and a short non-sensitive `reason`. Default lifetime is 300 seconds;
   allowed range is 30–1800. No additional confirmation is needed to create the
   requested human intervention link. The owner explicitly selects Take control
   in the viewer. Use `permission=watch` only for an observation request.
3. Deliver the returned URL unchanged in the owner's private conversation,
   briefly explain what they need to do, and ask them to select Done afterward.
   It is a bearer invitation. Never put it in groups, logs, durable memory,
   public issues, preview-fetch tools, or an external message without explicit
   authorization to send that message. A normal HTTPS browser is sufficient.
4. For intervention, pause browser actions immediately after creating the link.
   Use `action=wait`, `id`, and `timeoutSeconds<=60`. Repeat waits while the
   invitation remains alive and the owner is intervening. Do not keep navigating,
   clicking, typing, or issuing commands through an alternate tool while the
   human is using the browser. Watch-only requests allow normal task work until
   the controller reports human ownership.
5. **Continue only when `resumeAllowed=true` and `recoveryRequired` is not true.**
   `mode=ended`, a disconnected viewer, a returned wait call, or an apparent Done
   click alone does not prove safe handback. While retiring, continue waiting.
   If recovery is required or controller admission is unavailable, stop browser
   automation and report the operator recovery requirement.
6. After safe handback, take a fresh snapshot using the ordinary browser tool
   and the same configured profile. Reinspect the current tabs and actual task
   outcome. Done proves the retired viewer can no longer inject input after its
   verified boundary; it does not prove every previous click was delivered, a
   CAPTCHA was accepted, or a form succeeded. Never replay a final click or text
   merely because the stream closed. Continue the original task only if it is
   still pending and authorized.
7. On expiry, disconnect, or revoke, inspect the reported reason. Do not treat
   that reason as successful completion or repeatedly regenerate links. Ask the
   owner whether further human action is needed. Revoke links no longer needed.

## Continuation and cancellation

Production status reports `continuation=session-event` only when the installed
SDK supports both current session metadata and session-event wakeups. The plugin
polls the private controller completion queue, compares the owning session's
current `sessionId`, checks recorded cancellation, and queues a deduplicated event
before asking that same session to wake. Its event requires a fresh snapshot and
an outcome check. A canceled task or a replaced session incarnation must not be
resumed. Do not start a second copy of the task on receiving a completion event.

The SDK's enqueue/wake APIs do not atomically bind a wake to an expected
`sessionId`. Delivery and continuation are best effort; exactly-once resumption
across crashes is not guaranteed. Never promise a scheduled turn merely because
an invitation was created. If status reports `continuation=active-wait`, keep an
active wait call; once that run ends, continuation requires a new owner turn.

## Operator boundaries and legacy mode

The production plugin connects only to an operator-managed private Unix RPC
controller. Its public tool cannot install/start containers, run arbitrary shell
commands, change gateway configuration, or expose raw CDP/VNC. The controller
owns the persistent browser, input gate, VNC retirement, and authenticated viewer
tunnel. Link expiry, session end, plugin shutdown, and Done retire viewer access;
the dedicated browser profile persists. All OpenClaw browser-tool calls are
conservatively gated during human control. Independent CDP clients, shell tools,
and desktop users do not join that gate; do not use them to bypass it.

When `desktop.enabled` is absent or false, the original CDP tab-sharing mode
remains available. Discover configured profiles with `tabs`, then list tabs for
a profile. The browser must already be running. Legacy create requires the exact
`profile` and `targetId`; the link shares one tab. HTML select and classic RGB
color fields use phone-side pickers; other native dialogs and automatic popup
switching are unsupported. Legacy completion supports active waits only, and
requires a fresh normal browser snapshot before continuation.

If `browserGateFault` is present or tools report uncertain input, stop browser
automation and request operator recovery. Never promise undetectable automation,
website CAPTCHA acceptance, or availability from a particular country's network.

## Legacy viewer diagnostics

Use owner-private `status` to inspect `viewerMetrics`; numeric timing aggregates
remain available after Done/expiry. Compare serverInputWorkMs, inputAckRoundTripMs,
clientInputQueueMs, frameAckRoundTripMs, and decodeDrawMs before attributing delay
to the server, input queue, or display path. Frame ACK timing includes the return
trip and does not prove physical display presentation. Do not infer handset
latency from local or simulated-network tests.

Legacy HTML select and classic RGB fields open a local phone picker. Choices
apply only to the confirmed original field. Known rejected input reconnects in
watch mode and requires Take control again. Uncertain input requires operator
browser recovery and plugin reload; queued input must never be replayed.
