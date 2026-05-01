// bughunter inputs <toolId> — show planner-minted inputs for one tool.

import { loadConfig } from '../config.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { apiTestCases } from '../mutation/apply.js';
import { log } from '../log.js';
import type { PaletteVariant } from '../types.js';

type InputsOptions = {
  palette?: PaletteVariant;
  format: 'json';
};

const CANONICAL_PALETTES: ReadonlySet<string> = new Set(['null', 'happy', 'edge', 'out_of_bounds']);

export async function inputsCommand(projectDir: string, toolId: string, opts: InputsOptions): Promise<void> {
  if (opts.palette !== undefined && !CANONICAL_PALETTES.has(opts.palette)) {
    process.stdout.write(
      `Invalid palette: ${opts.palette}. Valid: null|happy|edge|out_of_bounds.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(projectDir);
  const surface = new HttpSurfaceMcpAdapter(config.surfaceMcpUrl);

  let tool;
  try {
    tool = await surface.surface_describe_tool({ toolId });
  } catch {
    process.stdout.write(`Tool not found: ${toolId}\n`);
    process.exitCode = 1;
    return;
  }

  let samples: unknown[];
  try {
    const result = await surface.surface_sample_inputs({ toolId });
    samples = result.samples.map(s => s.input);
  } catch {
    samples = [];
  }

  const role = config.roles?.[0] ?? 'anonymous';
  const bodyFixture = config.bodyFixtures?.[toolId]?.[role] ?? config.bodyFixtures?.[toolId]?.['*'];

  if (tool.inputSchemaConfidence === 'unknown' || tool.inputSchemaConfidence === 'partial') {
    log.warn(`Tool ${toolId} has inputSchemaConfidence='${tool.inputSchemaConfidence}'; schema not fully introspected. Only one happy-palette entry will be returned. Run surface_probe to upgrade.`);
  }

  const testCases = apiTestCases('inputs-cli', role, tool, samples, config.domainHints, bodyFixture);

  let rows = testCases.map(tc => ({ palette: tc.palette, input: tc.action.input }));

  if (opts.palette !== undefined) {
    rows = rows.filter(r => r.palette === opts.palette);
  }

  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}
