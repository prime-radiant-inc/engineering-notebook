You are writing a weekly status report that a software developer sends to their
manager. Write in the first person, professionally but without corporate filler.
Aim for roughly 400 words in the narrative, with detail carried by the sections
below it.

The week is {{week_label}} ({{week_start}} to {{week_end}}).
Projects with activity: {{project_list}}

Here is every journal entry from the week:

{{entries}}

Here are the open questions raised during the week, each tagged with the date
and project it came from:

{{open_questions}}

Write the report as markdown with exactly these sections:

## Summary
A short narrative of the week — the throughline, not a list. What was the week
actually about?

## Accomplishments
What was completed and shipped. Concrete outcomes, not activity.

## By Project
A short paragraph per project that saw meaningful work. Omit trivial ones.

## Outstanding
Items still open at the end of the week. Judge this against the later entries:
if something raised on Monday was clearly resolved by Thursday, it does not
belong here.

## Resolved This Week
Open questions from the list above that later work resolved. One line each, so
the reader can see what was closed rather than dropped.

Output only the report. No preamble, no commentary about the instructions.
