#!/usr/bin/env node
// Proposes upstream's new offsets files as a pull request, and records which upstream
// commit they came from.
//
// This mirror is not a copy of upstream any more. The generator was rewritten here, and
// the files this repository produces are newer than upstream's — so a sync that copied
// upstream over the top would walk the mirror backwards. The rule is therefore narrow and
// deliberate:
//
//   * a file upstream has and this mirror does not is copied in;
//   * a file both have, that differs, is *reported and left alone*;
//   * lookup.json is never copied, because it is the one file that is authored here.
//
// Everything it does lands in a pull request. Nothing is pushed to main. Without a
// signature on the bundle, that review is the control that replaces the key, so it is not
// an optional nicety — see docs/rust-port/06-security.md §6.5 in the client repository.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const UPSTREAM = process.env.UPSTREAM_REPO ?? 'OhMyGuus/BetterCrewlink-Offsets';
const UPSTREAM_BRANCH = process.env.UPSTREAM_BRANCH ?? 'main';
const STATE_FILE = '.upstream-sync.json';
const REPORT_FILE = process.env.SYNC_REPORT ?? 'sync-report.md';

const headers = {
	'User-Agent': 'anothercrewlink-offsets-sync',
	Accept: 'application/vnd.github+json',
	...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function api(path) {
	const response = await fetch(`https://api.github.com/${path}`, { headers, signal: AbortSignal.timeout(30000) });
	if (!response.ok) throw new Error(`GET ${path} responded with HTTP ${response.status}`);
	return response.json();
}

const head = await api(`repos/${UPSTREAM}/commits/${UPSTREAM_BRANCH}`);
const upstreamCommit = head.sha;

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
// Not process.exit(): tearing the process down with the fetch agent still open makes
// libuv print an assertion after the work is finished, which reads like a crash in a CI
// log. An empty report is the signal to the workflow that there is nothing to open.
const upToDate = state.upstream_commit === upstreamCommit;
if (upToDate) {
	console.log(`already at upstream ${upstreamCommit.slice(0, 12)}; nothing to do`);
	writeFileSync(REPORT_FILE, '', 'utf8');
}

if (!upToDate) {
	const tree = await api(`repos/${UPSTREAM}/git/trees/${upstreamCommit}?recursive=1`);
	const upstreamFiles = tree.tree.filter(
		(entry) => entry.type === 'blob' && entry.path.startsWith('offsets/') && entry.path.endsWith('.json')
	);
	
	const added = [];
	const differing = [];
	
	/**
	 * Which files upstream itself touched since the last sync.
	 *
	 * Without this the report lists every file that differs, and on this mirror that is very
	 * nearly all of them: the generator was rewritten here, so our copy of a given version
	 * legitimately differs from upstream's. A list of eighty "differs" every run is a list
	 * nobody reads, which would quietly undo the review this whole workflow exists to enable.
	 * On the first run there is no baseline, so everything is reported once and never again.
	 */
	let changedUpstream = null;
	if (state.upstream_commit) {
		try {
			const comparison = await api(`repos/${UPSTREAM}/compare/${state.upstream_commit}...${upstreamCommit}`);
			changedUpstream = new Set(comparison.files?.map((file) => file.filename) ?? []);
		} catch (error) {
			// A force-push or a deleted commit upstream makes the range unresolvable. Falling
			// back to reporting every difference is noisy but never silent.
			console.warn(`could not compare ${state.upstream_commit}..${upstreamCommit}: ${error.message}`);
		}
	}
	
	for (const entry of upstreamFiles) {
		const local = entry.path;
		if (existsSync(local)) {
			// Both have it. Comparing the blob hash is enough to know whether to look, and it
			// costs one field rather than a download per file.
			if (changedUpstream && !changedUpstream.has(local)) {
				// Both have it and upstream has not touched it since the last sync, so whatever
				// difference exists is ours and was reported when it first appeared.
				continue;
			}
			const localBlob = gitBlobSha(readFileSync(local));
			if (localBlob !== entry.sha) differing.push(local);
			continue;
		}
		const blob = await api(`repos/${UPSTREAM}/git/blobs/${entry.sha}`);
		const content = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8');
		// Parsed before it is written: a file that is not JSON is not an offsets file, and
		// the client's validator should never be the first thing to find that out.
		JSON.parse(content.toString('utf8'));
		mkdirSync(dirname(local), { recursive: true });
		writeFileSync(local, content);
		added.push(local);
	}
	
	/** The hash git would give this content, so blobs can be compared without downloading them. */
	function gitBlobSha(buffer) {
		return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
	}
	
	if (added.length > 0) {
		// The bundle version is what lets a client refuse a replayed older bundle, so it moves
		// whenever the contents do.
		const lookupPath = 'lookup.json';
		const lookup = JSON.parse(readFileSync(lookupPath, 'utf8'));
		lookup.bundle_version = (lookup.bundle_version ?? 0) + 1;
		lookup.upstream_commit = upstreamCommit;
		writeFileSync(lookupPath, `${JSON.stringify(lookup, null, 2)}\n`, 'utf8');
	}
	
	writeFileSync(
		STATE_FILE,
		`${JSON.stringify({ upstream_repo: UPSTREAM, upstream_branch: UPSTREAM_BRANCH, upstream_commit: upstreamCommit }, null, 2)}\n`,
		'utf8'
	);
	
	const previous = state.upstream_commit;
	const compare = previous
		? `https://github.com/${UPSTREAM}/compare/${previous}...${upstreamCommit}`
		: `https://github.com/${UPSTREAM}/commit/${upstreamCommit}`;
	
	const report = [
		`Upstream \`${UPSTREAM}\` is at \`${upstreamCommit}\`.`,
		'',
		previous ? `Previously synced from \`${previous}\`. [Upstream diff](${compare})` : `First sync. [Commit](${compare})`,
		'',
		added.length > 0 ? `### Added (${added.length})\n\n${added.map((f) => `- \`${f}\``).join('\n')}` : '### Added\n\nNothing.',
		'',
		differing.length > 0
			? `### Changed upstream, **left alone** (${differing.length})\n\n` +
				`Upstream edited these and this mirror has its own version. The generator was rewritten here, so a\n` +
				`difference is expected and is never overwritten automatically. Look at them and port anything that\n` +
				`matters by hand:\n\n${differing.map((f) => `- \`${f}\``).join('\n')}`
			: '',
		'',
		'---',
		'',
		'Review the diff before merging. Without a signature on the bundle, this review is the control that replaces',
		'the key: whatever is on `main` here is what every client reads.',
	]
		.filter((line) => line !== '')
		.join('\n');
	
	writeFileSync(REPORT_FILE, `${report}\n`, 'utf8');
	console.log(`added ${added.length}, ${differing.length} differ, upstream ${upstreamCommit.slice(0, 12)}`);
}
