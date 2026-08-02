import { readFile, writeFile } from "node:fs/promises";

const bump = process.argv[2];
if (!new Set(["patch", "minor", "major"]).has(bump)) {
  throw new Error("Expected a version increment: patch, minor, or major.");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const packageJson = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const manifest = await readJson("manifest.json");
const versions = await readJson("versions.json");

if (packageJson.version !== manifest.version) {
  throw new Error(
    `package.json (${packageJson.version}) and manifest.json (${manifest.version}) do not match.`
  );
}

const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(manifest.version);
if (!match) {
  throw new Error(`Expected a stable semantic version, received '${manifest.version}'.`);
}

let [, major, minor, patch] = match.map(Number);
if (bump === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (bump === "minor") {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}

const version = `${major}.${minor}.${patch}`;
packageJson.version = version;
packageLock.version = version;
packageLock.packages[""].version = version;
manifest.version = version;
versions[version] = manifest.minAppVersion;

await Promise.all([
  writeJson("package.json", packageJson),
  writeJson("package-lock.json", packageLock),
  writeJson("manifest.json", manifest),
  writeJson("versions.json", versions),
]);

console.log(version);
