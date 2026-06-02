import type { Knex } from 'knex';

/**
 * Migration: Add is_publishable to pages
 *
 * Mirrors collection_items.is_publishable. The flag lives on the draft row
 * (is_published = false) and controls whether a page goes live: false = draft
 * (skipped/removed on publish), true = staged or published. Defaults to true so
 * existing pages keep publishing as before.
 */

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('pages', 'is_publishable');
  if (!hasColumn) {
    await knex.schema.alterTable('pages', (table) => {
      table.boolean('is_publishable').notNullable().defaultTo(true);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('pages', 'is_publishable');
  if (hasColumn) {
    await knex.schema.alterTable('pages', (table) => {
      table.dropColumn('is_publishable');
    });
  }
}
