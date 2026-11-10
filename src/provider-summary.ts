import * as host from "@earendil-works/pi-ai";

/**
 * EXPERIMENT: a short summary block written by the provider at an automatic rollover.
 *
 * A host that implements `providerSummary` on a compaction asks the session's model for the block
 * and sends it ahead of the retained tail, which keeps the reasoning of the tail's replies valid.
 * The block carries no task state; the recovery record after the tail and the task note do.
 */
export type ProviderSummaryRequest = { readonly instructions: string };
type SupportProbe = (model: unknown) => unknown;
function isProbe(value: unknown): value is SupportProbe {
	return typeof value === "function";
}
/** Exported by a host that can make the block; it knows which models return one. */
const hostSupport: unknown = Reflect.get(host, "supportsProviderSummary");
export function hostMakesProviderSummary(model: unknown): boolean {
	return isProbe(hostSupport) && model !== undefined && hostSupport(model) === true;
}
/** Measured size of a one-line block is 59 to 77 tokens; Pi's estimate does not count it. */
export const PROVIDER_SUMMARY_TOKENS = 100;
/**
 * The model answers a request for a one-line summary. It refuses a request to reply with a fixed
 * line or with the path only, and one that tells the summary to speak about "the recent messages",
 * so the wording asks for a summary that points to the note, or to the record when there is none.
 */
export function providerSummaryInstructions(notePath: string | undefined): string {
	const pointer =
		notePath === undefined
			? "state that the details are in the recovery record below"
			: `point to the task note \`${notePath}\` and say to read that note and proceed from there`;
	return `Write a summary of one line, at most 20 words: name the task in a few words, then ${pointer}. Do not mention progress, a pending step or a next step. Do not call any tools; respond with the summary text only.`;
}
type MessageLike = { readonly role: string };
/**
 * How many leading messages Pi sends exactly as the provider last saw them. With a block, those
 * are the leading system message and the retained tail up to the record; changing, removing or
 * reordering one makes the provider drop the reasoning of every reply after it.
 */
export function messagesHeldByProviderSummary(messages: readonly MessageLike[]): number {
	const [first] = messages;
	if (
		first?.role !== "system" ||
		!("providerSummary" in first) ||
		first.providerSummary === undefined
	) {
		return 0;
	}
	const record = messages.findIndex((message) => message.role === "compactionSummary");
	return record < 0 ? messages.length : record;
}
