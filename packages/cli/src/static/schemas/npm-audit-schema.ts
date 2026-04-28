// Zod schema for `npm audit --json` output.

import { z } from 'zod';

const NpmAuditVulnerabilitySchema = z.object({
  name: z.string(),
  severity: z.string(),
  isDirect: z.boolean().optional(),
  via: z.array(z.unknown()),
  range: z.string().optional(),
  fixAvailable: z.union([z.boolean(), z.object({ name: z.string(), version: z.string() })]).optional(),
  nodes: z.array(z.string()).optional(),
});

const NpmAuditAdvisorySchema = z.object({
  source: z.number().optional(),
  name: z.string().optional(),
  dependency: z.string().optional(),
  title: z.string(),
  url: z.string().optional(),
  severity: z.string(),
  range: z.string().optional(),
  cvss: z.object({ score: z.number().optional() }).optional(),
  cwe: z.array(z.string()).optional(),
  id: z.number().optional(),
  module_name: z.string().optional(),
  vulnerable_versions: z.string().optional(),
  patched_versions: z.string().optional(),
  overview: z.string().optional(),
  recommendation: z.string().optional(),
  via: z.array(z.unknown()).optional(),
  nodes: z.array(z.string()).optional(),
  fixAvailable: z.union([z.boolean(), z.object({ name: z.string(), version: z.string() })]).optional(),
});

export const NpmAuditOutputSchema = z.object({
  auditReportVersion: z.number().optional(),
  vulnerabilities: z.record(z.string(), NpmAuditVulnerabilitySchema).optional(),
  advisories: z.record(z.string(), NpmAuditAdvisorySchema).optional(),
  metadata: z.object({
    vulnerabilities: z.object({
      high: z.number().optional(),
      critical: z.number().optional(),
    }).optional(),
  }).optional(),
});

export type NpmAuditAdvisory = z.infer<typeof NpmAuditAdvisorySchema>;
export type NpmAuditVulnerability = z.infer<typeof NpmAuditVulnerabilitySchema>;
export type NpmAuditOutput = z.infer<typeof NpmAuditOutputSchema>;
