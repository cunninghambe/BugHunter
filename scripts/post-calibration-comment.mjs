#!/usr/bin/env node
// CI helper: format a markdown PR comment from the aggregate calibration report.
// Usage (GitHub Actions github-script): require('./scripts/post-calibration-comment.mjs')(github, context, '/tmp/aggregate.json')

import * as fs from 'node:fs';

export default async function postCalibrationComment(github, context, aggregatePath) {
  if (!fs.existsSync(aggregatePath)) {
    process.stderr.write(`Aggregate report not found: ${aggregatePath}\n`);
    return;
  }

  const agg = JSON.parse(fs.readFileSync(aggregatePath, 'utf-8'));
  const { overall, perKind, thresholdViolations, appsIncluded, generatedAt } = agg;

  const statusIcon = thresholdViolations.length === 0 ? '✅' : '❌';
  const headerLine = `${statusIcon} **BugHunter Calibration** | ${appsIncluded?.join(', ')} | ${generatedAt?.slice(0, 10)}`;

  const overallLine =
    `**Overall**: tp=${overall.tp} fp=${overall.fp} fn=${overall.fn} ` +
    `precision=${overall.precision} recall=${overall.recall} f1=${overall.f1}`;

  const tableRows = Object.entries(perKind ?? {})
    .filter(([, v]) => v.tp + v.fp + v.fn + v.tn > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, v]) => {
      const status = v.registryStatus === 'deferred' ? '⏭ deferred' :
        (v.passes === false ? '❌' : v.lowConfidence ? '⚠ low-confidence' : '✅');
      return `| ${kind} | ${v.precision} | ${v.recall} | ${v.f1} | ${status} |`;
    });

  const table =
    '| BugKind | Precision | Recall | F1 | Status |\n' +
    '|---------|-----------|--------|----|--------|\n' +
    tableRows.join('\n');

  const violationsSection = thresholdViolations.length > 0
    ? `\n**Threshold violations:** ${thresholdViolations.join(', ')}`
    : '';

  const body =
    `${headerLine}\n\n${overallLine}\n\n${table}${violationsSection}\n`;

  const { data: comments } = await github.rest.issues.listComments({
    ...context.repo,
    issue_number: context.issue.number,
  });

  const existing = comments.find(c => c.body?.includes('BugHunter Calibration'));
  if (existing) {
    await github.rest.issues.updateComment({
      ...context.repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      ...context.repo,
      issue_number: context.issue.number,
      body,
    });
  }
}
