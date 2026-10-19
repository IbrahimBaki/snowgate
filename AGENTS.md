<!-- yallaflow-bootstrap:begin provider=codex version=2 sha256=8be4681265a2abf9c1231dadb828fbc6abeab43de7437c8ee565fe164d17721b — managed by YallaFlow; keep your own instructions outside this block; update with `yallaflow agent refresh` -->
## YallaFlow

This repository uses YallaFlow: engineering governance and durable project memory for coding agents. This block only points to the YallaFlow contract; it does not restate it.

The canonical YallaFlow agent contract is `.yallaflow/AGENT.md`. Read it before any project work.

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
