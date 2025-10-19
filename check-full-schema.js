import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

try {
  // Get full schema for products table
  const columns = await sql`
    SELECT
      column_name,
      data_type,
      udt_name,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_name = 'products'
    ORDER BY ordinal_position
  `;

  console.log('\n=== PRODUCTS TABLE FULL SCHEMA ===\n');
  columns.forEach(col => {
    console.log(`${col.column_name}:`);
    console.log(`  Type: ${col.data_type} (${col.udt_name})`);
    console.log(`  Nullable: ${col.is_nullable}`);
    console.log(`  Default: ${col.column_default || 'none'}`);
    console.log('');
  });

  // Check if there are any constraints
  const constraints = await sql`
    SELECT
      tc.constraint_name,
      tc.constraint_type,
      kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_name = 'products'
    ORDER BY tc.constraint_type, kcu.column_name
  `;

  console.log('\n=== CONSTRAINTS ===\n');
  console.table(constraints);

  // Check for unique indexes
  const indexes = await sql`
    SELECT
      indexname,
      indexdef
    FROM pg_indexes
    WHERE tablename = 'products'
  `;

  console.log('\n=== INDEXES ===\n');
  indexes.forEach(idx => {
    console.log(`${idx.indexname}:`);
    console.log(`  ${idx.indexdef}`);
    console.log('');
  });

} catch (error) {
  console.error('Error:', error.message);
}

process.exit(0);
