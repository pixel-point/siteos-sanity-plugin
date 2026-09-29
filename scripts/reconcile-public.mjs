import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFile } from "./project-public.mjs";

const repository = "https://github.com/pixel-point/siteos-sanity-plugin";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function git(root, args, optional = false) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0 && !optional) throw new Error(`Public Git check failed: ${args[0]}`);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function readProjection(root) {
  const releaseBytes = sourceFile(root, "release.json");
  const release = JSON.parse(releaseBytes);
  const manifest = JSON.parse(sourceFile(root, "publication.json"));
  if (
    release.mode !== "release" ||
    release.publishable !== true ||
    release.source?.dirty !== false ||
    release.repository !== repository ||
    manifest.repository !== repository ||
    release.source?.repository !== "https://github.com/pixel-point/siteos-platform" ||
    release.source?.path !== "packages/sanity-plugin" ||
    !/^[a-f0-9]{40}$/.test(release.source?.revision ?? "") ||
    !Array.isArray(release.verification) ||
    release.verification.length === 0 ||
    release.verification.some((check) => check.status !== "passed")
  )
    throw new Error("Only a verified canonical release projection can be reconciled.");
  const expected = [...manifest.files, "pnpm-lock.yaml"].sort();
  if (
    new Set(expected).size !== expected.length ||
    JSON.stringify(Object.keys(release.files).sort()) !== JSON.stringify(expected) ||
    release.digest !== hash(JSON.stringify(release.files))
  )
    throw new Error("The release file inventory or digest does not match.");
  const files = new Map();
  for (const name of expected) {
    const bytes = sourceFile(root, name);
    if (hash(bytes) !== release.files[name]) throw new Error(`Release file changed: ${name}`);
    files.set(name, bytes);
  }
  const pkg = JSON.parse(files.get("package.json"));
  if (
    pkg.name !== "@siteoshq/sanity" ||
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    pkg.version !== release.version ||
    pkg.private !== false ||
    pkg.repository?.url !== `${repository}.git`
  )
    throw new Error("Release package identity does not match.");
  files.set("release.json", releaseBytes);
  return { release, files };
}

function safeTarget(root, name) {
  let current = root;
  for (const part of name.split("/")) {
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("Public target cannot contain symbolic links.");
  }
  return current;
}

/** Reconciles local, explicitly owned files only. Commit, push, tags and npm are separate. */
export async function reconcilePublic({ projection, target, write = false }) {
  projection = realpathSync(projection);
  target = realpathSync(target);
  if (
    projection === target ||
    projection.startsWith(`${target}${path.sep}`) ||
    target.startsWith(`${projection}${path.sep}`)
  )
    throw new Error("Projection and public checkout must be independent directories.");
  const { release, files } = readProjection(projection);
  if (
    realpathSync(git(target, ["rev-parse", "--show-toplevel"])) !== target ||
    ![`${repository}.git`, "git@github.com:pixel-point/siteos-sanity-plugin.git"].includes(
      git(target, ["remote", "get-url", "origin"]),
    ) ||
    git(target, ["branch", "--show-current"]) !== "main"
  )
    throw new Error("Use the exact public repository on its main branch.");
  if (git(target, ["status", "--porcelain", "--untracked-files=all"]) !== "")
    throw new Error("Public checkout must be clean.");
  const head = git(target, ["rev-parse", "--verify", "HEAD"], true);
  const remote = git(target, ["rev-parse", "--verify", "origin/main"], true);
  if (head !== remote) throw new Error("Public checkout must match its fetched origin/main.");
  const tracked = (git(target, ["ls-files", "-z"]) || "").split("\0").filter(Boolean);
  const previous = existsSync(path.join(target, "release.json")) ? readProjection(target) : null;
  if (
    previous &&
    previous.release.version === release.version &&
    !previous.files.get("release.json").equals(files.get("release.json"))
  )
    throw new Error("Do not rewrite an existing release version.");
  if (tracked.some((name) => !previous?.files.has(name)))
    throw new Error(
      "Public checkout contains files outside the previous release; review them first.",
    );
  const old = new Map(tracked.map((name) => [name, sourceFile(target, name)]));
  for (const name of files.keys()) safeTarget(target, name);
  const added = [...files.keys()].filter((name) => !old.has(name));
  if (added.some((name) => existsSync(safeTarget(target, name))))
    throw new Error("An untracked or ignored target file would be overwritten.");
  const changed = [...files.keys()].filter(
    (name) => old.has(name) && !files.get(name).equals(old.get(name)),
  );
  const removed = [...old.keys()].filter((name) => !files.has(name));
  const plan = {
    version: release.version,
    sourceRevision: release.source.revision,
    added,
    changed,
    removed,
  };
  if (!write) return plan;
  try {
    for (const name of [...added, ...changed]) {
      const destination = safeTarget(target, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, files.get(name));
    }
    for (const name of removed) await rm(safeTarget(target, name));
    readProjection(target);
  } catch (error) {
    for (const name of added) {
      const destination = safeTarget(target, name);
      if (existsSync(destination)) await rm(destination, { force: true });
    }
    for (const [name, bytes] of old) {
      const destination = safeTarget(target, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    throw error;
  }
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args[0] === "--write";
  if (write) args.shift();
  if (args.length !== 4 || args[0] !== "--projection" || args[2] !== "--target") {
    console.error(
      "Usage: pnpm reconcile:public [--write] --projection <directory> --target <public-checkout>",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(
          await reconcilePublic({ projection: args[1], target: args[3], write }),
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
