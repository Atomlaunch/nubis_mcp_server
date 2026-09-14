// Export a secret-free, same-origin hosted test image without uploading a dirty checkout.
// Usage: node scripts/prepare-hosted-test.mjs <PMTool checkout> <new output directory>
// Supply only the five public VITE_* values below. No .env files are loaded.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [frontendArg, outputArg] = process.argv.slice(2);
if (!frontendArg || !outputArg)
  throw Error("Provide a frontend checkout and a new export directory");
const frontend = path.resolve(frontendArg),
  output = path.resolve(outputArg);
try {
  await fs.stat(output);
  throw Error("Export directory already exists; use a new path");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const names = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_NUBIS_MCP_BROKER_URL",
  "VITE_NUBIS_OAUTH_BROKER_CLIENT_ID",
  "VITE_NUBIS_UPSTREAM_OAUTH_SCOPE",
];
const define = Object.fromEntries(
  names.map((name) => {
    if (!process.env[name]) throw Error(`Missing ${name}`);
    return [`import.meta.env.${name}`, JSON.stringify(process.env[name])];
  }),
);
await fs.mkdir(output, { recursive: true });
async function copyFile(relative) {
  const source = path.join(root, relative);
  if ((await fs.lstat(source)).isSymbolicLink())
    throw Error("Symlinks are not allowed in exports");
  const target = path.join(output, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}
async function copySource(relative) {
  const entries = await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  await Promise.all(
    entries.map(async (entry) => {
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "dist"].includes(entry.name)
      )
        return;
      const file = path.join(relative, entry.name);
      if (entry.isSymbolicLink())
        throw Error("Source symlinks are not allowed");
      if (entry.isDirectory()) return copySource(file);
      if (entry.name.endsWith(".ts") && !/\.(test|local)\.ts$/.test(entry.name))
        await copyFile(file);
    }),
  );
}
await Promise.all(
  [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "server/package.json",
    "server/package-lock.json",
    "server/tsconfig.json",
  ].map(copyFile),
);
await Promise.all(["src", "server"].map(copySource));
const require = createRequire(path.join(frontend, "package.json"));
const vitePackage = require.resolve("vite/package.json");
const vite = await import(
  pathToFileURL(path.join(path.dirname(vitePackage), "dist/node/index.js")).href
);
// Tailwind resolves its config/content relative to cwd, not Vite's root option.
process.chdir(frontend);
await vite.build({
  root: frontend,
  configFile: path.join(frontend, "vite.config.ts"),
  envDir: false,
  envPrefix: [],
  define,
  build: {
    outDir: path.join(output, "consent-ui"),
    emptyOutDir: false,
    copyPublicDir: false,
  },
});
const dockerfile = await fs.readFile(path.join(root, "Dockerfile"), "utf8");
await fs.writeFile(
  path.join(output, "Dockerfile"),
  dockerfile.replace(
    "USER node",
    "COPY consent-ui ./consent-ui\nENV NUBIS_CONSENT_UI_DIR=/app/consent-ui\nUSER node",
  ),
);
await fs.writeFile(
  path.join(output, ".dockerignore"),
  (await fs.readFile(path.join(root, ".dockerignore"), "utf8")) +
    "\n!consent-ui/\n!consent-ui/**\n**/.*\n",
);
async function manifest(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw Error("Export contains a symlink");
        if (entry.isDirectory()) return manifest(file);
        return [
          {
            file: path.relative(output, file),
            sha256: createHash("sha256")
              .update(await fs.readFile(file))
              .digest("hex"),
          },
        ];
      }),
    )
  ).flat();
}
await fs.writeFile(
  path.join(output, "artifact-manifest.json"),
  JSON.stringify(
    (await manifest(output)).sort((a, b) => a.file.localeCompare(b.file)),
    null,
    2,
  ),
);
console.log(`Secret-free source/consent export prepared: ${output}`);
