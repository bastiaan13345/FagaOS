#!/usr/bin/env node
/**
 * Build the JSON Schema for the AgentCard from the Zod schema.
 * Run with `tsx scripts/build-schema.ts` (or the package's `build:schema` script).
 *
 * Output: src/agent-card.schema.json
 *
 * Hand-rolled Zod -> JSON Schema converter. We deliberately do NOT
 * pull in zod-to-json-schema to keep the dependency surface small
 * for Phase 0. Targets the Zod 3.25 internal _def layout.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentCardSchema } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type ZodNode = { _def: { typeName: string; [k: string]: unknown } };

function getDef(s: ZodNode): Record<string, unknown> {
  return s._def as unknown as Record<string, unknown>;
}

function isOptional(s: ZodNode): boolean {
  const t = getDef(s).typeName;
  return t === 'ZodOptional' || t === 'ZodNullable' || t === 'ZodDefault';
}

function zodToJsonSchema(schema: ZodNode): Record<string, unknown> {
  const def = getDef(schema);
  const typeName = def.typeName as string;
  const out: Record<string, unknown> = {};
  if (typeof def.description === 'string') out['description'] = def.description;
  switch (typeName) {
    case 'ZodString':
      out['type'] = 'string';
      break;
    case 'ZodNumber':
      out['type'] = 'number';
      break;
    case 'ZodBoolean':
      out['type'] = 'boolean';
      break;
    case 'ZodLiteral':
      out['type'] = typeof def.value;
      out['const'] = def.value;
      break;
    case 'ZodEnum':
      out['type'] = 'string';
      out['enum'] = def.values;
      break;
    case 'ZodArray': {
      out['type'] = 'array';
      const element = def.type as ZodNode;
      out['items'] = zodToJsonSchema(element);
      break;
    }
    case 'ZodObject': {
      out['type'] = 'object';
      const shapeFn = def.shape as () => Record<string, ZodNode>;
      const props: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shapeFn())) {
        props[k] = zodToJsonSchema(v);
        if (!isOptional(v)) required.push(k);
      }
      out['properties'] = props;
      if (required.length) out['required'] = required;
      out['additionalProperties'] = false;
      break;
    }
    case 'ZodRecord': {
      out['type'] = 'object';
      const valueType = def.valueType as ZodNode;
      out['additionalProperties'] = zodToJsonSchema(valueType);
      break;
    }
    case 'ZodUnion': {
      out['oneOf'] = (def.options as ZodNode[]).map((o) => zodToJsonSchema(o));
      break;
    }
    case 'ZodDiscriminatedUnion': {
      out['oneOf'] = (def.options as ZodNode[]).map((o) => zodToJsonSchema(o));
      out['discriminator'] = { propertyName: def.discriminator as string };
      break;
    }
    case 'ZodDefault': {
      const inner = zodToJsonSchema(def.innerType as ZodNode);
      return { ...inner, default: (def.defaultValue as () => unknown)() };
    }
    case 'ZodOptional':
    case 'ZodNullable':
      return zodToJsonSchema(def.innerType as ZodNode);
    default:
      out['type'] = 'unknown';
  }
  return out;
}

const schema = {
  $id: 'https://fagaos.dev/schemas/agent-card/v1.json',
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'FagaOS AgentCard',
  description:
    'Runtime contract for declaring an agent\'s identity, capabilities, MCP endpoints, auth requirements, owner, and version. Phase 0 contract (FAG-9, unified into FAG-8 monorepo in FAG-10).',
  ...zodToJsonSchema(AgentCardSchema as unknown as ZodNode),
};

const out = resolve(__dirname, '../src/agent-card.schema.json');
writeFileSync(out, JSON.stringify(schema, null, 2) + '\n', 'utf8');
process.stdout.write(`wrote ${out}\n`);
