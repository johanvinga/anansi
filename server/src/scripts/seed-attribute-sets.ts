import "dotenv/config";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { nameKeyOf } from "../lib/text.js";
import { addField, createAttributeSet, type CreateFieldInput } from "../services/attribute-set.service.js";

/**
 * Creates the example attribute sets from SPEC §4.5. Sets that already exist are skipped.
 * Usage: npm run seed:attribute-sets
 */
/** Example data is English only; the French value defaults to the English one (FR-I18N-02). */
type SeedField = Omit<CreateFieldInput, "name" | "options"> & { name: string; options?: string[] };

const both = (value: string) => ({ en: value, fr: value });

function toFieldInput(field: SeedField): CreateFieldInput {
  return { ...field, name: both(field.name), options: field.options?.map(both) };
}

const EXAMPLES: { name: string; fields: SeedField[] }[] = [
  {
    name: "MDF Panel",
    fields: [
      { name: "Width", dataType: "number", unit: "mm", isRequired: true },
      { name: "Length", dataType: "number", unit: "mm", isRequired: true },
      { name: "Thickness", dataType: "number", unit: "mm", isRequired: true },
    ],
  },
  {
    name: "Paint",
    fields: [
      { name: "Color", dataType: "text", isRequired: true },
      { name: "Texture", dataType: "select", options: ["matte", "satin", "gloss"] },
      { name: "Finish", dataType: "text" },
    ],
  },
];

const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const context = {
  requestId: `seed-${randomUUID()}`,
  ipAddress: null,
  actor: { userId: null, email: "system:seed-attribute-sets" },
};

try {
  for (const example of EXAMPLES) {
    if (await db.attributeSet.findUnique({ where: { nameKey: nameKeyOf(example.name) } })) {
      console.log(`Skipped "${example.name}" (already exists).`);
      continue;
    }
    const set = await createAttributeSet(db, context, both(example.name));
    for (const field of example.fields) {
      await addField(db, context, set.id, toFieldInput(field));
    }
    console.log(`Created "${example.name}" with ${example.fields.length} fields.`);
  }
} finally {
  await db.$disconnect();
}
