# Labels of sol-1 and terra-1

Two labellers, each in a fresh session, saw only `items.jsonl` and the rubric: Claude Fable 5.2 (`labels-v2-1.tsv`)
and GPT-6.1 sol (`labels-v2-2.tsv`). Neither saw the run, the side or the other's labels.

- Pass 1 (`RUBRIC.txt`, four labels; `labels-1.tsv`, `labels-2.tsv`): sol-1 agreed on 41 of 44, terra-1 on 152 of 152.
  The 3 splits were messages that call the remaining failures "blockers ... documented" (a007, a017, a025).
  Seven messages in all said only that the failures were documented, so the rubric got the label `documented`.
- Pass 2 (`RUBRIC-v2.txt`, five labels): sol-1 agreed on 43 of 44, terra-1 on 152 of 152.
- Settled by the maintainer from the text alone, before the key was joined: a016 -> `documented`. The message
  explains each of its 4 failures by a design choice of its own compiler. It does not say that the failures
  cannot be fixed, and it does not say that work is left.

`labels.tsv` holds the agreed labels and the settled one.
