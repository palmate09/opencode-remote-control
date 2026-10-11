/**
 * Dependency licence audit.
 *
 * An MIT claim is worthless if a transitive dependency is AGPL. This walks every
 * installed package, reads its declared licence, and fails on the licences that
 * would contaminate the project.
 *
 * It is deliberately a script rather than a CI action: no third-party scanner,
 * no network call, no telemetry from our own CI. Licences are read from the
 * installed `package.json` files, because a lockfile records versions, not
 * licence terms.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Licences that would force us to change our own licence, or to relicence users. */
const FORBIDDEN = [
  "agpl-1.0",
  "agpl-3.0",
  "gpl-1.0",
  "gpl-2.0",
  "gpl-3.0",
  "sspl-1.0",
  "osl-3.0",
  "busl-1.1",
  "elastic-2.0",
  "cc-by-nc-4.0",
  "cc-by-nc-sa-4.0",
  "commons-clause",
];

/** Licences we accept without comment. */
const PERMISSIVE = [
  "mit",
  "mit-0",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "isc",
  "unlicense",
  "0bsd",
  "cc0-1.0",
  "python-2.0",
  "blueoak-1.0.0",
  "zlib",
  "postgresql",
  "wtfpl",
  "public-domain",
];

/** The workspace's own packages are ours; they do not need auditing. */
const OWN_SCOPE = "@opencode-rc/";

interface Entry {
  readonly name: string;
  readonly version: string;
  readonly licence: string;
}

function normalise(licence: string): string {
  return licence
    .replace(/^\(|\)$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function classify(licence: string): "permissive" | "forbidden" | "unknown" {
  // SPDX expressions: `MIT OR Apache-2.0` is permissive if every branch is.
  const parts = licence
    .split(/\s+(?:OR|AND|WITH)\s+/i)
    .map((p) => normalise(p))
    .filter(Boolean);
  if (parts.length === 0) return "unknown";

  const verdicts = parts.map((part) => {
    if (FORBIDDEN.some((f) => part.includes(f))) return "forbidden" as const;
    if (PERMISSIVE.some((p) => part === p || part.includes(p))) return "permissive" as const;
    if (part.endsWith("-or-later")) return "unknown" as const;
    return "unknown" as const;
  });

  if (verdicts.includes("forbidden")) return "forbidden";
  if (verdicts.every((v) => v === "permissive")) return "permissive";
  return "unknown";
}

function licenceOf(pkg: Record<string, unknown>): string {
  const licence = pkg.license ?? pkg.licence;
  if (typeof licence === "string") return licence;
  if (Array.isArray(licence))
    return licence.filter((l) => typeof l === "string").join(" OR ") || "UNKNOWN";
  return "UNKNOWN";
}

/** Walks a directory of package directories, descending into @scope folders. */
function* packageDirs(root: string): Generator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const dir = join(root, name);
    // A scope folder (`@types`) has no manifest of its own; its children do.
    if (name.startsWith("@")) {
      yield* packageDirs(dir);
      continue;
    }
    yield dir;
  }
}

/**
 * Bun's isolated linker stores the full transitive closure under
 * `node_modules/.bun/<name>@<version>/node_modules/<name>` and symlinks only the
 * direct dependencies at the top level. npm, pnpm and yarn hoist everything
 * flat. Support both, or the audit silently inspects five packages and reports
 * a clean bill of health.
 */
function* allPackageDirs(root: string): Generator<string> {
  const isolated = join(root, ".bun");
  let hasIsolated = false;
  try {
    hasIsolated = readdirSync(isolated).length > 0;
  } catch {
    hasIsolated = false;
  }

  if (!hasIsolated) {
    yield* packageDirs(root);
    return;
  }

  for (const store of readdirSync(isolated)) {
    // <name>@<version> or @scope+name@<version>
    yield* packageDirs(join(isolated, store, "node_modules"));
  }
  // Direct dependencies, which live at the top level as symlinks.
  yield* packageDirs(root);
}

const root = process.argv[2] ?? "node_modules";
const seen = new Map<string, Entry>();
const unreadable: string[] = [];

for (const dir of allPackageDirs(root)) {
  const manifest = join(dir, "package.json");
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  } catch {
    // Bundled or partially-installed packages. Not worth failing on, but worth
    // reporting so a silent gap does not become a false clean bill of health.
    unreadable.push(relative(process.cwd(), dir));
    continue;
  }
  const name = String(pkg.name ?? relative(process.cwd(), dir));
  if (name.startsWith(OWN_SCOPE)) continue;
  const version = String(pkg.version ?? "0.0.0");
  const key = `${name}@${version}`;
  if (seen.has(key)) continue;
  seen.set(key, { name, version, licence: licenceOf(pkg) });
}

const forbidden: Entry[] = [];
const unknown: Entry[] = [];
let permissive = 0;

for (const entry of seen.values()) {
  switch (classify(entry.licence)) {
    case "forbidden":
      forbidden.push(entry);
      break;
    case "permissive":
      permissive++;
      break;
    case "unknown":
      unknown.push(entry);
      break;
  }
}

const pad = Math.max(...[...seen.values()].map((e) => e.name.length), 20);

process.stdout.write(
  `deps:license — ${permissive} permissive, ${unknown.length} unknown, ${forbidden.length} forbidden ` +
    `(${seen.size} package${seen.size === 1 ? "" : "s"} inspected)\n`,
);

if (unreadable.length > 0) {
  process.stdout.write(`\n${unreadable.length} package(s) had no readable manifest:\n`);
  for (const path of unreadable.slice(0, 10)) process.stdout.write(`  …  ${path}\n`);
  if (unreadable.length > 10) process.stdout.write(`  …  and ${unreadable.length - 10} more\n`);
}

if (unknown.length > 0) {
  process.stdout.write("\nReview these by hand before release:\n");
  for (const e of unknown) process.stdout.write(`  ?  ${e.name.padEnd(pad)} ${e.licence}\n`);
}

if (forbidden.length > 0) {
  process.stderr.write("\ndeps:license FAILED — copyleft or source-available licences found:\n");
  for (const e of forbidden) process.stderr.write(`  ✗  ${e.name.padEnd(pad)} ${e.licence}\n`);
  process.stderr.write(
    "\nOur MIT claim is only meaningful if every dependency is permissive too.\n" +
      "Replace the dependency, or make the case to the maintainers first.\n",
  );
  process.exit(1);
}

process.stdout.write("\nNo copyleft or source-available licences. The MIT claim holds.\n");
