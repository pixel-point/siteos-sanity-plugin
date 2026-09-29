import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = path.resolve(PACKAGE, "../..");
const PUBLIC_REPOSITORY = "https://github.com/pixel-point/siteos-sanity-plugin";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Source Git verification failed: ${args[0]}`);
  return result.stdout.trim();
}

export function sourceFile(root, relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((part) => !part || part === "." || part === "..") ||
    /(^|\/)(?:\.env(?:\..*)?|node_modules|dist|AGENTS\.md|\.git)(\/|$)/.test(relative)
  )
    throw new Error("The publication allowlist contains an unsafe path.");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error("Publication sources cannot be symbolic links.");
  }
  if (!lstatSync(current).isFile()) throw new Error("Publication sources must be files.");
  const content = readFileSync(current);
  if (relative === "package.json") {
    const pkg = JSON.parse(content);
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ])
      if (
        Object.values(pkg[section] ?? {}).some((value) => /^(workspace:|file:|link:)/.test(value))
      )
        throw new Error("The public package must not depend on private workspace files.");
  }
  if (
    /\.[cm]?[jt]sx?$/.test(relative) &&
    /(?:from\s*|import\s*\()["'][^"']*(?:modules\/|apps\/|@siteos\/module-)/.test(
      content.toString(),
    )
  )
    throw new Error("The public plugin must not import private application modules.");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[a-zA-Z0-9]{36}|npm_[a-zA-Z0-9]{36}/.test(
      content.toString(),
    )
  )
    throw new Error("A credential-shaped value was found in the public source.");
  return content;
}

function verifyStandalone(directory, packageManager) {
  if (packageManager !== "pnpm@10.11.0")
    throw new Error("Use the reviewed standalone package manager version.");
  const commands = [
    ["pnpm", "--ignore-workspace", "install", "--ignore-scripts"],
    ["pnpm", "--ignore-workspace", "verify"],
  ];
  for (const args of commands) {
    const result = spawnSync("corepack", args, { cwd: directory, stdio: "inherit" });
    if (result.error || result.status !== 0)
      throw new Error(`Standalone verification failed: corepack ${args.join(" ")}`);
  }
  return commands.map((args) => ({ command: `corepack ${args.join(" ")}`, status: "passed" }));
}

/** Produces a new local tree only. This function never pushes, tags or publishes. */
export async function projectPublic({
  output,
  preview = false,
  packageRoot = PACKAGE,
  repositoryRoot = REPOSITORY,
  verify = verifyStandalone,
}) {
  packageRoot = realpathSync(packageRoot);
  repositoryRoot = realpathSync(repositoryRoot);
  let destination = path.resolve(output);
  if (existsSync(destination))
    throw new Error("The projection destination must not already exist.");
  let parent = path.dirname(destination);
  while (!existsSync(parent)) parent = path.dirname(parent);
  destination = path.resolve(realpathSync(parent), path.relative(parent, destination));
  const relative = path.relative(repositoryRoot, destination);
  if (!relative.startsWith(`..${path.sep}`) && !relative.startsWith(`.siteos-public${path.sep}`))
    throw new Error("Use .siteos-public or a directory outside the source repository.");
  const config = JSON.parse(readFileSync(path.join(packageRoot, "publication.json"), "utf8"));
  if (
    config.repository !== PUBLIC_REPOSITORY ||
    !Array.isArray(config.files) ||
    new Set(config.files).size !== config.files.length ||
    config.files.some((file) => ["release.json", "pnpm-lock.yaml"].includes(file))
  )
    throw new Error("Invalid publication manifest.");
  const pkg = JSON.parse(sourceFile(packageRoot, "package.json"));
  if (pkg.name !== "@siteoshq/sanity" || pkg.repository?.url !== `${PUBLIC_REPOSITORY}.git`)
    throw new Error("The public package identity does not match its repository.");
  const revision = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const dirty = git(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]) !== "";
  if (!preview) {
    if (dirty) throw new Error("A release requires a clean canonical source commit.");
    if (pkg.private !== false) throw new Error("The plugin is not enabled for public release yet.");
    if (revision !== git(repositoryRoot, ["rev-parse", "origin/main"]))
      throw new Error("Release only the verified canonical origin/main commit.");
    if (
      ![
        "https://github.com/pixel-point/siteos-platform.git",
        "git@github.com:pixel-point/siteos-platform.git",
      ].includes(git(repositoryRoot, ["remote", "get-url", "origin"]))
    )
      throw new Error("Release source must be the canonical SiteOS repository.");
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version))
      throw new Error("A public release requires a stable semantic version.");
  }
  const entries = config.files
    .slice()
    .sort()
    .map((file) => ({ file, content: sourceFile(packageRoot, file) }));
  if (
    !["package.json", "README.md", "LICENSE", "src/index.tsx"].every((file) =>
      config.files.includes(file),
    )
  )
    throw new Error("Required package files are missing from the publication allowlist.");
  const files = Object.fromEntries(entries.map(({ file, content }) => [file, hash(content)]));
  const release = {
    version: pkg.version,
    mode: preview ? "preview" : "release",
    publishable: !preview,
    repository: PUBLIC_REPOSITORY,
    source: {
      repository: "https://github.com/pixel-point/siteos-platform",
      path: "packages/sanity-plugin",
      revision,
      dirty,
    },
    files,
    digest: hash(JSON.stringify(files)),
    compatibility: { engines: pkg.engines, peerDependencies: pkg.peerDependencies },
    verification: [],
  };
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(destination), ".sanity-stage-"));
  try {
    for (const { file, content } of entries) {
      await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
      await writeFile(path.join(staging, file), content);
    }
    if (!preview) {
      release.verification = await verify(staging, pkg.packageManager);
      if (
        !Array.isArray(release.verification) ||
        release.verification.length === 0 ||
        release.verification.some((check) => check.status !== "passed")
      )
        throw new Error("Standalone verification did not pass.");
      // Generated only outside the monorepo; the projection owns this release lockfile.
      files["pnpm-lock.yaml"] = hash(sourceFile(staging, "pnpm-lock.yaml"));
      for (const { file, content } of entries)
        if (!sourceFile(staging, file).equals(content))
          throw new Error(`Verification changed a publication source: ${file}`);
      release.digest = hash(JSON.stringify(files));
      if (
        git(repositoryRoot, ["rev-parse", "HEAD"]) !== revision ||
        git(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]) !== ""
      )
        throw new Error("Canonical source changed during standalone verification.");
    }
    await writeFile(path.join(staging, "release.json"), JSON.stringify(release, null, 2) + "\n");
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    args.length !== 3 ||
    !["--preview", "--release"].includes(args[0]) ||
    args[1] !== "--out" ||
    !args[2]
  ) {
    console.error("Usage: pnpm project:public <--preview|--release> --out <new-directory>");
    process.exitCode = 1;
  } else {
    try {
      const release = await projectPublic({ preview: args[0] === "--preview", output: args[2] });
      console.log(
        JSON.stringify(
          {
            output: path.resolve(args[2]),
            digest: release.digest,
            publishable: release.publishable,
          },
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
