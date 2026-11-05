# Active-chat delivery validation — 2026-11-05

## Changes

Peer messages, replies and decision questions now use delivery-only native input.
They preserve the current conversation settings and do not wait for a tracked
model turn to finish. Explicitly linked callback continuations still respect the
existing paused-task protocol. A native acceptance receipt is not consumption;
the recipient must acknowledge and reply using the exact message ID.

Codex read-contract circuits have a single-flight, 60-second recovery cooldown.
Only a validated native thread read under the unchanged desktop/profile binding
clears the circuit. HTTP receipts and independently gated sends remain available
when startup encounters a capability gate. Unknown writes are never replayed.

Automatic polling stops after tracked tasks finish. Explicit watches remain live.
The Claude relay prioritizes unstarted writes over queued reads, bounds queue
length, and rejects expired/disconnected pending operations before native dispatch.
The supervisor filters process inventory at the CIM provider and resolves the
Windows session once instead of repeatedly for hundreds of workers.

## Verification

- 147 Node tests and 19 Python tests passed after integrating the remote Claude
  local-command transcript metadata fix. Source/profile revision checks passed.
- Tests cover active recipients, reply-requesting inputs, paused decisions,
  per-destination input ordering, concurrent destinations, fast-reply races,
  crash reconciliation, read-probe concurrency/stale evidence, expired queues,
  write prioritization, and retirement of completed-task polling.
- Live desktops: Codex 26.1029.7803.0 and Claude 4.16336.0.0. Temporary test chats
  used `gpt-6-luna` with low effort and `claude-haiku-5-5` respectively.
- Both recipients were observed active before their second test input was
  enqueued. Both A/B pairs produced separate explicit acknowledgements and
  replies, with no unrelated final answer attributed to either input.
- After bridge service restart, all four exact-message replies remained intact.
  A timed-out test input remained unknown and was not automatically replayed.
- Two still-valid production queue entries were delivered with their original
  IDs. Two known-unsent expired entries were marked expired rather than executed.
- The Codex read circuit recovered by successful native readback. Desktop
  applications and their active chats were not restarted during deployment.

## Limits and cleanup

The additional test-chat-to-test-chat message reached Claude, but its agent
requested clarification of the allowed sender before replying. A clarification
attempt exposed the old polling backlog and timed out before the final queue fix.
The user then archived the Codex test chat; that additional round trip was not
replayed or counted as a passed test. Archiving the test chats remains with the
user. The per-desktop A/B round trips above did pass.

Runtime evidence, queue IDs, backups and transcripts remain outside Git under
the installation's ignored runtime directory. No npm release was made.
