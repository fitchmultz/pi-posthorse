# Correction safeguards

These safeguards address repeated mistakes, not speculative style preferences. Local acceptance
and CI both run `npm run verify`. No new suppression or policy exception is introduced.

## Source identity is not a history-read reference

Evidence:

- [Context-edit recovery, #38](https://github.com/fitchmultz/pi-posthorse/pull/38)
  (`532c9b8`) needed replacement-entry references so history reads recover edited content rather
  than the original message.
- [Retained edited receipts, #92](https://github.com/fitchmultz/pi-posthorse/pull/92)
  (`3bfdd37`) fixed the inverse mistake: comparing replacement IDs to retained source IDs copied
  an already-retained receipt into the recovery record again.

**Level: architecture, with a required typed decision.** `projectedToolEntries` resolves retention
while it still owns the native source entry, then supplies the effective history-read ID and a
required `retained` boolean. `recoverableToolResults` cannot compare the two identities because it
receives neither the source ID nor the retention set. It still sees every call/result before
selecting receipts, preserving call provenance and trailing-batch chronology.

The source and replacement identities cannot be collapsed into one ID: Pi retains the source,
whereas history must read the replacement. The architecture removes that choice from the receipt
selector instead of adding string brands, casts or a second identity registry.

The existing owner-boundary test
`retained edited async receipts are excluded by source identity while discarded edits keep history pointers`
checks both contracts. With `src/recovery.ts` and `src/recovery-results.ts` restored from
`3bfdd37^` in a disposable checkout, it fails because `APPROVED_RECEIPT` is repeated despite being
retained. It passes with the owner-boundary separation. Run it independently with:

```sh
node --import ./test/pi-loader.ts --test \
  --test-name-pattern='retained edited async receipts' test/posthorse.test.ts
```
