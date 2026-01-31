#!/usr/bin/env node

/**
 * Check which packages from the monorepo are not yet published to npm.
 * Runs checks in parallel for speed.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONCURRENCY = 20;

async function checkPackageExists(packageName) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}`);
    return response.status === 200;
  } catch {
    return false;
  }
}

function getPackageInfo(packageName) {
  // Find the package.json for this package.
  try {
    const output = execSync(
      `pnpm --filter "${packageName}" list --json --depth 0 2>/dev/null`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    const parsed = JSON.parse(output);
    if (parsed[0]?.path) {
      const pkgJsonPath = join(parsed[0].path, 'package.json');
      if (existsSync(pkgJsonPath)) {
        return JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      }
    }
  } catch {
    // Fallback: search for package.json.
  }
  return null;
}

async function main() {
  console.log('Fetching list of publishable packages...');

  // Get all packages that would be published (--filter-prod excludes private packages).
  const output = execSync(
    'pnpm --filter-prod="./packages/**" --filter-prod="./vendor/**" list --json --depth 0 2>/dev/null',
    { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
  );

  const packagesData = JSON.parse(output).filter((p) => p.name?.startsWith('@dxos/'));

  // Double-check private field by reading package.json directly.
  const packages = [];
  const skippedPrivate = [];

  for (const pkg of packagesData) {
    const pkgJsonPath = join(pkg.path, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      if (pkgJson.private === true) {
        skippedPrivate.push(pkg.name);
        continue;
      }
    }
    packages.push(pkg.name);
  }

  packages.sort();

  if (skippedPrivate.length > 0) {
    console.log(`Skipped ${skippedPrivate.length} private packages.`);
  }

  console.log(`Found ${packages.length} packages to check.\n`);

  // Check packages in parallel batches.
  const results = { published: [], unpublished: [] };
  let checked = 0;

  for (let i = 0; i < packages.length; i += CONCURRENCY) {
    const batch = packages.slice(i, i + CONCURRENCY);
    const checks = batch.map(async (pkg) => {
      const exists = await checkPackageExists(pkg);
      checked++;
      process.stdout.write(`\r[${checked}/${packages.length}] Checking packages...`);
      return { pkg, exists };
    });

    const batchResults = await Promise.all(checks);
    for (const { pkg, exists } of batchResults) {
      if (exists) {
        results.published.push(pkg);
      } else {
        results.unpublished.push(pkg);
      }
    }
  }

  console.log('\n');
  console.log('============================================');
  console.log('RESULTS');
  console.log('============================================\n');

  console.log(`Published packages: ${results.published.length}`);
  console.log(`Unpublished packages: ${results.unpublished.length}\n`);

  if (results.unpublished.length > 0) {
    console.log('============================================');
    console.log('UNPUBLISHED PACKAGES');
    console.log('============================================');
    for (const pkg of results.unpublished) {
      console.log(`  ${pkg}`);
    }

    console.log('\n============================================');
    console.log('COMMANDS TO PUBLISH');
    console.log('============================================\n');

    console.log('# Publish all unpublished packages at once:');
    console.log('pnpm --filter-prod="./packages/**" --filter-prod="./vendor/**" publish --no-git-checks --access public\n');

    console.log('# Or publish individually:');
    for (const pkg of results.unpublished) {
      console.log(`pnpm --filter "${pkg}" publish --no-git-checks --access public`);
    }

    // Save to file.
    const fs = await import('fs');
    fs.writeFileSync('unpublished-packages.txt', results.unpublished.join('\n') + '\n');
    console.log('\n\nSaved list to: unpublished-packages.txt');
  } else {
    console.log('All packages are published!');
  }
}

main().catch(console.error);
