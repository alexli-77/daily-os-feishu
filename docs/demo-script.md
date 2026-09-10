# Five-minute demo

A script for walking an interviewer through this project. Timings are a budget,
not a plan — the middle two sections are where the conversation actually goes,
so the opening and closing are written tight enough to be cut.

Read [architecture.md](architecture.md) first; this script assumes it.

---

## 0:00–0:45 · The problem

> I do a two-week planning and retrospective cycle. The planning half was fine.
> The retrospective half kept failing, and not for the reason I assumed.
>
> It was not that I lacked discipline. It was that by the time I sat down to ask
> "what actually happened in these two weeks", the evidence was scattered across
> a tracker, a calendar, and a pile of notes — and reassembling it took longer
> than the reflection itself. So the reflection got skipped.
>
> So the thing I built is not a to-do app. It is a system that collects the
> evidence, drafts the comparison between what I planned and what I did, and
> writes the result into a markdown file I own.

**Why this opening:** it states a problem with a mechanism, not a complaint. The
interviewer's next question is usually "why not just use X", and the answer is
already in it — the hard part was assembly, not storage.

---

## 0:45–1:45 · Architecture

Show the diagram in [architecture.md](architecture.md).

Three claims, in this order:

1. **The source of truth is markdown on my disk.** Not a database, not a server.
   Every other decision follows from that one.
2. **Therefore the service runs on my own machine.** Not a preference — the
   files are local, skills spawn local CLIs under my session, scheduling is
   `launchd`. A hosted version would have to ingest my entire vault to work.
3. **Clients are clients.** A SwiftUI Mac app, an iOS app, and a
   server-rendered console all talk to the same local HTTP API. The console is
   frozen for UI polish now that the native clients exist, which is written down
   as an ADR rather than left as an intention.

If they push on 2, the useful detail is `SchedulerPort`: `launchd` on a Mac,
`node-cron` in Docker, behind one interface — so the scheduler is not what
decides where the service can run.

---

## 1:45–3:30 · Demo

Not a feature tour. One path, chosen because it shows a design decision rather
than a screen.

**Open a cycle.** Three sections — priorities, retro, review — each carrying a
badge saying who last wrote it: the planner, me, or the model.

**Point at that badge.** This is the interesting part:

> The planner regenerates priorities. But I edit them by hand mid-cycle, because
> things come up. So a rerun that overwrote my edits would destroy the only copy
> of the thing I actually decided.
>
> Instead, each section records who last wrote it. If I have edited it, a new
> planner draft is held next to my version and I merge it. If I have not, it
> applies.

**Then show the teammate view.** Same screen, my partner's cycle, no edit
controls at all.

> The edit controls are not disabled — they are not rendered. And that is only
> the presentation layer. The write is refused by a server-side assertion and
> again by row-level security in the database. I have a regression test that
> constructs a write against a teammate's cycle and asserts it fails at both
> layers, because a read-only guarantee that lives in the UI is not a guarantee.

**If there is time:** the chat screen, and the collapsed tool trace under each
reply — which tools ran, in what order, how long each took.

> A reply with no visible trace is a reply I have to take on faith. That is the
> failure mode this whole thing exists to avoid, so the trace is part of the
> message, not something in a log screen I would never open.

---

## 3:30–4:30 · How I know it works

Be straight here. This is the section that separates a demo from a claim, and
the gap in it is more convincing than a number would be.

**What is covered:**

```bash
npm run verify
```

`typecheck` → `build` → `privacy:scan` → `license:check` → 38 regression
suites. Two worth naming:

- **`privacy:scan`** fails the build if personal identifiers reach a tracked
  file. The repository is public and the subject matter is personal data, so
  this is a gate, not a convention.
- The clients ship a **cross-language check**: the pixel avatar is a port of a
  JavaScript function, and the check compares the Swift output against values
  read off the original implementation — so one account cannot render two
  different avatars.

**What is not covered — say this without being asked:**

> There is no evaluation of agent output quality. I have no task set and no
> success-rate metric. Everything above tests the system *around* the model:
> that writeback is idempotent, that guardrails hold, that a rerun does not
> clobber an edit. None of it tells me whether the retrospective the model wrote
> was any good.
>
> That is the honest gap, and it is the next piece of work. The shape I want is
> a fixed task set with a measurable success criterion, run in CI, so that a
> prompt change has to show it did not regress.

**Why volunteer the gap:** every interviewer asks some version of "how do you
know it works". Naming the limit before they find it converts the weakest part
of the project into evidence that you can size your own work.

---

## 4:30–5:00 · What I would do next

Pick one, and have a reason:

- **Evals.** The gap above. Also the piece that connects to my PhD work on test
  generation, which makes it the one I would actually pick.
- **Observability.** Runs, durations, token counts and cost are recorded. Step
  level tracing and a written failure-mode catalogue are not.
- **Retrieval.** Memory is path- and keyword-based today. Embedding-backed
  retrieval over the vault is the obvious upgrade, and I have a search
  background to bring to it.

---

## Questions to expect

| Question | Where the answer is |
| --- | --- |
| "Why not just use Notion / Obsidian / a tracker?" | The problem was evidence assembly, not storage. 0:00 section. |
| "Why local-first? Isn't that a limitation?" | It is the product. architecture.md § *Why the service runs on your machine*. |
| "How do you stop the LLM writing nonsense into your files?" | Draft-first plus the four guardrails. architecture.md § *Guardrails*. |
| "How do you know the agent is any good?" | I do not, yet. 3:30 section — say so. |
| "What would you do differently?" | The SSR console. It duplicated the native clients for three days before I wrote the freeze line down. ADR 0001. |
| "Is this a product?" | Not yet — no external users. Two people use it. Say the number. |

---

## Before running this

- [ ] `npm run verify` passes on the machine you will demo from
- [ ] The cycle you open has real content in all three sections
- [ ] A teammate cycle exists, so the read-only view is not an empty state
- [ ] Recording, if you want one — optional, and the least valuable item here
