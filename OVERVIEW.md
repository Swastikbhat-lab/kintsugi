# Automated UI defect repair — status and evidence

A working prototype of a tool that finds interface defects in a running web
app, fixes the ones that have an objectively correct answer, and refuses the
ones that don't. This document covers what it does, what it did when pointed
at the BotStacks sandbox, and what is not finished.

---

## What it does

Point it at a running app and the repository that builds it. It opens the app
in a real browser, measures the rendered page, and produces a list of defects
with numbers attached — not opinions about the design, but measurements
against published thresholds.

For a defect with a mechanically correct fix, it edits the source, reloads the
page, and measures again. The fix is kept only if the defect is gone **and**
nothing else broke. Anything else is reverted and recorded, so the same dead
end is not retried on the next run.

The measure-again step is the whole design. Without it, a tool like this
applies changes that look right and silently do nothing, or that fix one thing
by breaking another.

---

## What it found on the BotStacks sandbox

Run against the sandbox frontend on 10 August 2026.

### It fixed a real defect

On the login page, the "Forgot Password?" link was a 113×16 pixel touch
target, below the 24-pixel minimum. The tool located the rule in
`frontend/src/layouts/AuthLayout.module.css`, added a two-line floor, reloaded,
and confirmed the element now measures 113×24.

```
 .forgot {
+  min-width: 24px;
+  min-height: 24px;
   margin-top: -0.25rem;
```

That change is currently sitting uncommitted on the `fix/dirtbox-press-feedback`
branch and can be dropped with a single `git checkout`.

### It refused to fix the two larger problems, on purpose

The worst contrast failures on the login page are real: the primary link
colour measures 2.03:1 against its background where 4.5:1 is required, and the
footer text measures 3.37:1.

The tool worked out the exact colour change that would clear both. It did not
apply either one:

| Token | Current | Would become | Used in |
|---|---|---|---|
| `--color-primary` | `#4338ca` | `#8b84de` | **315 places** |
| `--color-text-subtle` | `#64748b` | `#818ea1` | **57 places** |

Retinting a shared token is a change to the product's palette, not a bug fix.
It would have passed every automated check — the contrast measurement genuinely
clears — while lightening the brand colour across the entire application. So
the tool reports the exact change and the number of places it would land, and
stops.

The same rule blocked a fix that would have resized every link in the product
via a bare `a { }` rule.

This is the part worth scrutinising. A tool that edits source needs a reason to
be trusted, and refusing a change it can prove is "correct" is that reason.

### It measured the dark dashboard without inventing failures

The signed-in dashboard is dark-themed with gradient backgrounds. On that
page it reported 12 passing elements, 22 it declined to measure, and **zero
failures**.

Declining matters. Text sitting on a gradient has no single background colour
to measure against, and a tool that guesses will produce confident nonsense —
an earlier manual audit of this app reported the dashboard's "Good afternoon"
heading at 1.17:1, a figure nobody could reproduce. This tool reports that
element as unmeasurable and says why.

The trade-off is coverage: on that page roughly a third of the text could be
measured at all. It is a deliberate choice of a smaller true answer over a
larger unreliable one, but it does mean gradient-heavy screens need a human
eye as well.

### Accessibility rules

The login page passes the full automated WCAG 2.0/2.1/2.2 A and AA rule set
with no violations. The signed-in dashboard has not yet been checked against
that rule set — the contrast and layout figures above are from a separate
measurement pass, and the accessibility run needs a signed-in session to
repeat.

### Other defects it surfaced but did not fix

- The dashboard's main container clips 25 pixels of content horizontally.
- An element animates its `left` property over 0.7s, forcing layout
  recalculation on every frame; `transform` would be handled by the compositor.
- Three interactive controls fall below the 24-pixel minimum touch target.

---

## What it can and cannot fix

| | |
|---|---|
| Defect classes it detects | ~100 |
| Classes it repairs automatically | 5 |
| Fix rate, simple stylesheet app | ~60% |
| Fix rate, BotStacks | ~20% |

It repairs: contrast where the colour belongs to one component, touch targets
below the minimum, letter-spacing and line-height on display type, and missing
reduced-motion support.

It detects but will not repair: overlapping controls, console errors, clipped
text, non-composited animations, missing pressed-state feedback, and the full
accessibility rule set — missing alt text, unlabelled inputs, buttons without
accessible names. These need someone to know what the content *means*. No rule
can write an image's alt text.

It cannot see: whether the hierarchy is clear, whether the flow makes sense,
whether the design is any good. Anything without a check that can fail is
outside what this kind of tool can do, and always will be.

### Why the BotStacks rate is lower, and why that is not a criticism

BotStacks concentrates its colours into a design system. That is the correct
way to build a frontend, and it is exactly what pushes the number down —
defects live in shared tokens, and shared tokens are precisely what the tool
declines to touch.

Inverted: this is most useful on a young or inconsistent codebase where
defects are local, and least useful on a mature one, where it becomes a
detailed auditor that hands over exact diffs and impact counts instead.

---

## What is not finished

- **An optional model-backed component exists but has never been run.** It is
  intended to propose fixes for the defects no fixed rule can handle — alt
  text, accessible names, what an animation should do instead. The
  verification step would stay unchanged and still gate every proposal. Until
  it has run against real cases, its value is unproven.
- **A deployed site can be audited but not repaired.** Source edits do not
  reach an already-built bundle, so it must run against a development server.
- **Utility-class frameworks are out of reach.** Where a style comes from a
  Tailwind class in markup rather than a CSS rule, there is nothing to patch.
  CSS Modules are handled.
- **Pages behind a login need a browser you have already signed into.** The
  tool never handles credentials. That path works but has only been tested
  against a synthetic browser session, not a real one.
- **This is not a product.** No accounts, no hosting, no multi-tenancy. It runs
  from a command line or a local dashboard.

---

## What using it on BotStacks would involve

1. Run it against the frontend development server, on whichever routes matter.
2. Review what it proposes. Component-scoped fixes arrive as individual
   commits on their own branch, one per fix, each with the measurement and the
   reasoning in the commit message.
3. Decide separately on the escalated items — the two colour tokens above are
   the main ones, and they are a design decision rather than an engineering
   one.

It requires a clean working tree before it will commit anything, so its
changes never get mixed into work in progress.

---

## Summary

It works, it is honest about its limits, and on a well-built application most
of its value is in what it finds and refuses to touch rather than in what it
fixes. The single change it made to BotStacks is small and verifiable. The two
changes it declined to make are the ones worth a conversation.
