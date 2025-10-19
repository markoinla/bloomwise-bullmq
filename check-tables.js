import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

try {
  // Check if products table exists
  const productsTable = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'products'
    ORDER BY ordinal_position
  `;

  console.log('\n=== PRODUCTS TABLE ===');
  if (productsTable.length > 0) {
    console.log('✅ Table exists');
    console.log('Columns:', productsTable.map(c => c.column_name).join(', '));
  } else {
    console.log('❌ Table does not exist');
  }

  // Check if product_variants table exists
  const variantsTable = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'product_variants'
    ORDER BY ordinal_position
  `;

  console.log('\n=== PRODUCT_VARIANTS TABLE ===');
  if (variantsTable.length > 0) {
    console.log('✅ Table exists');
    console.log('Columns:', variantsTable.map(c => c.column_name).join(', '));
  } else {
    console.log('❌ Table does not exist');
  }

} catch (error) {
  console.error('Error:', error.message);
}

process.exit(0);
