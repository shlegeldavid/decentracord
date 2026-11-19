import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const e2eDirectory = join(projectRoot, "tests/e2e");
const fixtureRunner = join(e2eDirectory, "fixtures.ts");

const defaultGroups = [
  [
    "channel-access.spec.ts",
    "channel-visibility.spec.ts",
    "channel-categories.spec.ts",
    "installation-privacy.spec.ts",
    "organization-members.spec.ts",
    "organization-logo.spec.ts",
    "read-retention.spec.ts"
  ],
  ["bootstrap-login.spec.ts", "messaging.spec.ts", "readers.spec.ts", "pinned-messages.spec.ts", "message-forward.spec.ts", "people-search.spec.ts", "personal-messages.spec.ts"],
  ["accessibility.spec.ts", "member-access.spec.ts", "role-management.spec.ts", "tls-session.spec.ts", "password-logout.spec.ts"]
].map((group) => group.map((spec) => `tests/e2e/${spec}`));

const discoveredSpecs = readdirSync(e2eDirectory)
  .filter((file) => file.endsWith(".spec.ts"))
  .map((file) => `tests/e2e/${file}`);
const assignedSpecs = defaultGroups.flat();
const assignedCounts = new Map();
for (const spec of assignedSpecs) {
  assignedCounts.set(spec, (assignedCounts.get(spec) ?? 0) + 1);
}
const unassignedSpecs = discoveredSpecs.filter((spec) => !assignedCounts.has(spec));
const missingSpecs = [...new Set(assignedSpecs.filter((spec) => !discoveredSpecs.includes(spec)))];
const duplicateSpecs = [...assignedCounts.entries()]
  .filter(([, count]) => count !== 1)
  .map(([spec]) => spec);
if (unassignedSpecs.length > 0 || missingSpecs.length > 0 || duplicateSpecs.length > 0) {
  throw new Error(
    `E2E runner groups must include every spec exactly once. Unassigned: ${unassignedSpecs.join(", ") || "none"}; missing: ${missingSpecs.join(", ") || "none"}; duplicate: ${duplicateSpecs.join(", ") || "none"}`
  );
}

const requestedSpecs = process.argv.slice(2);
const groups = requestedSpecs.length > 0 ? [requestedSpecs] : defaultGroups;
for (const [index, specs] of groups.entries()) {
  process.stdout.write(`Running isolated E2E group ${index + 1}/${groups.length}: ${specs.join(", ")}\n`);
  const result = spawnSync(process.execPath, ["--import", "tsx", fixtureRunner, ...specs], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
