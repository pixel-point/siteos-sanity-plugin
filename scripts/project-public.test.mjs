import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { projectPublic } from "./project-public.mjs";
import { reconcilePublic } from "./reconcile-public.mjs";

async function fixture(t) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "sanity-projection-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const packageRoot = path.join(repositoryRoot, "packages/sanity-plugin");
  await mkdir(path.join(packageRoot, "src"), { recursive: true });
  const files = ["package.json", "README.md", "LICENSE", "publication.json", "src/index.tsx"];
  for (const file of files) await writeFile(path.join(packageRoot, file), "public content\n");
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@siteoshq/sanity",
      version: "0.1.0-alpha.0",
      private: true,
      repository: { url: "https://github.com/pixel-point/siteos-sanity-plugin.git" },
    }),
  );
  await writeFile(
    path.join(packageRoot, "publication.json"),
    JSON.stringify({ repository: "https://github.com/pixel-point/siteos-sanity-plugin", files }),
  );
  await writeFile(path.join(packageRoot, "AGENTS.md"), "private instructions");
  await writeFile(path.join(repositoryRoot, ".gitignore"), ".siteos-public/\n");
  const git = (...args) => {
    const r = spawnSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
  return {
    packageRoot,
    repositoryRoot,
    preview: true,
    output: path.join(repositoryRoot, ".siteos-public/preview"),
    git,
  };
}
test("exports only allowed source with deterministic hashes and explicit preview provenance", async (t) => {
  const input = await fixture(t);
  const release = await projectPublic(input);
  assert.equal(release.publishable, false);
  assert.equal(release.source.dirty, false);
  assert.equal(release.files["AGENTS.md"], undefined);
  assert.equal(
    JSON.parse(await readFile(path.join(input.output, "release.json"), "utf8")).digest,
    release.digest,
  );
  const second = await projectPublic({
    ...input,
    output: path.join(input.repositoryRoot, ".siteos-public/another"),
  });
  assert.equal(second.digest, release.digest);
});

async function releaseFixture(t) {
  const input = await fixture(t);
  const packagePath = path.join(input.packageRoot, "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  await writeFile(packagePath, JSON.stringify({ ...pkg, version: "0.1.0", private: false }));
  input.git("add", ".");
  input.git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "release",
  );
  input.git("remote", "add", "origin", "https://github.com/pixel-point/siteos-platform.git");
  input.git("update-ref", "refs/remotes/origin/main", "HEAD");
  return {
    ...input,
    preview: false,
    verify: async (directory) => {
      await writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      return [{ command: "fixture verification", status: "passed" }];
    },
  };
}

test("release projection requires clean canonical main and records standalone evidence and lockfile", async (t) => {
  const input = await releaseFixture(t);
  input.git("update-ref", "refs/remotes/origin/main", "HEAD~1");
  await assert.rejects(projectPublic(input), /canonical origin\/main/);
  input.git("update-ref", "refs/remotes/origin/main", "HEAD");
  await writeFile(path.join(input.repositoryRoot, "dirty.txt"), "unreviewed");
  await assert.rejects(projectPublic(input), /clean canonical/);
  await rm(path.join(input.repositoryRoot, "dirty.txt"));
  const release = await projectPublic(input);
  assert.equal(release.publishable, true);
  assert.equal(release.mode, "release");
  assert.ok(release.files["pnpm-lock.yaml"]);
  assert.equal(release.verification[0].status, "passed");
});

test("failed verification never creates a release output", async (t) => {
  const input = await releaseFixture(t);
  await assert.rejects(
    projectPublic({
      ...input,
      verify: async () => {
        throw new Error("verification failed");
      },
    }),
    /verification failed/,
  );
  await assert.rejects(readFile(path.join(input.output, "release.json")), /ENOENT/);
});

test("public reconciliation checks provenance and target, plans without writes and preserves dirty work", async (t) => {
  const input = await releaseFixture(t);
  await projectPublic(input);
  const target = path.join(input.repositoryRoot, ".siteos-public/public");
  await mkdir(target);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", target, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/pixel-point/wrong.git");
  await assert.rejects(
    reconcilePublic({ projection: input.output, target }),
    /exact public repository/,
  );
  git("remote", "set-url", "origin", "https://github.com/pixel-point/siteos-sanity-plugin.git");
  const plan = await reconcilePublic({ projection: input.output, target });
  assert.ok(plan.added.includes("release.json"));
  await assert.rejects(readFile(path.join(target, "README.md")), /ENOENT/);
  const original = await readFile(path.join(input.output, "README.md"));
  await writeFile(path.join(input.output, "README.md"), "tampered");
  await assert.rejects(
    reconcilePublic({ projection: input.output, target, write: true }),
    /Release file changed/,
  );
  await writeFile(path.join(input.output, "README.md"), original);
  await writeFile(path.join(target, "local.txt"), "keep this");
  await assert.rejects(reconcilePublic({ projection: input.output, target, write: true }), /clean/);
  await rm(path.join(target, "local.txt"));
  await writeFile(path.join(target, ".git/info/exclude"), "src\n");
  await writeFile(path.join(target, "src"), "preserve ignored file");
  await assert.rejects(reconcilePublic({ projection: input.output, target, write: true }));
  assert.equal(await readFile(path.join(target, "src"), "utf8"), "preserve ignored file");
  await assert.rejects(readFile(path.join(target, "README.md")), /ENOENT/);
  await rm(path.join(target, "src"));
  await writeFile(path.join(target, ".git/info/exclude"), "");
  await reconcilePublic({ projection: input.output, target, write: true });
  assert.deepEqual(await readFile(path.join(target, "README.md")), original);
  await assert.rejects(readFile(path.join(target, "AGENTS.md")), /ENOENT/);
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "public release",
  );
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const repeated = await reconcilePublic({ projection: input.output, target, write: true });
  assert.deepEqual([repeated.added, repeated.changed, repeated.removed], [[], [], []]);
});
test("refuses to overwrite an existing projection or publish the incomplete plugin", async (t) => {
  const input = await fixture(t);
  await assert.rejects(projectPublic({ ...input, preview: false }), /not enabled/);
  await projectPublic(input);
  await assert.rejects(projectPublic(input), /already exist/);
});
test("rejects symlink sources and path traversal in the allowlist", async (t) => {
  const input = await fixture(t);
  await rm(path.join(input.packageRoot, "README.md"));
  await symlink("AGENTS.md", path.join(input.packageRoot, "README.md"));
  await assert.rejects(projectPublic(input), /symbolic links/);
  await writeFile(
    path.join(input.packageRoot, "publication.json"),
    JSON.stringify({
      repository: "https://github.com/pixel-point/siteos-sanity-plugin",
      files: ["../secret"],
    }),
  );
  await assert.rejects(projectPublic(input), /unsafe path/);
});
