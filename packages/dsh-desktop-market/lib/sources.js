/**
 * Registry-source knowledge: how a curated registry entry's URL maps to an
 * installable pnpm target. Pure string logic, no I/O.
 */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_DIRECT_SOURCE_LENGTH = 2_048;
/**
 * Parse every GitHub dependency form Desktop persists or accepts from pnpm.
 *
 * The immutable `github.com/<repo>/archive/<sha>.tar.gz` form is deliberate:
 * unlike a `github:` / codeload Git dependency, pnpm treats it as an ordinary
 * integrity-pinned tarball and therefore does not replay the repository's
 * `prepare` script during every later profile mutation.
 */
export function parseGitHubDependencySpec(spec) {
    const archive = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/archive\/([0-9a-f]{40,64})\.tar\.gz$/i.exec(spec);
    if (archive !== null && REPO_RE.test(archive[1])) {
        return { repo: archive[1], commit: archive[2].toLowerCase(), subpath: null, kind: 'archive' };
    }
    const shorthand = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.*))?$/i.exec(spec);
    if (shorthand !== null && REPO_RE.test(shorthand[1])) {
        const hash = shorthand[2] ?? '';
        const subpath = hash.toLowerCase().startsWith('path:/') ? hash.slice('path:/'.length) : null;
        if (subpath !== null && !validSubpath(subpath))
            return null;
        return { repo: shorthand[1], commit: null, subpath, kind: 'git' };
    }
    const remote = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.*))?$/i.exec(spec);
    if (remote === null)
        return null;
    const repo = `${remote[1]}/${remote[2]}`;
    if (!REPO_RE.test(repo))
        return null;
    const hash = remote[3] ?? '';
    const subpath = hash.toLowerCase().startsWith('path:/') ? hash.slice('path:/'.length) : null;
    if (subpath !== null && !validSubpath(subpath))
        return null;
    return { repo, commit: null, subpath, kind: 'git' };
}
/** Immutable, integrity-lockable GitHub source for a repository commit. */
export function githubArchiveSpec(repo, commit) {
    if (!REPO_RE.test(repo) || !/^[0-9a-f]{40,64}$/i.test(commit))
        return null;
    return `https://github.com/${repo}/archive/${commit.toLowerCase()}.tar.gz`;
}
function validSubpath(subpath) {
    if (!/^[A-Za-z0-9_./-]+$/.test(subpath))
        return false;
    return !subpath.split('/').some(seg => seg === '' || seg === '.' || seg === '..');
}
/** Registry tarball names must be plain npm package names, nothing fancier. */
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
function githubDirectSource(source) {
    let repo;
    let subpath = null;
    let url;
    const shorthand = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#path:\/(.+))?$/i.exec(source);
    if (shorthand !== null) {
        const owner = shorthand[1];
        const repoName = shorthand[2].replace(/\.git$/i, '');
        repo = `${owner}/${repoName}`;
        subpath = shorthand[3] ?? null;
        url = `https://github.com/${repo}`;
    }
    else {
        let parsed;
        try {
            parsed = new URL(source);
        }
        catch {
            return null;
        }
        if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com')
            return null;
        if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '')
            return null;
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length < 2)
            return null;
        const owner = parts[0];
        const repoName = parts[1].replace(/\.git$/i, '');
        repo = `${owner}/${repoName}`;
        if (parts.length > 2) {
            // A repository subdirectory is the only supported GitHub suffix. The
            // branch name is deliberately not copied into the pnpm target: DSH's
            // established collection format is github:o/r#path:/package.
            if (parts[2] !== 'tree' || parts.length < 5)
                return null;
            subpath = parts.slice(4).join('/');
        }
        url = `https://github.com/${repo}${subpath === null ? '' : `/tree/${parts[3]}/${subpath}`}`;
    }
    if (!REPO_RE.test(repo) || (subpath !== null && !validSubpath(subpath)))
        return null;
    const [owner, repoName] = repo.split('/');
    return {
        source,
        target: subpath === null ? `github:${repo}` : `github:${repo}#path:/${subpath}`,
        name: subpath === null ? repoName : subpath.split('/').at(-1),
        owner,
        url,
        kind: 'github',
    };
}
/**
 * Resolve the deliberately bounded sources accepted by Desktop's direct
 * install flow. This is a trust boundary, not a general pnpm-spec parser:
 * local paths, arbitrary git hosts, scripts, tarballs and package aliases
 * are rejected. The UI may receive a broader token, but only this function
 * can turn it into a profile mutation target.
 */
export function directInstallSourceFor(input) {
    if (typeof input !== 'string')
        return null;
    const source = input.trim();
    if (source.length === 0 || source.length > MAX_DIRECT_SOURCE_LENGTH)
        return null;
    if (/\s|["\u0000-\u001f\u007f]/u.test(source))
        return null;
    const github = githubDirectSource(source);
    if (github !== null)
        return github;
    if (!NPM_NAME_RE.test(source))
        return null;
    const scoped = /^@([^/]+)\/(.+)$/.exec(source);
    return {
        source,
        target: source,
        name: source,
        owner: scoped?.[1] ?? 'npm',
        url: `https://www.npmjs.com/package/${encodeURIComponent(source)}`,
        kind: 'npm',
    };
}
/**
 * Parse a registry source url: a github repo, optionally with a
 * `/tree/<branch>/<subpath>` suffix (how the curated list links monorepo
 * subpackages, e.g. dsh-plugins#theme-gallery).
 */
export function parseSourceUrl(url) {
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(url);
    if (m === null || !REPO_RE.test(m[1]))
        return null;
    const subpath = m[2] ?? null;
    if (subpath !== null) {
        // No empty/dot segments: `..` would escape the repo in the #path: selector.
        if (!validSubpath(subpath))
            return null;
    }
    return { repo: m[1], subpath };
}
function repoFromParts(owner, name) {
    const repoName = name.replace(/\.git$/i, '');
    const repo = `${owner}/${repoName}`;
    return REPO_RE.test(repo) ? { repo } : null;
}
/** Parse repository forms accepted by package.json.repository. */
export function parseGitHubRepository(value) {
    const input = value.trim();
    const shortcut = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#.*)?$/i.exec(input);
    if (shortcut !== null)
        return repoFromParts(shortcut[1], shortcut[2]);
    const remote = input.replace(/^git\+/i, '');
    const web = /^(?:https?|git|ssh):\/\/(?:git@)?github\.com[/:]([^/]+)\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(remote);
    const scp = /^git@github\.com:([^/]+)\/([^/?#]+)$/i.exec(remote);
    const match = web ?? scp;
    return match === null ? null : repoFromParts(match[1], match[2]);
}
/**
 * Parse a Git remote. Unlike package metadata, a local origin may contain a
 * proxy prefix (for example `https://proxy/https://github.com/o/r.git`). In
 * that case only the last GitHub occurrence is considered.
 */
export function parseGitHubRemote(url) {
    const exact = parseGitHubRepository(url);
    if (exact !== null)
        return exact;
    const matches = [...url.matchAll(/github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=$|[/?#])/ig)];
    const match = matches.at(-1);
    return match === undefined ? null : repoFromParts(match[1], match[2]);
}
/** Normalized repo identity shared by server discovery and client matching. */
export function githubRepoIdentity(url, directory) {
    const source = parseGitHubRepository(url);
    if (source === null)
        return null;
    const repo = source.repo.toLowerCase();
    if (directory === undefined || directory === null || directory.trim() === '')
        return repo;
    const subpath = directory.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    return validSubpath(subpath) ? `${repo}#path:/${subpath.toLowerCase()}` : null;
}
/**
 * Repository evidence used for installed-source matching. A monorepo package
 * contributes both its collection root and exact subpath, mirroring the
 * identities extracted from `github:owner/repo#path:/package` specs.
 */
export function githubRepoIdentities(url, directory) {
    const identity = githubRepoIdentity(url, directory);
    if (identity === null)
        return [];
    const pathAt = identity.indexOf('#path:/');
    return pathAt === -1 ? [identity] : [identity.slice(0, pathAt), identity];
}
/** Weak identity hints from a local Git origin; never used to reject a unique match. */
export function githubRemoteIdentities(url, directory) {
    const source = parseGitHubRemote(url);
    if (source === null)
        return [];
    return githubRepoIdentities(`https://github.com/${source.repo}`, directory);
}
/** GitHub `owner/repo` for a registry URL, or null when it is not a GitHub repo URL. */
export function repoOf(url) {
    return parseSourceUrl(url)?.repo ?? null;
}
/**
 * The allowBuilds key that actually authorizes a git-hosted dependency's
 * build scripts. Verified against pnpm 11.21 (#68 by @yzr278892): for a
 * `github:owner/repo` install, a bare `name: true` entry does NOT match —
 * pnpm's own hint names a commit-pinned codeload URL that changes on every
 * push; the stable form that matches is `name@git+https://github.com/owner/repo.git`.
 * @param name - installed package name.
 * @param spec - the dependency spec from package.json, or the install target.
 * @returns the stable key, or null when the spec is not github-hosted.
 */
export function gitAllowBuildsKey(name, spec) {
    const source = parseGitHubDependencySpec(spec);
    if (source === null || source.kind !== 'git')
        return null;
    return `${name}@git+https://github.com/${source.repo}.git`;
}
/**
 * The pnpm install target for a registry entry. Registry tarballs beat
 * full-repo GitHub downloads: smaller, prebuilt, and CDN/mirror served. The
 * npm name comes from our curated registry, which only maps repo-verified
 * packages (name-squatting protection).
 * @returns the target spec, or null when the source url is unsupported.
 */
export function installTargetFor(entry) {
    const source = parseSourceUrl(entry.url);
    if (source === null)
        return null;
    if (typeof entry.npm === 'string' && NPM_NAME_RE.test(entry.npm))
        return entry.npm;
    return source.subpath !== null
        ? `github:${source.repo}#path:/${source.subpath}`
        : `github:${source.repo}`;
}
/**
 * The name an entry is ALREADY installed under, or null — the server-side
 * duplicate guard (#27): the same plugin listed under an alias entry must
 * never install twice (two loader entries with one id brick the next boot).
 *
 * Identity is subpath-aware so monorepo siblings stay independent: an entry
 * with a /tree/ subpath identifies as repo#path:/sub (never the bare repo),
 * while an installed dependency contributes its bare repo AND its #path:
 * form — so a collection root still matches the pieces it was retargeted
 * into, but two different subpackages of one repo never cross-match.
 */
export function findInstalledAlias(entry, installed) {
    const source = parseSourceUrl(entry.url);
    const entryRepoId = source === null
        ? null
        : source.subpath === null
            ? source.repo.toLowerCase()
            : `${source.repo.toLowerCase()}#path:/${source.subpath.toLowerCase()}`;
    const ids = new Set([entry.name.toLowerCase()]);
    if (typeof entry.npm === 'string' && entry.npm !== '')
        ids.add(entry.npm.toLowerCase());
    if (entryRepoId !== null)
        ids.add(entryRepoId);
    for (const [name, spec] of Object.entries(installed)) {
        const dep = new Set([name.toLowerCase()]);
        const scoped = /^@([^/]+)\/(.+)$/.exec(name);
        if (scoped !== null)
            dep.add(`${scoped[1]}/${scoped[2]}`.toLowerCase());
        const sourceSpec = parseGitHubDependencySpec(spec);
        if (sourceSpec !== null) {
            dep.add(sourceSpec.repo.toLowerCase());
            if (sourceSpec.subpath !== null)
                dep.add(`${sourceSpec.repo.toLowerCase()}#path:/${sourceSpec.subpath.toLowerCase()}`);
            // Repo evidence on both sides is decisive (#66): the curated registry
            // lists distinct plugins under one name (both dsh-usage-stats, four
            // dsh-memory…), so a github-installed dependency is the entry's plugin
            // only if the REPOS agree — a bare name coincidence must not count.
            if (entryRepoId !== null) {
                if (dep.has(entryRepoId))
                    return name;
                continue;
            }
        }
        for (const id of dep)
            if (ids.has(id))
                return name;
    }
    return null;
}
