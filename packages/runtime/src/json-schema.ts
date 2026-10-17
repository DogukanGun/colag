import { z } from "zod";
/**
 * Converts the catalog's zod field map into a JSON Schema object for
 * OpenAI-style tool definitions. Covers the shapes the catalog uses; anything
 * unknown becomes an unconstrained schema rather than throwing at runtime.
 */
export function fieldsToJsonSchema(
  fields: Record<string, z.ZodTypeAny>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    properties[name] = zodToJsonSchema(field);
    if (!field.isOptional()) required.push(name);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as any;
  const description = schema.description ? { description: schema.description } : {};
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return { type: "string", ...description };
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return { type: "number", ...description };
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean", ...description };
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { type: typeof def.value, enum: [def.value], ...description };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: "string", enum: [...def.values], ...description };
    case z.ZodFirstPartyTypeKind.ZodArray:
      return { type: "array", items: zodToJsonSchema(def.type), ...description };
    case z.ZodFirstPartyTypeKind.ZodObject:
      return { ...fieldsToJsonSchema(def.shape()), ...description };
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return { ...zodToJsonSchema(def.innerType), ...description };
    case z.ZodFirstPartyTypeKind.ZodEffects:
      // refine/superRefine/transform: describe the shape; the service still validates.
      return { ...zodToJsonSchema(def.schema), ...description };
    case z.ZodFirstPartyTypeKind.ZodPipeline:
      return { ...zodToJsonSchema(def.in), ...description };
    default:
      return { ...description };
  }
}
/**
 * Checks a value against the subset of JSON Schema Colag's agent schemas use
 * (type, properties, required, items, enum, minItems, maxItems) and returns
 * readable problems. An empty list means the value fits.
 */
export function schemaProblems(value: unknown, schema: any, at = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const problems: string[] = [];
  const type = schema.type;
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (type) {
    const allowed: string[] = Array.isArray(type) ? type : [type];
    const fits = allowed.some(
      (t) => t === kind || (t === "integer" && Number.isInteger(value)) || (t === "number" && kind === "number"),
    );
    if (!fits) return [`${at} should be ${allowed.join(" or ")}, got ${kind}`];
  }
  if (schema.enum && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value)))
    problems.push(`${at} should be one of ${JSON.stringify(schema.enum)}`);
  if (kind === "array") {
    const list = value as unknown[];
    if (schema.minItems !== undefined && list.length < schema.minItems)
      problems.push(`${at} needs at least ${schema.minItems} items, got ${list.length}`);
    if (schema.maxItems !== undefined && list.length > schema.maxItems)
      problems.push(`${at} allows at most ${schema.maxItems} items, got ${list.length}`);
    if (schema.items) list.forEach((v, i) => problems.push(...schemaProblems(v, schema.items, `${at}[${i}]`)));
  }
  if (kind === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required || [])
      if (!(key in obj)) problems.push(`${at}.${key} is missing`);
    for (const [key, sub] of Object.entries(schema.properties || {}))
      if (key in obj) problems.push(...schemaProblems(obj[key], sub, `${at}.${key}`));
  }
  return problems;
}
