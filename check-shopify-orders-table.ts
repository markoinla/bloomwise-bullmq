import 'dotenv/config';
import { db } from './src/config/database';
import { sql } from 'drizzle-orm';

async function checkTable() {
  try {
    const result = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'shopify_orders'
      ORDER BY ordinal_position;
    `);

    const rows = result.rows || result;

    if (!rows || rows.length === 0) {
      console.log('❌ Table shopify_orders does NOT exist');
    } else {
      console.log('✅ Table shopify_orders exists with', rows.length, 'columns:');
      rows.forEach((col: any) => {
        console.log(`  - ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
      });
    }
  } catch (error) {
    console.error('Error:', error);
  }
  process.exit(0);
}

checkTable();
