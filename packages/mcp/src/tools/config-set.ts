// bughunt_config_set — programmatic patch to .bughunter/config.json with Zod re-validation.
// No CLI parity yet (bughunter init is one-shot).

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { withLock, atomicWriteJson } from './locks.js';
import { resolveProjectDir } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';
import { ConfigSchema } from 'bughunter/src/config.js';

const ConfigSetInput = z.object({
  project: z.string().min(1),
  key: z.string().min(1),
  value: z.unknown(),
});

type PathSegment = string | number;

/**
 * Apply a dot-path patch to a plain object/array clone.
 * Numeric segments are coerced to array indices when the parent is an array.
 * Rejects traversal through non-object/non-array values.
 */
function setByPath(root: unknown, dotPath: string, value: unknown): unknown {
  const segments: PathSegment[] = dotPath.split('.').map(s => {
    const n = Number(s);
    return Number.isInteger(n) && s !== '' ? n : s;
  });

  function recurse(node: unknown, depth: number): unknown {
    const seg = segments[depth];
    if (depth === segments.length - 1) {
      if (typeof seg === 'number') {
        const base = Array.isArray(node) ? (node as unknown[]) : [];
        const arr: unknown[] = [...base];
        arr[seg] = value;
        return arr;
      }
      const obj: Record<string, unknown> = (node !== null && typeof node === 'object' && !Array.isArray(node))
        ? { ...(node as Record<string, unknown>) }
        : {};
      obj[seg as string] = value;
      return obj;
    }

    if (typeof seg === 'number') {
      if (!Array.isArray(node)) throw new Error(`Cannot index into non-array at segment ${seg}`);
      const arr: unknown[] = [...(node as unknown[])];
      arr[seg] = recurse(arr[seg], depth + 1);
      return arr;
    }

    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(`Cannot traverse through non-object at segment '${seg}'`);
    }
    const obj = { ...(node as Record<string, unknown>) };
    obj[seg] = recurse(obj[seg], depth + 1);
    return obj;
  }

  return recurse(root, 0);
}

export function registerConfigSetTool(server: McpServer): void {
  server.tool(
    'bughunt_config_set',
    'Programmatic edit to .bughunter/config.json with Zod re-validation. Dot-path key supports nested fields and array indices (e.g. "auth.successCheck.kind", "roles.0"). Never writes a config that fails validation.',
    ConfigSetInput.shape,
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.project);
        const configPath = path.join(projectDir, '.bughunter', 'config.json');
        const lockDir = path.join(projectDir, '.bughunter', '.config.lock');

        if (!fs.existsSync(configPath)) {
          return toolErr('error', `config.json not found in ${projectDir}; run bughunter init first`);
        }

        return await withLock(lockDir, 5000, () => {
          const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
          let patched: unknown;
          try {
            patched = setByPath(raw, args.key, args.value);
          } catch (e) {
            return toolErr('invalid_input', `Cannot apply patch: ${String(e)}`);
          }

          const result = ConfigSchema.safeParse(patched);
          if (!result.success) {
            const errors = result.error.errors.map(err => ({
              path: err.path as (string | number)[],
              message: err.message,
            }));
            return toolOk({ ok: false, validated: false, errors });
          }

          atomicWriteJson(configPath, result.data);
          return toolOk({ ok: true, validated: true });
        });
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_input', e.message);
        if (e instanceof Error && e.message === 'lock_timeout') return toolErr('concurrent_write', 'Lock acquisition timed out; retry in a moment');
        return toolErr('error', String(e));
      }
    },
  );
}
