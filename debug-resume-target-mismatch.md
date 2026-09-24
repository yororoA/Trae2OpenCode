# Debug Session: resume-target-mismatch

- **Status**: [OPEN]
- **Issue**: `npm run migrate:local` still reports `T2O_MIGRATION_TARGET_CHANGED` after OpenCode Desktop is fully closed.
- **Debug Server**: `http://127.0.0.1:7777/event`
- **Log File**: `.dbg/trae-debug-log-resume-target-mismatch.ndjson`

## Reproduction Steps

1. Fully exit OpenCode Desktop.
2. Run `npm run migrate:local`.
3. Select the same workbench and previously migrated sessions.
4. Observe that migration resume stops with a target mismatch.

## Hypotheses & Verification

| ID | Hypothesis | Likelihood | Effort | Evidence |
| --- | --- | --- | --- | --- |
| A | A residual OpenCode process or reachable stale descriptor remains after Desktop exits. | High | Low | Confirmed |
| B | The active endpoint, version, or schema differs from the manifest target descriptor. | High | Low | Confirmed: endpoint only |
| C | OpenCode 2.0.16 changed an existing migrated session, invalidating ownership, snapshot, or deletion hash evidence. | High | Medium | Rejected |
| D | `npm run migrate:local` runs stale build output without the endpoint rebind fix. | Medium | Low | Rejected |
| E | Existing manifests have no verified, created session with an exact deletion hash for rebinding. | Low | Medium | Rejected |

## Log Evidence

- Pre-fix log line 1: a reachable service descriptor reports OpenCode `2.0.16`.
- Pre-fix log line 2: the incompatible active service blocks the managed `2.0.12` fallback.
- OS evidence: PID `84635` runs the Desktop-bundled `2.0.16` service, has PPID 1, and listens on `127.0.0.1:49374`.
- The reproduction command rebuilt `dist` and emitted the new instrumented events, rejecting hypothesis D.
- Post-fix line 1: after the orphan was stopped, the tool selected its managed `2.0.12` service on port `4097`.
- Post-fix line 2: only the endpoint changed; binary version, server version, and schema all match.
- Post-fix line 3: one candidate exists and passes presence, ownership, snapshot, and deletion hash checks.
- Post-fix line 4: endpoint rebinding was authorized.
- OpenCode 2.0.16 exposes the same import/export routes and exact SessionTransfer schema hash as 2.0.12.
- Isolated 2.0.16 native and mixed 2.0.12-client/2.0.16-server import/export round trips passed.
- Isolated 2.0.16 replacement, child protection, deletion recovery, and final readback passed.
- Mapping v6 projects real M2 structure to 110 reasoning parts, 268 tool parts, 4 final text parts,
  and zero separator parts.

## Verification Conclusion

Pre-fix, the exited Desktop left a reachable `2.0.16` service with PPID 1, so the migration correctly
refused to start a concurrent `2.0.12` writer. After terminating that orphan, the managed service
started on `4097`, the endpoint-only change was safely rebound, and M2 completed with
`迁移续跑完成，已有会话已校验。`. No target content mismatch remains. OpenCode 2.0.16 is
compatible with the exact migration surfaces verified above; future versions remain fail-closed.
