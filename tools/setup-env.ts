import { open } from "node:fs/promises"

const envPath = new URL("../.env", import.meta.url)

const examplePath = new URL("../.env.example", import.meta.url)

const example = await Bun.file(examplePath).text()

const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")

const contents = example.replace("CURSOR_SECRET=", `CURSOR_SECRET=${secret}`)

try {
  const file = await open(envPath, "wx", 0o600)

  try {
    await file.writeFile(contents)
  } finally {
    await file.close()
  }

  console.log("Created .env with a generated CURSOR_SECRET. Add your GITHUB_TOKEN to .env.")
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error

  console.error(".env already exists; no changes made.")
  process.exitCode = 1
}
