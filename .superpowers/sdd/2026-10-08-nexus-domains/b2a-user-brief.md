# User approval of B2a (2026-10-08), recorded by the controller

B2a is approved. Implement it. The architecture direction (C:\Users\pc\AppData\Local\Temp\claude\c--Users-pc-munder-difflin\18576430-b6b0-441d-8073-c480d20d273f\scratchpad\nexus-domains-architecture-b2.md) is approved, subject to these non-negotiable constraints.

1. **Pre-flight resource gate.**
   - At least 30 GB of free disk before verification; 35–40 GB+ preferred.
   - Never silently continue heavy execution tests when the requirement is not met.
   - Expose a clear, actionable preflight or failure state.
2. **AgentRuntime abstraction.**
   - The Claude CLI is approved as the default engine.
   - Nexus → AgentRuntime abstraction → Claude CLI adapter.
   - All agent execution goes through the replaceable interface.
   - The data model, UI, job system and workflows must never be designed around Claude-specific concepts.
3. **B2a scope.**
   - Sandboxed jobs, job lifecycle, execution isolation, file store.
   - Cancel, retry, timeout, restart recovery, durable job state.
   - Evidence collection and evidence validation.
   - Domain registry, resource controls, security and permission enforcement, approval gates where required.
   - Audit/activity, failure and recovery handling.
   - SDE execution primitives may run against a real repository.
   - Never claim the six domains are complete. No fake domain functionality to fill screens.
4. **Evidence-based completion.**
   - Never success merely because of: exit code 0, a file existing, a README existing, the UI saying completed, or an expected directory existing.
   - Completion requires domain-specific validated evidence: a parsed test report, verified build output, a fingerprinted artifact, validated metrics, an endpoint health check, an I/O contract check, or a reproducible execution record.
   - Persist the evidence and associate it with the job, artifact and version.
5. **Network.**
   - Off by default.
   - Any network-enabled operation goes through an explicit Nexus-controlled policy and approval path.
   - No unrestricted escape.
6. **Secrets.**
   - Kept in encrypted secret storage.
   - Never exposed to the renderer, logs, artifacts, activity, prompts or errors.
   - Enforce the planned spending and rate controls.
7. **Docker and resource safety.** Docker is the default boundary. Test all of these:
   - CPU, memory, disk and process limits
   - cancellation and timeout
   - container cleanup
   - abnormal termination
   - concurrent jobs
   - Docker unavailable
   - Docker resource exhaustion

   The Electron UI stays responsive whenever execution fails, times out, or Docker is under pressure.
8. **Python.**
   - Use pinned images or environments, never the global host Python.
   - Record the environment and version used.
9. **Database.**
   - SQLite stays the single source of truth. No second authoritative database for job state.
   - Engine scratch state must be recoverable and reconcilable through Nexus-owned state.
10. **Recovery.**
    - Test restart during each of these: queued, provisioning, running, tool execution, validation, waiting for approval.
    - Nexus must reconstruct the correct state, and never falsely mark unfinished work as completed.
11. **Security.** Test each of these:
    - unauthorized job execution
    - unauthorized file access
    - path traversal
    - access outside the workspace
    - invalid artifact or job references
    - secret exposure
    - approval bypass
    - network policy bypass
    - malformed tool requests

    No permission check may be bypassed for testing.
12. **Testing, before declaring B2a complete.**
    - B2a unit, integration, failure-path, restart/recovery, security and concurrency/resource tests all pass.
    - Typecheck and the production build pass.
    - The existing Nexus regression suite passes.
    - The legacy identity guard passes.
    - A fresh-app click-through passes.
    - Do not hide failures by changing or removing existing tests.
13. **Observability.** Every job durably records:
    - who or what started it
    - domain and project
    - inputs
    - allowed tools
    - environment
    - what actually executed
    - evidence produced
    - why it succeeded or failed
    - the resulting artifact or version
14. **Product.** Keep Spine + Folio. No generic dashboards, cards, islands or legacy office-style UI.
15. **Stop.**
    - Implement B2a only: no B2b, no QA, ML, DL, DA or DS workflows, and no further domain implementation.
    - Afterwards: run the full verification, then report exact results, resource and preflight findings, known limitations, exact files changed and the commit hash.
    - Then STOP and wait. Do not proceed to B2b.

## Standing rules (earlier user instructions)
- Keep proj_a8a7a6adbc58, proj_50dd134996e7 and the three older orphan plans untouched.
- Never bypass the permission system for DB cleanup.
- No appId, productName or userData rename.
- Every DB migration is additive, backed up first, and gated. Run it on the real DB only with the user's go-ahead at verification time.
- Click-throughs run only on a scratch `--user-data-dir`.
- A peer session shares `our-platform`. B2a commits only its own files by explicit pathspec, and never touches WelcomePage, hairline/*, RouteView.tsx, uiStore.ts or welcome.css without asking.
