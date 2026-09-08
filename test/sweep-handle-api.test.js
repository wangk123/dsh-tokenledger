/**
 * Sweep tests against the NEW handle-based sessionPersistence seam.
 *
 * These cover the compatibility fix in plugin.js:
 *  - list()/open(id, "read")/read(offset)/close() replaced listSnapshots()/readFrom()
 *  - revision moved ⇒ fold is re-read from 0, because the v1→v2 session
 *    migration renumbers seqs and a checkpoint's consumedSeq can overshoot
 *  - unchanged revision ⇒ skip without a read
 *  - an old-style persistence (readFrom) still works
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sweep } from "../src/plugin.js";
import { LedgerStore } from "../src/store.js";

const T0 = 1788855293000; // 2026-09-08 local day

/** One v2-shaped assistant/message carrying a usage sample. */
function msg(seq, provider, model, usage, time = T0, turn = 1, step = 1) {
	return {
		type: "assistant/message",
		seq,
		time,
		data: { turn, step, usage, message: { source: { provider, model } } }
	};
}

/** New-API-shaped persistence mock. sessions: Map(id -> { events, revision }). */
function persistenceOf(sessions) {
	return {
		async list() {
			return [...sessions.entries()].map(([id, s]) => ({ header: { id }, revision: s.revision }));
		},
		async open(id) {
			const s = sessions.get(id);
			if (s === undefined) throw new Error(`not found: ${id}`);
			return {
				async read(offset = 0) {
					return { events: s.events.slice(offset) };
				},
				async close() {}
			};
		}
	};
}

function usage(over = {}) {
	return { inputTokens: 100, outputTokens: 50, cacheReadTokens: 2000, cacheWriteTokens: 0, reasoningTokens: 10, ...over };
}

test("folds usage through the handle-based API", async () => {
	const sessions = new Map([
		["session-a", {
			revision: "rev-1",
			events: [
				msg(0, "deepseek-official", "deepseek-v4-pro", usage(), T0, 1, 1),
				msg(1, "deepseek-official", "deepseek-v4-flash", usage({ cacheReadTokens: 5000 }), T0, 1, 2)
			]
		}]
	]);
	const store = LedgerStore.open(":memory:");
	const stats = await sweep(persistenceOf(sessions), store, {});
	assert.equal(stats.updated, 1);
	assert.equal(stats.failed, 0);
	const total = store.totals({});
	assert.equal(total.inputTokens, 200);
	assert.equal(total.outputTokens, 100);
	assert.equal(total.cacheReadTokens, 7000);
	assert.equal(total.requests, 2);
	assert.equal(total.tokens, 7300);
	const cp = store.checkpointFor("session-a");
	assert.equal(cp.logRevision, "rev-1");
	assert.equal(cp.consumedSeq, 1);
	store.close();
});

test("unchanged revision is skipped without a read", async () => {
	const sessions = new Map([
		["session-a", { revision: "rev-1", events: [msg(0, "deepseek-official", "deepseek-v4-pro", usage())] }]
	]);
	const store = LedgerStore.open(":memory:");
	let reads = 0;
	const persistence = {
		async list() {
			return [...sessions.entries()].map(([id, s]) => ({ header: { id }, revision: s.revision }));
		},
		async open(id) {
			reads++;
			const s = sessions.get(id);
			return { async read(offset = 0) { return { events: s.events.slice(offset) }; }, async close() {} };
		}
	};
	await sweep(persistence, store, {});
	const stats = await sweep(persistence, store, {});
	assert.equal(stats.skipped, 1);
	assert.equal(stats.updated, 0);
	// Exactly ONE read happened: the first sweep, not the skipped second one.
	assert.equal(reads, 1);
	store.close();
});

test("renumbered v2 seqs refold from 0 without double counting", async () => {
	// First fold in old seq space (v1 numbering, large seqs).
	const logV1 = [msg(7000, "deepseek-official", "deepseek-v4-pro", usage())];
	const sessions = new Map([["session-a", { revision: "rev-1", events: logV1 }]]);
	const store = LedgerStore.open(":memory:");
	await sweep(persistenceOf(sessions), store, {});
	assert.equal(store.totals({}).requests, 1);

	// The v1→v2 migration rewrites the log: seqs renumbered from 0, and the
	// events carry the same token figures. Revision moved.
	sessions.set("session-a", {
		revision: "rev-2",
		events: [
			msg(0, "deepseek-official", "deepseek-v4-pro", usage()),
			// Same turn, NEW step: a genuinely new sample in the renumbered log.
			msg(1, "deepseek-official", "deepseek-v4-pro", usage({ inputTokens: 300, outputTokens: 25 }), T0, 1, 2)
		]
	});
	const stats = await sweep(persistenceOf(sessions), store, {});
	assert.equal(stats.updated, 1);
	const total = store.totals({});
	// Old rows were REPLACED wholesale, not added to: input 100+300, not 100*2+300.
	assert.equal(total.inputTokens, 400);
	assert.equal(total.outputTokens, 75);
	assert.equal(total.cacheReadTokens, 4000);
	assert.equal(total.requests, 2);
	const cp = store.checkpointFor("session-a");
	assert.equal(cp.logRevision, "rev-2");
	assert.equal(cp.consumedSeq, 1);
	store.close();
});

test("old readFrom persistence still works (backward compatibility)", async () => {
	let readCalls = 0;
	const persistence = {
		async listSnapshots() {
			return [{ header: { id: "session-a" }, revision: "rev-1" }];
		},
		async readFrom() {
			readCalls++;
			return { events: [msg(0, "deepseek-official", "deepseek-v4-pro", usage())] };
		}
	};
	const store = LedgerStore.open(":memory:");
	const stats = await sweep(persistence, store, {});
	assert.equal(stats.updated, 1);
	assert.equal(readCalls, 1);
	assert.equal(store.totals({}).requests, 1);
	store.close();
});
