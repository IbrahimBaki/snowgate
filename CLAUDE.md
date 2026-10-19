<!-- yallaflow-bootstrap:begin provider=claude version=2 sha256=eda87b3414a57001e912954270e4f9cef44954f1943bd61afef2a95c35b66984 — managed by YallaFlow; keep your own instructions outside this block; update with `yallaflow agent refresh` -->
## YallaFlow

This repository uses YallaFlow: engineering governance and durable project memory for coding agents. This block only points to the YallaFlow contract; it does not restate it.

The canonical YallaFlow agent contract is imported here:

@.yallaflow/AGENT.md

At the start of every session — automatically, before handling the first request; the developer does not need to say "use YallaFlow":

1. Confirm `.yallaflow/` exists. If it does not, ignore this section.
2. Follow `.yallaflow/AGENT.md` — it is the only YallaFlow behavioral contract.
3. Run `yallaflow brief` for a read-only orientation and the next command to run, then handle the request.
4. For active or resumable work, run `yallaflow resume <work-id>` (or `yallaflow handoff <work-id>`).
5. Run `yallaflow guide <work-id>` for the current objective, blocker, and next valid action.
6. Follow the pinned Behavior Contract (`yallaflow skill <skill-id>`); never modify application code while guidance says it is not authorized.
7. Record progress, decisions, and evidence only through `yallaflow` commands — never edit `.yallaflow/` structured state by hand.
8. Before saying a task is done, run `yallaflow finish <work-id>` and relay its outcome.
<!-- yallaflow-bootstrap:end -->
