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
