# Peer answers to callback decisions

A task callback decision pauses its HTTP task as `awaiting_decision`. An MCP peer decision is a separate record. Sending its answer as an ordinary message cannot resume that paused task: the backend correctly refuses a second task for the same session, and older queued notifications can block the answer.

When escalating an existing callback decision through `bridge_request_decision`, include its exact callback decision ID in `question` or `context`. The router verifies that ID against pending callback decisions belonging to the requesting thread. It persists the link before calling the backend's existing decision response endpoint. The response contains the durable continuation task ID, which is then tracked like any other peer delivery. The peer envelope and answer context reach the same native chat.

Queued decision answers take priority over older unsent notifications. Already answered queued decision requests complete without sending an obsolete question. Delivery still does not imply consumption; only the recipient can acknowledge the answer.

Missing or ambiguous callback links remain queued with `DECISION_LINK_REQUIRED`. The router does not match questions approximately, choose an option, approve tools, bypass an active native turn, or replay unknown native outcomes. Restart recovery uses the persisted callback link and the backend's existing stable continuation key. A retry with a different peer decision or different continuation context is rejected.

Regression coverage uses a real HTTP backend and router with simulated native transport. It covers the original queue deadlock, active-turn deferral, the same thread/parent relationship, restart after native acceptance before router persistence, missing linkage, conflicting resolutions and unknown outcomes without replay.

Version 0.8.3 was deployed locally on 2026-11-03 after 107 Node tests, 15 Python tests and source checks passed. The two previously blocked live answers resumed their original callback tasks and native chats; both recipients explicitly acknowledged consumption during deployment verification. Only the local HTTP/router services were restarted; native desktop apps and helpers stayed running. Runtime records and credentials remain outside Git.

## Notifications while a callback decision is pending (0.8.4)

An informational peer message (`expectReply=false`) may be delivered to an idle chat that has exactly one HTTP task waiting on a pending callback decision. It is recorded as a separate `peer_notification` task with `pausedTaskId`, rather than as a decision continuation. Completing the notification does not complete its paused parent, choose an option, or change the original decision. Active native turns and other running/unknown tasks still prevent a new notification. Existing task permissions are retained.

The desktop inventory read path coalesces concurrent in-flight queries in each Node process and filters target executable names in WMI. It re-queries after every completed or failed batch; it does not return a cached successful inventory after a later failure.

Local deployment verification on 2026-11-03: 109 Node tests, 15 Python tests and source checks passed. Both affected workers received and explicitly acknowledged their first previously blocked notifications. Codex and Claude native health probes recovered, and all six enabled background services were healthy. Later notifications remained subject to normal idle-session delivery; pending callback decisions were not answered by this repair.
