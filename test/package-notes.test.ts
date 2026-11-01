import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as nodeTest } from "node:test";
import { notesDir } from "../src/files.ts";

function projectStore(project: string, identity = "github.com/acme/tool"): string {
	return join(
		project,
		".pi",
		"package-notes",
		createHash("sha256").update(identity).digest("hex"),
		"notes",
	);
}
function git(cwd: string, ...args: readonly string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}
function packageCheckout(project: string): string {
	const checkout = join(project, ".pi", "git", "github.com", "acme", "tool");
	mkdirSync(join(checkout, "src"), { recursive: true });
	git(checkout, "init", "-q");
	writeFileSync(join(checkout, "tracked.txt"), "package source");
	git(checkout, "add", "tracked.txt");
	git(
		checkout,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-qm",
		"initial",
	);
	return checkout;
}
function writeLegacy(checkout: string, content: string): string {
	const legacy = join(checkout, ".pi", "notes");
	mkdirSync(join(legacy, "task"), { recursive: true });
	writeFileSync(join(legacy, "task", "state.md"), content);
	return legacy;
}
function updateCheckout(checkout: string): void {
	// Official Pi 1.3.0 ensureGitRef/cleanAndInstallGitDependencies use these operations
	// when the selected commit changes (the same cleanup can retry after interruption).
	git(checkout, "reset", "--hard", "HEAD");
	git(checkout, "clean", "-fdx");
}

nodeTest(
	"project package notes migrate outside the checkout and survive Pi's update cleanup",
	() => {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "posthorse-project-package-")));
		try {
			const checkout = packageCheckout(project);
			const legacy = writeLegacy(checkout, "before migration");
			const moved = projectStore(project);
			assert.equal(notesDir(join(checkout, "src")), moved);
			assert.equal(readFileSync(join(moved, "task", "state.md"), "utf8"), "before migration");
			assert.equal(lstatSync(legacy).isSymbolicLink(), true);
			writeFileSync(join(legacy, "task", "older-session.md"), "through compatibility link");
			updateCheckout(checkout);
			assert.equal(existsSync(legacy), false);
			assert.equal(notesDir(checkout), moved);
			assert.equal(readFileSync(join(moved, "task", "state.md"), "utf8"), "before migration");
			assert.equal(
				readFileSync(join(moved, "task", "older-session.md"), "utf8"),
				"through compatibility link",
			);
			assert.equal(readFileSync(join(checkout, "tracked.txt"), "utf8"), "package source");
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"fresh project package notes are isolated by project, including symlinked project paths",
	() => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "posthorse-package-isolation-")));
		try {
			const first = join(dir, "first");
			const second = join(dir, "second");
			const firstCheckout = packageCheckout(first);
			const secondCheckout = packageCheckout(second);
			symlinkSync(first, join(dir, "alias"), "dir");
			const moved = notesDir(firstCheckout);
			assert.equal(moved, projectStore(first));
			assert.equal(
				notesDir(join(dir, "alias", ".pi", "git", "github.com", "acme", "tool", "src")),
				moved,
			);
			assert.notEqual(notesDir(secondCheckout), moved);
			mkdirSync(moved, { recursive: true });
			writeFileSync(join(moved, "fresh.md"), "new notes");
			updateCheckout(firstCheckout);
			assert.equal(
				readFileSync(join(notesDir(firstCheckout), "fresh.md"), "utf8"),
				"new notes",
			);
			assert.equal(existsSync(join(notesDir(secondCheckout), "fresh.md")), false);
			assert.equal(existsSync(join(firstCheckout, ".pi")), false);
			assert.equal(notesDir(first), join(first, ".pi", "notes"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"project package migration preserves existing notes and timestamp collision entries",
	(context) => {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "posthorse-package-collision-")));
		context.mock.method(Date, "now", () => 1234);
		try {
			const checkout = packageCheckout(project);
			const moved = projectStore(project);
			mkdirSync(join(moved, "task"), { recursive: true });
			writeFileSync(join(moved, "task", "state.md"), "canonical");
			mkdirSync(join(moved, "from-checkout-1234"));
			symlinkSync("missing", join(moved, "from-checkout-1234-1"), "dir");
			const legacy = writeLegacy(checkout, "older session one");
			assert.equal(notesDir(checkout), moved);
			assert.equal(
				readFileSync(join(moved, "from-checkout-1234-2", "task", "state.md"), "utf8"),
				"older session one",
			);
			assert.deepEqual(readdirSync(join(moved, "from-checkout-1234")), []);
			assert.equal(lstatSync(join(moved, "from-checkout-1234-1")).isSymbolicLink(), true);
			updateCheckout(checkout);
			writeLegacy(checkout, "older session two");
			assert.equal(notesDir(checkout), moved);
			assert.equal(
				readFileSync(join(moved, "from-checkout-1234-3", "task", "state.md"), "utf8"),
				"older session two",
			);
			assert.equal(readFileSync(join(legacy, "task", "state.md"), "utf8"), "canonical");
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"package storage detection leaves containers and similarly named ordinary repositories alone",
	() => {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "posthorse-package-boundary-")));
		try {
			packageCheckout(project);
			const owner = join(project, ".pi", "git", "github.com", "acme");
			assert.equal(notesDir(owner), join(owner, ".pi", "notes"));
			const ordinary = join(project, ".pi", "git-other", "github.com", "acme", "tool");
			mkdirSync(ordinary, { recursive: true });
			git(ordinary, "init", "-q");
			assert.equal(notesDir(ordinary), join(ordinary, ".pi", "notes"));
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"linked project-package worktrees share relocated notes outside the outermost package tree",
	() => {
		const project = realpathSync(mkdtempSync(join(tmpdir(), "posthorse-package-worktree-")));
		try {
			const checkout = packageCheckout(project);
			const worktree = join(project, "worktree");
			git(checkout, "worktree", "add", "--detach", worktree);
			assert.equal(notesDir(worktree), notesDir(checkout));
			const nested = packageCheckout(checkout);
			const legacy = writeLegacy(nested, "nested package notes");
			const moved = projectStore(
				project,
				"github.com/acme/tool/.pi/git/github.com/acme/tool",
			);
			assert.equal(notesDir(nested), moved);
			assert.equal(lstatSync(legacy).isSymbolicLink(), true);
			updateCheckout(nested);
			assert.equal(
				readFileSync(join(moved, "task", "state.md"), "utf8"),
				"nested package notes",
			);
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	},
);

nodeTest("a blocked migration fails without modifying checkout notes or the destination", () => {
	const project = realpathSync(mkdtempSync(join(tmpdir(), "posthorse-package-blocked-")));
	try {
		const checkout = packageCheckout(project);
		const legacy = writeLegacy(checkout, "still local");
		const moved = projectStore(project);
		mkdirSync(dirname(moved), { recursive: true });
		writeFileSync(moved, "not a directory");
		assert.throws(() => notesDir(checkout));
		assert.equal(readFileSync(join(legacy, "task", "state.md"), "utf8"), "still local");
		assert.equal(readFileSync(moved, "utf8"), "not a directory");
		assert.equal(lstatSync(legacy).isDirectory(), true);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

for (const [segment, parts] of [
	["container", []],
	["host", ["github.com"]],
	["repository", ["github.com", "acme", "tool"]],
] as const) {
	nodeTest(`project package notes survive cleanup through a symlinked ${segment}`, () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "posthorse-package-linked-")));
		try {
			const project = join(dir, "project");
			const external = join(dir, "external");
			const container = join(project, ".pi", "git");
			const link = join(container, ...parts);
			mkdirSync(external, { recursive: true });
			mkdirSync(join(link, ".."), { recursive: true });
			symlinkSync(external, link, "dir");
			const checkout = packageCheckout(project);
			const legacy = writeLegacy(checkout, "linked package notes");
			const moved = projectStore(project);
			assert.equal(notesDir(join(checkout, "src")), moved);
			assert.equal(lstatSync(legacy).isSymbolicLink(), true);
			updateCheckout(checkout);
			assert.equal(
				readFileSync(join(moved, "task", "state.md"), "utf8"),
				"linked package notes",
			);
			assert.equal(notesDir(checkout), moved);
			const worktree = join(dir, "worktree");
			git(checkout, "worktree", "add", "--detach", worktree);
			assert.equal(notesDir(worktree), join(realpathSync(checkout), ".pi", "notes"));
			// A physical path has no backlink from which to discover the project-level symlink.
			assert.equal(
				notesDir(realpathSync(checkout)),
				join(realpathSync(checkout), ".pi", "notes"),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

nodeTest(
	"project packages with separate Git metadata keep shared notes in that metadata directory",
	() => {
		const project = realpathSync(
			mkdtempSync(join(tmpdir(), "posthorse-package-separate-git-")),
		);
		try {
			const checkout = packageCheckout(project);
			const metadata = join(project, "metadata");
			git(checkout, "init", `--separate-git-dir=${metadata}`);
			const moved = join(metadata, ".pi", "notes");
			assert.equal(notesDir(checkout), moved);
			mkdirSync(moved, { recursive: true });
			writeFileSync(join(moved, "state.md"), "external metadata notes");
			updateCheckout(checkout);
			assert.equal(
				readFileSync(join(notesDir(checkout), "state.md"), "utf8"),
				"external metadata notes",
			);
		} finally {
			rmSync(project, { recursive: true, force: true });
		}
	},
);

for (const segment of ["container", "repository"]) {
	nodeTest(`global package ${segment} symlink coverage remains explicit`, () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "posthorse-global-linked-")));
		const previous = process.env.PI_CODING_AGENT_DIR;
		const agent = join(dir, "agent");
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const external = join(dir, "external");
			const checkout = join(agent, "git", "github.com", "acme", "tool");
			const link = segment === "container" ? join(agent, "git") : checkout;
			mkdirSync(external, { recursive: true });
			mkdirSync(join(link, ".."), { recursive: true });
			symlinkSync(external, link, "dir");
			mkdirSync(checkout, { recursive: true });
			git(checkout, "init", "-q");
			const expected =
				segment === "container"
					? join(agent, "notes", "github.com", "acme", "tool")
					: join(external, ".pi", "notes");
			assert.equal(notesDir(checkout), expected);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previous;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

for (const linked of [false, true]) {
	nodeTest(`global-nested notes preserve the existing store with checkout link=${linked}`, () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "posthorse-global-nested-")));
		const previousAgent = process.env.PI_CODING_AGENT_DIR;
		const agent = join(dir, "agent");
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			const outer = join(agent, "git", "github.com", "acme", "outer");
			const checkout = packageCheckout(outer);
			const previous = join(
				agent,
				"notes",
				"github.com",
				"acme",
				"outer",
				".pi",
				"git",
				"github.com",
				"acme",
				"tool",
			);
			mkdirSync(previous, { recursive: true });
			writeFileSync(join(previous, "state.md"), "existing global descendant notes");
			const local = join(checkout, ".pi", "notes");
			if (linked) {
				mkdirSync(join(checkout, ".pi"), { recursive: true });
				symlinkSync(previous, local, "dir");
			}
			assert.equal(notesDir(checkout), previous);
			assert.equal(
				readFileSync(join(notesDir(checkout), "state.md"), "utf8"),
				"existing global descendant notes",
			);
			updateCheckout(checkout);
			assert.equal(notesDir(checkout), previous);
			assert.equal(
				readFileSync(join(notesDir(checkout), "state.md"), "utf8"),
				"existing global descendant notes",
			);
			assert.equal(existsSync(join(agent, "package-notes")), false);
		} finally {
			if (previousAgent === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgent;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
