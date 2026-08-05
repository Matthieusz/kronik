import path from "node:path"

const repositoryRoot = path.resolve(import.meta.dir, "..")
const packageDirectory = path.join(repositoryRoot, "node_modules/alchemy")
const outputPath = path.join(packageDirectory, "src/Output.ts")
const patchPath = path.join(repositoryRoot, "patches/alchemy@2.0.0-beta.67.patch")

// Remove this workaround after upgrading to an Alchemy release containing
// https://github.com/alchemy-run/alchemy/pull/1094.
const output = await Bun.file(outputPath).text()
if (output.includes("const alreadySeen = (value: object, seen: WeakSet<object>)")) {
  process.exit(0)
}

const result = Bun.spawnSync(["patch", "--batch", "--forward", "-p1", "--input", patchPath], {
  cwd: packageDirectory,
  stdout: "inherit",
  stderr: "inherit",
})

if (!result.success) {
  throw new Error("Failed to apply the Alchemy #1082 compatibility patch")
}
