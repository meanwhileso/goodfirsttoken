// Compares two OSV-Scanner JSON reports of pnpm-lock.yaml, one from before a
// pull request and one from after it. Fails when the pull request adds a
// package version with a high or critical advisory, or a known-malicious
// package. No dependencies.
//
//   node scripts/new-advisories.mjs before.json after.json
//
// It names only the package versions the pull request adds, which its diff
// already shows. A vulnerable version already on main is never printed here.
// The weekly scan files it in code scanning, where only maintainers can see it.
import { readFileSync } from 'node:fs';

// CVSS base scores of 7.0 and up are high or critical.
const HIGH_SCORE = 7;
const HIGH_LABELS = new Set(['HIGH', 'CRITICAL']);

function isHighOrWorse(group, vulnerabilities) {
  // OSV lists known-malicious packages under MAL- IDs, often with no score.
  if (group.ids.some((id) => id.startsWith('MAL-'))) return true;
  if (Number.parseFloat(group.max_severity) >= HIGH_SCORE) return true;
  // Some GitHub advisories carry a severity label and no CVSS vector.
  return vulnerabilities.some(
    (vuln) => group.ids.includes(vuln.id) && HIGH_LABELS.has(vuln.database_specific?.severity),
  );
}

// Returns the high or critical advisories in one report, keyed by package
// version and advisory, so a pair that is in both reports counts once.
function highAdvisories(file) {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(report?.results)) {
    throw new Error(`${file} is not an OSV-Scanner JSON report`);
  }
  const found = new Map();
  for (const result of report.results) {
    for (const { package: pkg, groups = [], vulnerabilities = [] } of result.packages ?? []) {
      for (const group of groups) {
        if (!isHighOrWorse(group, vulnerabilities)) continue;
        const ids = [...group.ids].sort();
        const key = `${pkg.ecosystem}:${pkg.name}@${pkg.version} ${ids.join(',')}`;
        found.set(key, { name: pkg.name, version: pkg.version, ids, score: group.max_severity });
      }
    }
  }
  return found;
}

function main([beforeFile, afterFile]) {
  if (!beforeFile || !afterFile) {
    console.error('Usage: node scripts/new-advisories.mjs before.json after.json');
    return 2;
  }
  let added;
  try {
    const before = highAdvisories(beforeFile);
    added = [...highAdvisories(afterFile)].filter(([key]) => !before.has(key)).map(([, advisory]) => advisory);
  } catch (error) {
    console.error(`Could not read the OSV-Scanner reports: ${error.message}`);
    return 2;
  }
  if (added.length === 0) {
    console.log('This pull request adds no packages with high or critical advisories.');
    return 0;
  }
  console.log('This pull request adds packages with high or critical advisories:');
  for (const { name, version, ids, score } of added) {
    console.log(`- ${name}@${version}: ${ids.join(', ')}${score ? ` (CVSS ${score})` : ''}`);
  }
  console.log('Update or remove them. Each advisory is at https://osv.dev/<ID>.');
  return 1;
}

process.exitCode = main(process.argv.slice(2));
