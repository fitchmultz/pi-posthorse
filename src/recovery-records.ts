import { isReminderType, type EntryLike } from "./contracts.ts";
import { boundedBlock, imageSummary, imagesOf, textOf } from "./message-text.ts";

export type RecoveryRecord = {
	readonly id: string;
	readonly timestamp: string;
	readonly kind: "owner" | "coordination";
	readonly label: string;
	readonly text: string;
};
type RecordSource = {
	readonly kind: RecoveryRecord["kind"];
	readonly label: string;
	readonly content: unknown;
};
function ownerAnswer(entry: EntryLike, ownerQuestion: boolean): boolean {
	const message = entry.message;
	return (
		ownerQuestion &&
		entry.type === "message" &&
		message?.role === "toolResult" &&
		message.toolName === "ask_question" &&
		message.namespace === undefined &&
		message.isError !== true
	);
}
function recordSource(entry: EntryLike, ownerQuestion: boolean): RecordSource | undefined {
	if (entry.type === "message" && entry.message?.role === "user") {
		return { kind: "owner", label: "owner input", content: entry.message.content };
	}
	if (ownerAnswer(entry, ownerQuestion)) {
		return {
			kind: "owner",
			label: "owner answer via ask_question",
			content: entry.message?.content,
		};
	}
	if (
		entry.type === "custom_message" &&
		entry.display === true &&
		!isReminderType(entry.customType)
	) {
		return {
			kind: "coordination",
			label: `visible ${(entry.customType ?? "custom").slice(0, 80)} coordination input (not direct owner input)`,
			content: entry.content,
		};
	}
	return;
}
export function recoveryRecord(
	entry: EntryLike,
	ownerQuestion: boolean,
): RecoveryRecord | undefined {
	const source = recordSource(entry, ownerQuestion);
	if (source === undefined) {
		return undefined;
	}
	const id = entry.id?.slice(0, 120) ?? "unknown";
	const text = textOf({ content: source.content }).trim();
	const summary =
		source.label === "owner answer via ask_question"
			? ""
			: imageSummary(imagesOf(source.content));
	const body = [text, summary === "" ? "" : `${summary} — recover with history read id ${id}`]
		.filter((part) => part !== "")
		.join("\n");
	return {
		id,
		timestamp: entry.timestamp?.slice(0, 80) ?? "unknown time",
		kind: source.kind,
		label: source.label,
		text: body === "" ? "(non-text content; recover the entry from history)" : body,
	};
}
export function formatRecord(record: RecoveryRecord, limit: number): string {
	return boundedBlock(
		`[${record.label} | ${record.timestamp} | entry ${record.id}]`,
		record.text,
		limit,
	);
}
export function indexLine(record: RecoveryRecord): string {
	const header = formatRecord(record, 0);
	if (record.kind !== "owner") {
		return header;
	}
	const preview = record.text.replace(/\s+/g, " ").trim();
	return `${header} ${preview.length > 120 ? `${preview.slice(0, 119)}…` : preview}`;
}
