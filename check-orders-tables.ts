import 'dotenv/config';
import { db } from './src/config/database';
import { sql } from 'drizzle-orm';

async function checkTables() {
  try {
    // Check for orders-related tables
    const tables = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name LIKE '%order%'
      ORDER BY table_name;
    `);

    const rows = tables.rows || tables;

    console.log('\n📋 Orders-related tables in database:');
    rows.forEach((row: any) => {
      console.log(`  - ${row.table_name}`);
    });

    // Check each table's structure
    for (const row of rows as any[]) {
      const tableName = row.table_name;
      console.log(`\n📊 Table: ${tableName}`);

      const columns = await db.execute(sql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = ${tableName}
        ORDER BY ordinal_position;
      `);

      const colRows = columns.rows || columns;
      colRows.forEach((col: any) => {
        console.log(`  - ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
      });
    }
  } catch (error) {
    console.error('Error:', error);
  }
  process.exit(0);
}

checkTables();
